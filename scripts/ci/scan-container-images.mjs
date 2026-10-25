import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertStudioServerReleaseManifest } from '../../deploy/studio-server/scripts/lib/studio-server-release-manifest.mjs';

export const nginxImage = 'nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951';
export const scannerImage =
  'ghcr.io/aquasecurity/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c';
export const runtimeNodeImage =
  'node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53';
export const esbuildCompilerImage =
  'golang:1.27.3-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c';
export const imagePlatforms = Object.freeze({
  proxy: ['linux/amd64', 'linux/arm64'],
  web: ['linux/amd64', 'linux/arm64'],
  api: ['linux/amd64'],
  executor: ['linux/amd64'],
});
const root = fileURLToPath(new URL('../../', import.meta.url));
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const immutableImage = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const severities = new Set(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

export function candidateScanTargets(input, service, expectedSha) {
  assert.ok(Object.hasOwn(imagePlatforms, service), 'Unknown runtime image component');
  const manifest = assertStudioServerReleaseManifest(input);
  assert.equal(manifest.state, 'candidate', 'Scan the candidate before promotion');
  assert.match(expectedSha, /^[a-f0-9]{40}$/, 'Expected source SHA is required');
  assert.equal(manifest.source.sha, expectedSha, 'Candidate source differs from this workflow');
  const image = `${manifest.images[service].repository}@${manifest.images[service].digest}`;
  assert.match(image, immutableImage, 'Immutable image reference is required');
  return imagePlatforms[service].map((platform) => ({ image, platform }));
}

/** Keep vulnerability/package evidence, not image ENV/history that may contain
 * build-time credentials. Only this sanitized report is a CI upload target. */
export function sanitizeContainerReport(report) {
  const metadata = report.Metadata ?? {};
  return {
    SchemaVersion: report.SchemaVersion,
    CreatedAt: report.CreatedAt,
    ArtifactName: report.ArtifactName,
    ArtifactType: report.ArtifactType,
    Metadata: {
      OS: metadata.OS,
      ImageID: metadata.ImageID,
      RepoDigests: metadata.RepoDigests,
      ImageConfig: { architecture: metadata.ImageConfig?.architecture, os: metadata.ImageConfig?.os },
    },
    Results: report.Results,
  };
}

/** A successful scanner process is not sufficient: reject empty, unsupported,
 * wrong-image/architecture and stale-database reports before considering CVEs. */
export function assessContainerReport(report, { platform, image, database, now = Date.now() }) {
  assert.equal(report.SchemaVersion, 2, 'Unsupported scanner report');
  assert.equal(report.ArtifactType, 'container_image', 'Expected container-image analysis');
  assert.match(report.Metadata?.ImageID ?? '', digestPattern, 'Missing analyzed image identity');
  assert.equal(report.Metadata?.ImageConfig?.os, 'linux', 'Wrong image OS');
  assert.equal(report.Metadata?.ImageConfig?.architecture, platform.split('/')[1], 'Wrong image architecture');
  if (image) assert.equal(report.ArtifactName, image, 'Scanner analyzed a different image');
  assert.ok(report.Metadata?.OS?.Family && report.Metadata.OS.Name, 'OS was not detected');
  assert.equal(report.Metadata.OS.Family, 'alpine', 'Unsupported runtime base OS: review the scan policy');
  assert.notEqual(report.Metadata.OS.Eosl, true, 'End-of-life base OS blocks promotion');
  const updated = Date.parse(database?.UpdatedAt);
  assert.ok(
    Number.isFinite(updated) && updated <= now + 300000 && now - updated <= 48 * 3600000,
    'Vulnerability database is missing, stale or future-dated',
  );
  assert.equal(database.Version, 2, 'Unsupported vulnerability database');
  assert.ok(Array.isArray(report.Results), 'Missing analysis results');
  assert.ok(
    report.Results.some((result) => result.Class === 'os-pkgs' && result.Packages?.length > 0),
    'OS package inventory is empty',
  );
  const findings = [];
  for (const result of report.Results) {
    assert.ok(['os-pkgs', 'lang-pkgs'].includes(result.Class), 'Unexpected scanner result class');
    assert.ok(Array.isArray(result.Packages), 'Missing or malformed package inventory');
    for (const pkg of result.Packages) {
      assert.ok(nonEmptyString(pkg?.Name), 'Malformed package inventory entry');
      // Go main modules built from source legitimately omit Version. OS package
      // versions and every supplied language-package version must still be real.
      if (result.Class === 'os-pkgs' || pkg.Version !== undefined)
        assert.ok(nonEmptyString(pkg.Version), 'Malformed package inventory version');
    }
    assert.ok(
      result.Vulnerabilities == null || Array.isArray(result.Vulnerabilities),
      'Malformed vulnerability results',
    );
    for (const vulnerability of result.Vulnerabilities ?? []) {
      assert.ok(
        severities.has(vulnerability.Severity) &&
          nonEmptyString(vulnerability.VulnerabilityID) &&
          nonEmptyString(vulnerability.PkgName) &&
          nonEmptyString(vulnerability.InstalledVersion),
        'Malformed vulnerability finding',
      );
      findings.push({
        target: result.Target,
        id: vulnerability.VulnerabilityID,
        package: vulnerability.PkgName,
        installed: vulnerability.InstalledVersion,
        fixed: vulnerability.FixedVersion ?? null,
        severity: vulnerability.Severity,
      });
    }
  }
  return {
    imageId: report.Metadata.ImageID,
    platform,
    database,
    findings,
    blockers: findings.filter((finding) => ['HIGH', 'CRITICAL'].includes(finding.severity)),
  };
}

export function scannerArguments({ output, cache, platform, image, archive, owner }) {
  assert.ok(['linux/amd64', 'linux/arm64'].includes(platform), 'Unsupported image platform');
  assert.ok(Boolean(image) !== Boolean(archive), 'Choose exactly one immutable image or local image archive');
  if (image) assert.match(image, immutableImage, 'Mutable image references are not accepted');
  return [
    'run',
    '--rm',
    '--name',
    `rivet-security-${owner}`,
    '--label',
    `io.rivet.security-owner=${owner}`,
    '--cidfile',
    path.join(output, 'scanner.cid'),
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--mount',
    `type=bind,source=${path.join(output, 'scratch')},target=/tmp`,
    '--mount',
    `type=bind,source=${output},target=/reports`,
    '--mount',
    `type=bind,source=${cache},target=/cache`,
    '--mount',
    `type=bind,source=${path.join(output, 'config')},target=/scan-config,readonly`,
    ...(archive ? ['--mount', `type=bind,source=${archive},target=/input/image.tar,readonly`] : []),
    ...['TRIVY_USERNAME', 'TRIVY_PASSWORD', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']
      .filter((key) => process.env[key])
      .flatMap((key) => ['--env', key]),
    scannerImage,
    'image',
    '--config',
    '/scan-config/trivy.yaml',
    '--ignorefile',
    '/scan-config/empty.ignore',
    '--cache-dir',
    '/cache',
    '--timeout',
    '10m',
    '--no-progress',
    '--scanners',
    'vuln',
    '--severity',
    [...severities].join(','),
    '--ignore-unfixed=false',
    '--exit-code',
    '0',
    '--format',
    'json',
    '--list-all-pkgs',
    '--output',
    '/reports/trivy.raw.json',
    '--platform',
    platform,
    ...(archive ? ['--input', '/input/image.tar'] : ['--image-src', 'remote', image]),
  ];
}

async function scan(target, output, cache) {
  await fs.mkdir(output); // Never reuse an earlier report after a failed scan.
  await fs.mkdir(path.join(output, 'config'));
  await fs.mkdir(path.join(output, 'scratch'));
  await fs.writeFile(path.join(output, 'config/trivy.yaml'), '{}\n', { flag: 'wx' });
  await fs.writeFile(path.join(output, 'config/empty.ignore'), '', { flag: 'wx' });
  const owner = randomUUID();
  const command = (args, options = {}) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: 720000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
  let archiveSha256;
  if (target.archive) {
    assert.ok((await fs.stat(target.archive)).isFile(), 'Input must be a regular docker-save archive');
    archiveSha256 = await hashArchive(target.archive);
  }
  try {
    command(scannerArguments({ ...target, output, cache, owner }), { stdio: 'inherit' });
  } finally {
    // A timed-out Docker client must not strand its scanner. Only our exact
    // cidfile + ownership label authorizes removal; never discover by prefix.
    const cid = await fs.readFile(path.join(output, 'scanner.cid'), 'utf8').catch((e) => {
      if (e.code !== 'ENOENT') throw e;
      return '';
    });
    if (cid.trim()) {
      assert.match(cid.trim(), /^[a-f0-9]{64}$/, 'Invalid scanner container identity');
      const inspect = (() => {
        try {
          return JSON.parse(command(['inspect', cid.trim()]));
        } catch (error) {
          if (/No such (object|container)/i.test(String(error.stderr))) return [];
          throw error;
        }
      })();
      if (inspect.length) {
        assert.equal(inspect[0].Config.Labels['io.rivet.security-owner'], owner, 'Scanner ownership changed');
        command(['rm', '-f', cid.trim()]);
      }
    }
  }
  const report = sanitizeContainerReport(JSON.parse(await fs.readFile(path.join(output, 'trivy.raw.json'), 'utf8')));
  await fs.writeFile(path.join(output, 'trivy.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  if (target.archive) assert.equal(await hashArchive(target.archive), archiveSha256, 'Archive changed during scan');
  const database = JSON.parse(await fs.readFile(path.join(cache, 'db/metadata.json'), 'utf8'));
  const result = assessContainerReport(report, { ...target, database });
  await fs.writeFile(
    path.join(output, 'assessment.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        scannedAt: new Date().toISOString(),
        scannerImage,
        ...(archiveSha256 ? { archiveSha256 } : { image: target.image }),
        ...result,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  console.log(`${target.platform}: ${result.blockers.length} High/Critical findings, ${result.findings.length} total`);
  return result;
}

async function hashArchive(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ['manifest', 'service', 'source-sha', 'image', 'archive', 'platform', 'output', 'cache'].map((key) => [
        key,
        { type: 'string' },
      ]),
    ),
  });
  assert.ok(values.output, '--output is required');
  const output = path.resolve(values.output);
  const relative = path.relative(path.join(root, 'artifacts'), output);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Output must be beneath artifacts/');
  const cache = path.resolve(values.cache ?? path.join(root, 'artifacts/container-security-cache'));
  let targets;
  if (values.manifest) {
    assert.ok(!values.image && !values.archive && !values.platform, 'Manifest mode determines image and platforms');
    targets = candidateScanTargets(
      JSON.parse(await fs.readFile(values.manifest, 'utf8')),
      values.service,
      values['source-sha'] ?? process.env.GITHUB_SHA,
    );
  } else {
    assert.ok(!values.service && !values['source-sha'], 'Service/source SHA require a candidate manifest');
    targets = [
      { image: values.image, archive: values.archive && path.resolve(values.archive), platform: values.platform },
    ];
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  await fs.mkdir(cache, { recursive: true });
  const failures = [];
  for (const target of targets) {
    try {
      const result = await scan(target, path.join(output, target.platform?.replace('/', '-') ?? 'invalid'), cache);
      if (result.blockers.length)
        failures.push(`${target.platform}: ${result.blockers.length} blocking vulnerabilities`);
    } catch (error) {
      failures.push(`${target.platform}: scan failed: ${error.message}`);
    }
  }
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ passed: failures.length === 0, failures }, null, 2),
    { flag: 'wx' },
  );
  if (failures.length) throw new Error(failures.join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[container-security] ${error.message}`);
    process.exitCode = 1;
  });
}

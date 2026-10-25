// test-style: fixture-read: reads only test-owned scanner failure receipts, not implementation source.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessContainerReport,
  candidateScanTargets,
  imagePlatforms,
  scannerArguments,
  scannerImage,
  sanitizeContainerReport,
} from './scan-container-images.mjs';
import { createStudioServerReleaseManifest } from '../../deploy/studio-server/scripts/lib/studio-server-release-manifest.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const image = `example.test/proxy@sha256:${'a'.repeat(64)}`;
const now = Date.parse('2026-10-25T12:00:00Z');
const database = { Version: 2, UpdatedAt: '2026-10-25T07:00:00Z' };
const options = { image, platform: 'linux/amd64', database, now };
const report = () => ({
  SchemaVersion: 2,
  ArtifactType: 'container_image',
  ArtifactName: image,
  Metadata: {
    ImageID: `sha256:${'b'.repeat(64)}`,
    OS: { Family: 'alpine', Name: '3.24.3' },
    ImageConfig: { os: 'linux', architecture: 'amd64' },
  },
  Results: [{ Class: 'os-pkgs', Type: 'alpine', Target: image, Packages: [{ Name: 'nginx', Version: '1.30.6' }] }],
});

test('one policy covers clean, fixed/unfixed OS and library findings without hiding lower severities', () => {
  const confidential = report();
  confidential.Metadata.ImageConfig.config = { Env: ['SECRET=fixture-sensitive'] };
  confidential.Metadata.ImageConfig.history = [{ created_by: 'fixture-sensitive' }];
  const sanitized = sanitizeContainerReport(confidential);
  assert.ok(!JSON.stringify(sanitized).includes('fixture-sensitive'));
  assert.equal(assessContainerReport(sanitized, options).blockers.length, 0);
  assert.equal(assessContainerReport(report(), options).blockers.length, 0);
  const builtFromSource = report();
  builtFromSource.Results.push({ Class: 'lang-pkgs', Type: 'gobinary', Packages: [{ Name: 'example.test/tool' }] });
  assert.equal(assessContainerReport(builtFromSource, options).blockers.length, 0);
  for (const kind of ['os-pkgs', 'lang-pkgs']) {
    const input = report();
    input.Results.push({
      Class: kind,
      Target: 'fixture',
      Packages: [{ Name: 'fixture', Version: '1' }],
      Vulnerabilities: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((Severity, index) => ({
        VulnerabilityID: `CVE-fixture-${index}`,
        PkgName: 'fixture',
        Severity,
        InstalledVersion: '1',
        ...(index % 2 ? { FixedVersion: '2' } : {}),
      })),
    });
    const result = assessContainerReport(input, options);
    assert.equal(result.findings.length, 4);
    assert.deepEqual(
      result.blockers.map((finding) => finding.severity),
      ['HIGH', 'CRITICAL'],
    );
    assert.equal(result.blockers[0].fixed, null, 'Unfixed High findings must also block');
  }
});

test('missing inventory, wrong identity/architecture, EOL, malformed and stale reports cannot pass', () => {
  const invalid = [
    (r) => {
      r.SchemaVersion = 1;
    },
    (r) => {
      r.ArtifactType = 'filesystem';
    },
    (r) => {
      r.ArtifactName = 'another-image';
    },
    (r) => {
      delete r.Metadata.ImageID;
    },
    (r) => {
      r.Metadata.ImageConfig.architecture = 'arm64';
    },
    (r) => {
      r.Metadata.ImageConfig.os = 'windows';
    },
    (r) => {
      delete r.Metadata.OS;
    },
    (r) => {
      r.Metadata.OS.Family = 'unsupported';
    },
    (r) => {
      r.Metadata.OS.Eosl = true;
    },
    (r) => {
      r.Results = [];
    },
    (r) => {
      delete r.Results[0].Packages;
    },
    (r) => {
      r.Results[0].Packages = 'not-an-inventory';
    },
    (r) => {
      r.Results[0].Packages = [{}];
    },
    (r) => {
      r.Results[0].Packages[0].Version = 123;
    },
    (r) => {
      r.Results.push({ Class: 'lang-pkgs', Packages: [{ Name: 'fixture', Version: '' }] });
    },
    (r) => {
      r.Results.push({ Class: 'lang-pkgs', Packages: 'not-an-inventory' });
    },
    (r) => {
      r.Results[0].Vulnerabilities = {};
    },
    (r) => {
      r.Results[0].Vulnerabilities = [{ Severity: 'NONE' }];
    },
    (r) => {
      r.Results[0].Vulnerabilities = [{ Severity: 'LOW', VulnerabilityID: 123, PkgName: 123 }];
    },
  ];
  for (const mutate of invalid) {
    const r = report();
    mutate(r);
    assert.throws(() => assessContainerReport(r, options));
  }
  for (const field of ['VulnerabilityID', 'PkgName', 'InstalledVersion']) {
    for (const value of [undefined, '', 123]) {
      const r = report();
      const finding = { VulnerabilityID: 'CVE-fixture', PkgName: 'fixture', InstalledVersion: '1', Severity: 'HIGH' };
      finding[field] = value;
      r.Results[0].Vulnerabilities = [finding];
      assert.throws(() => assessContainerReport(r, options), /Malformed vulnerability finding/);
    }
  }
  for (const db of [
    undefined,
    {},
    { ...database, Version: 1 },
    { ...database, UpdatedAt: '2026-10-22T00:00:00Z' },
    { ...database, UpdatedAt: '2026-10-26T00:00:00Z' },
  ])
    assert.throws(() => assessContainerReport(report(), { ...options, database: db }));
});

test('candidate targets cover every published platform and refuse stale or mutable source identities', () => {
  const source = { repository: 'example/rivet', ref: 'refs/heads/main', sha: 'c'.repeat(40) };
  const input = createStudioServerReleaseManifest({
    rootDir: root,
    source,
    images: Object.fromEntries(
      Object.keys(imagePlatforms).map((name) => [
        name,
        { repository: `example.test/${name}`, digest: `sha256:${'a'.repeat(64)}` },
      ]),
    ),
    candidateEvidence: { workflow: 'fixture', runId: '1', runAttempt: 1 },
  });
  for (const service of Object.keys(imagePlatforms)) {
    const targets = candidateScanTargets(input, service, source.sha);
    assert.deepEqual(
      targets.map((target) => target.platform),
      imagePlatforms[service],
    );
    assert.ok(targets.every((target) => target.image.endsWith(`@sha256:${'a'.repeat(64)}`)));
  }
  assert.throws(() => candidateScanTargets(input, 'proxy', 'd'.repeat(40)), /source differs/);
  assert.throws(() => candidateScanTargets(input, 'unknown', source.sha));
  assert.throws(() => candidateScanTargets({ ...input, state: 'promoted' }, 'proxy', source.sha));
  const changed = structuredClone(input);
  changed.images.proxy.digest = 'latest';
  assert.throws(() => candidateScanTargets(changed, 'proxy', source.sha));
});

test('scanner is immutable, isolated, bounded and scans all vulnerability statuses without ambient ignores', () => {
  const settings = {
    output: path.join(root, 'artifacts/fixture'),
    cache: path.join(root, 'artifacts/cache'),
    image,
    platform: 'linux/arm64',
    owner: 'fixture',
  };
  const args = scannerArguments(settings);
  assert.ok(args.includes(scannerImage));
  assert.match(scannerImage, /@sha256:[a-f0-9]{64}$/);
  assert.ok(args.includes('--read-only') && args.includes('--cap-drop=ALL'));
  assert.ok(!args.some((arg) => arg.includes('docker.sock')));
  assert.ok(args.includes('--ignore-unfixed=false'));
  assert.ok(args.includes('UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL'));
  assert.equal(args[args.indexOf('--scanners') + 1], 'vuln');
  assert.equal(args[args.indexOf('--platform') + 1], 'linux/arm64');
  assert.ok(args.includes('/scan-config/empty.ignore') && args.includes('/scan-config/trivy.yaml'));
  assert.equal(args.at(-1), image);
  const archiveArgs = scannerArguments({ ...settings, image: undefined, archive: '/fixture/image.tar' });
  assert.ok(archiveArgs.includes('/input/image.tar'));
  assert.ok(archiveArgs.some((arg) => arg.endsWith('target=/input/image.tar,readonly')));
  assert.throws(() => scannerArguments({ ...settings, image: 'example.test/proxy:latest' }));
  assert.throws(() => scannerArguments({ ...settings, platform: 'linux/unknown' }));
  assert.throws(() => scannerArguments({ ...settings, archive: '/fixture/image.tar' }));
});

test('the actual CLI records scanner startup failure, exits nonzero and refuses stale output reuse', async () => {
  const output = path.join(root, 'artifacts', `scanner-failure-test-${randomUUID()}`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = path.join(output, 'no-executable'); // Never invoke the real Docker daemon.
  const args = [
    fileURLToPath(new URL('./scan-container-images.mjs', import.meta.url)),
    '--image',
    image,
    '--platform',
    'linux/amd64',
    '--output',
    output,
    '--cache',
    path.join(output, 'cache'),
  ];
  try {
    const first = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(first.status, 1, first.stderr);
    const receipt = await fs.readFile(path.join(output, 'result.json'), 'utf8');
    const result = JSON.parse(receipt);
    assert.equal(result.passed, false);
    assert.match(result.failures[0], /ENOENT/);
    await assert.rejects(fs.stat(path.join(output, 'linux-amd64', 'assessment.json')), { code: 'ENOENT' });
    const repeat = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(repeat.status, 1, repeat.stderr);
    assert.equal(await fs.readFile(path.join(output, 'result.json'), 'utf8'), receipt);
  } finally {
    assert.equal(path.dirname(output), path.join(root, 'artifacts'));
    await fs.rm(output, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseManifestMatchesCurrentChart,
  assertReleaseManifestMatchesCurrentSource,
  assertStudioServerReleasePredecessor,
  assertStudioServerReleaseManifest,
  createForwardRollbackHelmValues,
  createProductionHelmValues,
  createStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
  promoteStudioServerReleaseManifest,
  readHelmChartIdentity,
  readManagedWorkflowSchemaReleaseContract,
} from './lib/studio-server-release-manifest.mjs';
import {
  assertContentAddressedManifestReference,
  assertProductionManifestRetag,
  isMissingRegistryManifestError,
  pullReleaseManifestArtifact,
  retagReleaseManifestArtifact,
  PRODUCTION_RELEASE_MANIFEST_REFERENCE,
} from './release-manifest-oci.mjs';
import { parseArgs, resolveDeploymentRelease } from './deploy-kubernetes-release.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const digest = (letter) => `sha256:${letter.repeat(64)}`;

function images(prefix = 'example.test/rivet') {
  return {
    proxy: { repository: `${prefix}/proxy`, digest: digest('a') },
    web: { repository: `${prefix}/web`, digest: digest('b') },
    api: { repository: `${prefix}/api`, digest: digest('c') },
    executor: { repository: `${prefix}/executor`, digest: digest('d') },
  };
}

function candidate({ predecessorRelease = null, sourceSha = 'a'.repeat(40), imagePrefix } = {}) {
  return createStudioServerReleaseManifest({
    rootDir,
    source: {
      repository: 'valerypopoff/rivet2.0',
      ref: 'refs/heads/main',
      sha: sourceSha,
    },
    images: images(imagePrefix),
    candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
    predecessorRelease,
    createdAt: '2026-08-29T12:00:00.000Z',
  });
}

function promoted(overrides = {}, options = {}) {
  return promoteStudioServerReleaseManifest(
    { ...candidate(options), ...overrides },
    {
      promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
      promotedAt: '2026-08-29T12:05:00.000Z',
    },
  );
}

test('release manifest reads the source-owned managed schema contract', () => {
  assert.deepEqual(readManagedWorkflowSchemaReleaseContract(rootDir), {
    version: 15,
    minimumRollbackCompatibleVersion: 15,
  });
});

test('release manifest binds the exact current Helm chart contents', () => {
  const release = promoted();
  const chart = readHelmChartIdentity(rootDir);
  assert.equal(release.chart.name, chart.name);
  assert.equal(release.chart.version, chart.version);
  assert.equal(release.chart.contentDigest, chart.contentDigest);
  assert.equal(assertReleaseManifestMatchesCurrentChart(release, rootDir).chart.contentDigest, chart.contentDigest);
  assert.throws(
    () =>
      assertReleaseManifestMatchesCurrentChart(
        { ...release, chart: { ...release.chart, contentDigest: digest('f') } },
        rootDir,
      ),
    /does not match release manifest chart/,
  );
});

test('release manifest digest is semantic, deterministic, and formatting independent', () => {
  const release = promoted();
  const reordered = {
    evidence: release.evidence,
    images: release.images,
    lineage: release.lineage,
    database: release.database,
    chart: release.chart,
    source: release.source,
    createdAt: release.createdAt,
    state: release.state,
    formatVersion: release.formatVersion,
  };
  assert.equal(getStudioServerReleaseManifestDigest(release), getStudioServerReleaseManifestDigest(reordered));
  assert.notEqual(
    getStudioServerReleaseManifestDigest(release),
    getStudioServerReleaseManifestDigest({
      ...release,
      images: { ...release.images, api: { ...release.images.api, digest: digest('e') } },
    }),
  );
});

test('legacy promoted manifests remain readable but cannot authorize lineage rollback', () => {
  const release = promoted();
  const legacyFields = { ...release };
  delete legacyFields.lineage;
  const legacyRelease = assertStudioServerReleaseManifest(
    {
      ...legacyFields,
      formatVersion: 1,
    },
    { requirePromoted: true },
  );
  assert.equal(legacyRelease.formatVersion, 1);
  assert.throws(
    () =>
      promoteStudioServerReleaseManifest({
        ...legacyRelease,
        state: 'candidate',
        evidence: { candidate: release.evidence.candidate },
      }),
    /Legacy candidates cannot be promoted/,
  );
  assert.throws(
    () => createForwardRollbackHelmValues({ failedRelease: legacyRelease, rollbackRelease: release }),
    /Legacy releases are explicitly non-rollbackable/,
  );
});

test('promotion rechecks the exact production predecessor and refuses stale candidates', () => {
  const predecessor = promoted();
  const nextCandidate = candidate({
    predecessorRelease: predecessor,
    sourceSha: 'b'.repeat(40),
    imagePrefix: 'example.test/next',
  });
  assert.equal(assertStudioServerReleasePredecessor(nextCandidate, predecessor).source.sha, 'b'.repeat(40));

  const sibling = promoted({}, { sourceSha: 'c'.repeat(40), imagePrefix: 'example.test/sibling' });
  assert.throws(
    () => assertStudioServerReleasePredecessor(nextCandidate, sibling),
    /does not match the candidate's exact predecessor manifest/,
  );
  assert.throws(
    () => assertStudioServerReleasePredecessor(nextCandidate, null),
    /production release-manifest pointer is missing/,
  );
  assert.throws(() => assertStudioServerReleasePredecessor(candidate(), predecessor), /created as a bootstrap release/);
  assert.throws(
    () => assertStudioServerReleasePredecessor(predecessor, predecessor),
    /requires a candidate release manifest/,
  );
  assert.throws(
    () => promoteStudioServerReleaseManifest(predecessor),
    /Only a candidate release manifest can be promoted/,
  );
});

test('release-manifest OCI artifacts are data-only and registry failures fail closed', () => {
  const dockerfile = fs.readFileSync(
    path.join(rootDir, 'deploy', 'studio-server', 'images', 'release-manifest', 'Dockerfile'),
    'utf8',
  );

  assert.match(dockerfile, /^FROM scratch\s+COPY release-manifest\.json \/release-manifest\.json/m);
  assert.equal(isMissingRegistryManifestError('manifest unknown'), true);
  assert.equal(isMissingRegistryManifestError('name unknown: repository does not exist'), true);
  assert.equal(isMissingRegistryManifestError('credential helper executable not found'), false);
  assert.equal(isMissingRegistryManifestError('dial tcp: lookup ghcr.io: no such host'), false);
  assert.equal(isMissingRegistryManifestError('denied: permission_denied'), false);
  assert.equal(isMissingRegistryManifestError('unauthorized: authentication required'), false);
  assert.equal(isMissingRegistryManifestError('unexpected status: 503 Service Unavailable'), false);
});

test('Build Images automatically repairs an exact retained production lineage before manual fallback', () => {
  const workflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'studio-server-images.yml'), 'utf8');

  assert.match(workflow, /allow_release_lineage_bootstrap/);
  assert.match(
    workflow,
    /The durable production release-manifest pointer is missing and only \$promoted_image_count of 4 promoted latest images exist/,
  );
  assert.match(workflow, /actions\/artifacts\?per_page=100/);
  assert.match(
    workflow,
    /recovery_root="\$\(mktemp -d "\$GITHUB_WORKSPACE\/artifacts\/rivet-release-lineage-recovery\.XXXXXX"\)"/,
  );
  assert.match(workflow, /\.workflow_run\.repository_id == \.workflow_run\.head_repository_id/);
  assert.match(
    workflow,
    /\.state == "promoted" and \.source\.repository == \$source_repository and \.source\.ref == "refs\/heads\/main" and \.source\.sha == \$source_sha and \.images\[\$service\]\.repository == \$repository and \.images\[\$service\]\.digest == \$digest/,
  );
  assert.match(workflow, /Recovered the missing durable production pointer from retained artifact/);
  assert.match(workflow, /One-time Studio Server release-lineage bootstrap required/);
  assert.match(workflow, /Another push or rerun cannot reconstruct that historical evidence/);
  assert.match(workflow, /The successful bootstrap creates the durable/);
  assert.match(workflow, /isMissingRegistryManifestError\(fs\.readFileSync\(process\.argv\[1\], "utf8"\)\)/);
  assert.match(
    workflow,
    /refusing to treat a registry failure as a missing release\."\s+cat "\$inspect_diagnostics" >&2\s+exit 1/,
  );
});

test('retained recovery manifests pass the real digest CLI only inside the checkout', () => {
  const artifactsRoot = path.join(rootDir, 'artifacts');
  fs.mkdirSync(artifactsRoot, { recursive: true });
  const recoveryDirectory = fs.mkdtempSync(path.join(artifactsRoot, 'rivet-release-lineage-recovery.'));
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-release-lineage-recovery.'));
  try {
    const release = promoted();
    const cli = path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'create-release-manifest.mjs');
    const runDigest = (directory) => {
      const manifestPath = path.join(directory, 'promoted-release-manifest.json');
      fs.writeFileSync(manifestPath, `${JSON.stringify(release)}\n`);
      return spawnSync(process.execPath, [cli, 'digest', '--input', manifestPath], {
        cwd: rootDir,
        encoding: 'utf8',
      });
    };

    const recovered = runDigest(recoveryDirectory);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.stdout.trim(), getStudioServerReleaseManifestDigest(release, { requirePromoted: true }));

    const outside = runDigest(outsideDirectory);
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /--input must remain inside this repository/);
  } finally {
    fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    fs.rmSync(outsideDirectory, { recursive: true, force: true });
  }
});

test('release-manifest OCI tags bind the semantic digest and production repository', () => {
  const manifestDigest = digest('a');
  const source = `ghcr.io/example/releases:manifest-${'a'.repeat(64)}`;
  const destination = 'ghcr.io/example/releases:production';

  assert.equal(assertContentAddressedManifestReference(source, manifestDigest), source);
  assert.deepEqual(assertProductionManifestRetag({ source, destination, manifestDigest }), { source, destination });
  assert.throws(
    () => assertContentAddressedManifestReference('ghcr.io/example/releases:manifest-wrong', manifestDigest),
    /must use its semantic digest tag/,
  );
  assert.throws(
    () => assertContentAddressedManifestReference(source, 'sha256:not-a-digest'),
    /must be a lowercase SHA-256 digest/,
  );
  assert.throws(
    () =>
      assertProductionManifestRetag({
        source,
        destination: 'ghcr.io/example/releases:latest',
        manifestDigest,
      }),
    /destination must be the production pointer/,
  );
  assert.throws(
    () =>
      assertProductionManifestRetag({
        source,
        destination: 'ghcr.io/example/other:production',
        manifestDigest,
      }),
    /must use the same repository/,
  );
});

test('release manifest refuses a deployment checkout from another source revision', () => {
  const release = promoted();
  assert.equal(assertReleaseManifestMatchesCurrentSource(release, release.source.sha).source.sha, release.source.sha);
  assert.throws(
    () => assertReleaseManifestMatchesCurrentSource(release, 'b'.repeat(40)),
    /does not match release manifest source/,
  );
});

test('release manifest CLI keeps release evidence inside the repository', () => {
  const createResult = spawnSync(
    process.execPath,
    [
      path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'create-release-manifest.mjs'),
      'create',
      '--output',
      '../outside-release-manifest.json',
    ],
    { cwd: rootDir, encoding: 'utf8' },
  );
  assert.equal(createResult.status, 1);
  assert.match(createResult.stderr, /--output must remain inside this repository/);

  const promoteResult = spawnSync(
    process.execPath,
    [
      path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'create-release-manifest.mjs'),
      'promote',
      '--input',
      '../outside-release-manifest.json',
      '--output',
      'artifacts/releases/release-manifest.json',
    ],
    { cwd: rootDir, encoding: 'utf8' },
  );
  assert.equal(promoteResult.status, 1);
  assert.match(promoteResult.stderr, /--input must remain inside this repository/);
});

test('release manifest CLI binds and rechecks the production predecessor before promotion', () => {
  const artifactsRoot = path.join(rootDir, 'artifacts');
  fs.mkdirSync(artifactsRoot, { recursive: true });
  const temporaryDirectory = fs.mkdtempSync(path.join(artifactsRoot, 'release-manifest-cli-'));
  try {
    const predecessorPath = path.join(temporaryDirectory, 'predecessor.json');
    const candidatePath = path.join(temporaryDirectory, 'candidate.json');
    const promotedPath = path.join(temporaryDirectory, 'promoted.json');
    fs.writeFileSync(predecessorPath, `${JSON.stringify(promoted(), null, 2)}\n`);
    const relative = (filePath) => path.relative(rootDir, filePath);
    const cli = path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'create-release-manifest.mjs');
    const imageSpecs = Object.entries(images('example.test/cli'))
      .map(([component, image]) => `${component}=${image.repository}@${image.digest}`)
      .join(',');
    const createResult = spawnSync(
      process.execPath,
      [
        cli,
        'create',
        '--output',
        relative(candidatePath),
        '--predecessor',
        relative(predecessorPath),
        '--source-repository',
        'valerypopoff/rivet2.0',
        '--source-ref',
        'refs/heads/main',
        '--source-sha',
        'b'.repeat(40),
        '--workflow',
        'Build Images',
        '--run-id',
        '456',
        '--run-attempt',
        '1',
        '--image',
        imageSpecs,
      ],
      { cwd: rootDir, encoding: 'utf8' },
    );
    assert.equal(createResult.status, 0, createResult.stderr);

    const missingCurrent = spawnSync(
      process.execPath,
      [
        cli,
        'promote',
        '--input',
        relative(candidatePath),
        '--output',
        relative(promotedPath),
        '--workflow',
        'Build Images',
        '--run-id',
        '456',
        '--run-attempt',
        '1',
      ],
      { cwd: rootDir, encoding: 'utf8' },
    );
    assert.equal(missingCurrent.status, 1);
    assert.match(missingCurrent.stderr, /production release-manifest pointer is missing/);

    const promoteResult = spawnSync(
      process.execPath,
      [
        cli,
        'promote',
        '--input',
        relative(candidatePath),
        '--current',
        relative(predecessorPath),
        '--output',
        relative(promotedPath),
        '--workflow',
        'Build Images',
        '--run-id',
        '456',
        '--run-attempt',
        '1',
      ],
      { cwd: rootDir, encoding: 'utf8' },
    );
    assert.equal(promoteResult.status, 0, promoteResult.stderr);

    const digestResult = spawnSync(process.execPath, [cli, 'digest', '--input', relative(promotedPath)], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    assert.equal(digestResult.status, 0, digestResult.stderr);
    assert.match(digestResult.stdout.trim(), /^sha256:[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('production deployment verifies a clean manifest source checkout before rendering values', () => {
  const deployer = fs.readFileSync(
    path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'deploy-kubernetes-release.mjs'),
    'utf8',
  );
  assert.match(
    deployer,
    /await verifyCheckout\(manifest\);\s+await verifyClean\(\);\s+assertReleaseManifestMatchesCurrentChart\(manifest, rootDir\);/,
  );
  const selectionOffset = deployer.search(/await resolveDeploymentRelease\s*\(\s*options,\s*artifactsDir,?\s*\)/u);
  assert.ok(selectionOffset >= 0, 'The deployment entry point must resolve its release before mutation');
  for (const mutation of ['await prepareProductionSecrets(', 'await prepareSingleMachine(']) {
    const mutationOffset = deployer.indexOf(mutation);
    assert.ok(mutationOffset >= 0 && selectionOffset < mutationOffset);
  }
  assert.match(deployer, /label: 'unstaged tracked changes',\s+args: \['diff', '--quiet', '--exit-code', '--'\]/);
  assert.match(
    deployer,
    /label: 'staged tracked changes',\s+args: \['diff', '--cached', '--quiet', '--exit-code', '--'\]/,
  );
});

function artifactDocker(
  manifest,
  { pullFailure, copyFailure, removeFailure, removalTransportFailure, copy, createFailure, emptyAcknowledgement } = {},
) {
  const calls = [];
  const selectedDigest = digest('e');
  const imageId = digest('f');
  const execute = async (program, args) => {
    assert.equal(program, 'docker');
    calls.push(args);
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (args[0] === 'pull')
      return pullFailure
        ? { exitCode: 1, stdout: '', stderr: pullFailure }
        : ok(`Downloaded\nDigest: ${selectedDigest}\nStatus: Downloaded newer image\n`);
    if (args[0] === 'image') {
      assert.equal(args.at(-1), `ghcr.io/valerypopoff/rivet2.0-studio-server/release-manifest@${selectedDigest}`);
      return ok(imageId);
    }
    if (args[0] === 'create') {
      // The production pointer has moved by now. Only the acknowledged image is correct.
      assert.equal(args[1], '--name');
      assert.match(args[2], /^rivet-manifest-[a-f0-9-]{36}$/);
      assert.equal(args[3], imageId);
      if (createFailure) throw new Error('Docker create acknowledgement lost');
      if (emptyAcknowledgement) return ok();
      return ok('temporary-artifact-container');
    }
    if (args[0] === 'cp') {
      if (copyFailure) throw new Error('Artifact copy failed');
      if (copy) copy(args[2]);
      else fs.writeFileSync(args[2], typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
      return ok();
    }
    if (args[0] === 'rm') {
      if (removalTransportFailure) throw new Error('Docker cleanup transport failed');
      return removeFailure ? { exitCode: 1, stdout: '', stderr: 'Removal failed' } : ok();
    }
    assert.fail(`Unexpected Docker command: ${args}`);
  };
  return { calls, execute, selectedDigest, imageId };
}

test('promoted artifact extraction pins this pull, never starts a container, and cleans up on success and failure', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-manifest-pull-test-'));
  const output = path.join(temporaryDirectory, 'manifest.json');
  try {
    for (const scenario of [
      'success',
      'copy failure',
      'malformed',
      'candidate',
      'cleanup failure',
      'copy and cleanup failure',
      'copy and cleanup transport failure',
      'create acknowledgement failure',
      'empty create acknowledgement',
    ]) {
      const docker = artifactDocker(
        scenario === 'malformed' ? '{invalid' : scenario === 'candidate' ? candidate() : promoted(),
        {
          copyFailure: scenario.startsWith('copy'),
          removeFailure: scenario === 'cleanup failure' || scenario === 'copy and cleanup failure',
          removalTransportFailure: scenario === 'copy and cleanup transport failure',
          createFailure: scenario === 'create acknowledgement failure',
          emptyAcknowledgement: scenario === 'empty create acknowledgement',
        },
      );
      const pending = pullReleaseManifestArtifact(PRODUCTION_RELEASE_MANIFEST_REFERENCE, output, docker);
      if (scenario === 'success') {
        const result = await pending;
        assert.deepEqual(result.manifest, promoted());
        assert.deepEqual(result.identity, {
          reference: PRODUCTION_RELEASE_MANIFEST_REFERENCE,
          resolvedReference: `ghcr.io/valerypopoff/rivet2.0-studio-server/release-manifest@${docker.selectedDigest}`,
          imageId: docker.imageId,
        });
      } else
        await assert.rejects(pending, (error) => {
          if (scenario.startsWith('copy and cleanup')) {
            assert.ok(error instanceof AggregateError);
            assert.match(error.message, /Artifact copy failed/);
            assert.match(error.message, /Removal failed|cleanup transport failed/);
          }
          return true;
        });
      assert.deepEqual(docker.calls.at(-1), [
        'rm',
        '--force',
        '--volumes',
        docker.calls.find((args) => args[0] === 'create')[2],
      ]);
      const copyPath = docker.calls.find((args) => args[0] === 'cp')?.[2];
      if (copyPath) assert.equal(fs.existsSync(path.dirname(copyPath)), false);
      assert.equal(
        docker.calls.some((args) => ['start', 'run'].includes(args[0])),
        false,
      );
      if (scenario !== 'success') assert.equal(fs.existsSync(output), false);
    }
    for (const failure of ['manifest unknown', 'unauthorized: authentication required', 'TLS handshake timeout']) {
      // Previously cached valid bytes must never authorize a failed pull.
      fs.writeFileSync(output, JSON.stringify(promoted()));
      const docker = artifactDocker(promoted(), { pullFailure: failure });
      await assert.rejects(
        pullReleaseManifestArtifact(PRODUCTION_RELEASE_MANIFEST_REFERENCE, output, docker),
        /No cached or candidate release/,
      );
      assert.deepEqual(docker.calls, [['pull', PRODUCTION_RELEASE_MANIFEST_REFERENCE]]);
      assert.equal(fs.existsSync(output), false);
    }
    const noDigest = async () => ({ exitCode: 0, stdout: 'Status: Image is up to date', stderr: '' });
    await assert.rejects(
      pullReleaseManifestArtifact(PRODUCTION_RELEASE_MANIFEST_REFERENCE, output, { execute: noDigest }),
      /immutable artifact digest/,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('artifact extraction rejects oversized and linked manifests without writing through host paths', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-manifest-file-test-'));
  const sentinel = path.join(directory, 'sentinel.json');
  const originalBytes = JSON.stringify(promoted());
  fs.writeFileSync(sentinel, originalBytes);
  try {
    for (const kind of ['oversized', 'directory', 'link', 'concurrent-output']) {
      const output = path.join(directory, 'output.json');
      const docker = artifactDocker(promoted(), {
        copy: (extracted) => {
          if (kind === 'oversized') fs.writeFileSync(extracted, `${' '.repeat(1024 * 1024)}${originalBytes}`);
          if (kind === 'directory') fs.mkdirSync(extracted);
          if (kind === 'link')
            fs.symlinkSync(
              process.platform === 'win32' ? directory : sentinel,
              extracted,
              process.platform === 'win32' ? 'junction' : 'file',
            );
          if (kind === 'concurrent-output') {
            fs.writeFileSync(extracted, originalBytes);
            fs.writeFileSync(output, 'another operation owns this file');
          }
        },
      });
      await assert.rejects(pullReleaseManifestArtifact(PRODUCTION_RELEASE_MANIFEST_REFERENCE, output, docker));
      assert.equal(fs.readFileSync(sentinel, 'utf8'), originalBytes);
      if (kind === 'concurrent-output') {
        assert.equal(fs.readFileSync(output, 'utf8'), 'another operation owns this file');
      } else assert.equal(fs.existsSync(output), false);
      const extracted = docker.calls.find((args) => args[0] === 'cp')[2];
      assert.equal(fs.existsSync(path.dirname(extracted)), false);
      assert.deepEqual(docker.calls.at(-1), [
        'rm',
        '--force',
        '--volumes',
        docker.calls.find((args) => args[0] === 'create')[2],
      ]);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('production promotion retags only the verified immutable registry artifact', async () => {
  const manifest = promoted();
  const source = `ghcr.io/valerypopoff/rivet2.0-studio-server/release-manifest:manifest-${getStudioServerReleaseManifestDigest(manifest).slice(7)}`;
  const docker = artifactDocker(manifest);
  const retags = [];
  await retagReleaseManifestArtifact(source, PRODUCTION_RELEASE_MANIFEST_REFERENCE, {
    execute: async (program, args) => {
      if (args[0] !== 'buildx') return docker.execute(program, args);
      retags.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(retags, [
    [
      'buildx',
      'imagetools',
      'create',
      '--tag',
      PRODUCTION_RELEASE_MANIFEST_REFERENCE,
      `ghcr.io/valerypopoff/rivet2.0-studio-server/release-manifest@${docker.selectedDigest}`,
    ],
  ]);
  assert.deepEqual(docker.calls.at(-1), [
    'rm',
    '--force',
    '--volumes',
    docker.calls.find((args) => args[0] === 'create')[2],
  ]);
});

test('automatic deployment selection equals an explicit release pin and retains immutable diagnostic evidence', async () => {
  const directory = fs.mkdtempSync(path.join(rootDir, 'artifacts', 'release-selection-test-'));
  try {
    const manifest = promoted();
    const source = path.join(directory, 'pinned.json');
    fs.writeFileSync(source, JSON.stringify(manifest));
    const verification = [];
    const checks = {
      verifyCheckout: async (selected) => {
        verification.push('checkout');
        assertReleaseManifestMatchesCurrentSource(selected, manifest.source.sha);
      },
      verifyClean: async () => {
        verification.push('clean');
      },
    };
    const docker = artifactDocker(manifest);
    const automatic = await resolveDeploymentRelease(parseArgs(['--dry-run']), path.join(directory, 'automatic'), {
      ...checks,
      pullArtifact: (reference, output) => pullReleaseManifestArtifact(reference, output, docker),
    });
    const explicit = await resolveDeploymentRelease(
      parseArgs(['--manifest', path.relative(rootDir, source)]),
      path.join(directory, 'explicit'),
      {
        ...checks,
        pullArtifact: () => assert.fail('An explicit manifest must not contact the registry'),
      },
    );
    assert.deepEqual(automatic.generatedValues, explicit.generatedValues);
    assert.deepEqual(verification, ['checkout', 'clean', 'checkout', 'clean']);
    assert.deepEqual(JSON.parse(fs.readFileSync(automatic.manifestPath, 'utf8')), manifest);
    const identity = JSON.parse(fs.readFileSync(path.join(directory, 'automatic', 'release-selection.json'), 'utf8'));
    assert.equal(identity.mode, 'production');
    assert.equal(identity.imageId, docker.imageId);
    assert.equal(identity.sourceSha, manifest.source.sha);
    assert.equal(identity.manifestDigest, getStudioServerReleaseManifestDigest(manifest));
    assert.match(identity.resolvedReference, /@sha256:[a-f0-9]{64}$/);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'automatic')).sort(), [
      'release-manifest.json',
      'release-selection.json',
    ]);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, 'explicit', 'release-selection.json'), 'utf8')).mode,
      'explicit',
    );
    // A pin selected from earlier diagnostics remains byte-for-byte unchanged.
    const pinnedBytes = JSON.stringify(manifest);
    fs.writeFileSync(automatic.manifestPath, pinnedBytes);
    await resolveDeploymentRelease(
      new Map([['--manifest', path.relative(rootDir, automatic.manifestPath)]]),
      path.join(directory, 'automatic'),
      {
        ...checks,
        pullArtifact: () => assert.fail('A diagnostic pin must not contact the registry'),
      },
    );
    assert.equal(fs.readFileSync(automatic.manifestPath, 'utf8'), pinnedBytes);
    const metadataPin = path.join(directory, 'automatic', 'release-selection.json');
    fs.writeFileSync(metadataPin, pinnedBytes);
    await resolveDeploymentRelease(
      new Map([['--manifest', path.relative(rootDir, metadataPin)]]),
      path.dirname(metadataPin),
      {
        ...checks,
        pullArtifact: () => assert.fail('An explicit metadata-filename pin must not contact the registry'),
      },
    );
    assert.equal(fs.readFileSync(metadataPin, 'utf8'), pinnedBytes);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(path.dirname(metadataPin), 'release-selection-metadata.json'), 'utf8')).mode,
      'explicit',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('release selection rejects untrusted releases and checkout drift before returning deployable values', async () => {
  const directory = fs.mkdtempSync(path.join(rootDir, 'artifacts', 'release-selection-rejected-'));
  try {
    for (const scenario of ['candidate', 'malformed', 'source', 'chart', 'dirty', 'missing', 'auth', 'network']) {
      const release = scenario === 'candidate' ? candidate() : promoted();
      if (scenario === 'chart') release.chart.contentDigest = digest('e');
      const output = path.join(directory, scenario);
      const pullFailures = { missing: 'manifest unknown', auth: 'unauthorized', network: 'connection timed out' };
      const docker = artifactDocker(scenario === 'malformed' ? 'invalid JSON' : release, {
        pullFailure: pullFailures[scenario],
      });
      await assert.rejects(
        resolveDeploymentRelease(new Map(), output, {
          pullArtifact: (reference, file) => pullReleaseManifestArtifact(reference, file, docker),
          verifyCheckout: async (selected) =>
            assertReleaseManifestMatchesCurrentSource(
              selected,
              scenario === 'source' ? 'b'.repeat(40) : 'a'.repeat(40),
            ),
          verifyClean: async () => {
            if (scenario === 'dirty') throw new Error('Tracked checkout is dirty');
          },
        }),
      );
      assert.deepEqual(fs.readdirSync(output), [], 'No validated deployment artifacts or temporary extraction remain');
      if (pullFailures[scenario]) assert.deepEqual(docker.calls, [['pull', PRODUCTION_RELEASE_MANIFEST_REFERENCE]]);
      else
        assert.deepEqual(docker.calls.at(-1), [
          'rm',
          '--force',
          '--volumes',
          docker.calls.find((args) => args[0] === 'create')[2],
        ]);
    }
    await assert.rejects(
      resolveDeploymentRelease(new Map([['--rollback-to', 'previous.json']]), directory, {
        pullArtifact: () => assert.fail('Rollback must not consult the current production pointer'),
      }),
      /requires an explicit --manifest/,
    );
    const rollback = spawnSync(
      process.execPath,
      [
        path.join(rootDir, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs'),
        '--release',
        'rivet',
        '--namespace',
        'rivet',
        '--rollback-to',
        'previous.json',
        '--dry-run',
      ],
      { cwd: rootDir, encoding: 'utf8' },
    );
    assert.equal(rollback.status, 1);
    assert.match(rollback.stderr, /requires an explicit --manifest/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('only promoted manifests can produce production Helm values', () => {
  assert.throws(() => createProductionHelmValues(candidate()), /requires a promoted release manifest/);

  const values = createProductionHelmValues(promoted());
  assert.equal(values.release.production.enabled, true);
  assert.match(values.release.production.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(values.images.api.digest, digest('c'));
  assert.deepEqual(values.workflowSchema.compatibility, { minimumVersion: 15, maximumVersion: 15 });
  assert.equal(values.workflowSchema.migrationJob.enabled, true);
});

test('forward rollback retains the migrated schema and restores only a compatible image set', () => {
  const originalRollbackRelease = promoted();
  const rollbackRelease = {
    ...originalRollbackRelease,
    chart: { ...originalRollbackRelease.chart, contentDigest: digest('e') },
  };
  const failedRelease = assertStudioServerReleaseManifest(
    {
      ...promoted(
        {},
        {
          predecessorRelease: rollbackRelease,
          sourceSha: 'b'.repeat(40),
          imagePrefix: 'example.test/candidate',
        },
      ),
      chart: { ...rollbackRelease.chart, contentDigest: digest('f') },
      database: {
        managedWorkflowSchema: {
          version: 16,
          minimumRollbackCompatibleVersion: 15,
        },
      },
    },
    { requirePromoted: true },
  );

  const values = createForwardRollbackHelmValues({ failedRelease, rollbackRelease });
  assert.equal(values.workflowSchema.migrationJob.enabled, false);
  assert.equal(values.compatibility.legacyStartupSettingsFiles, true);
  assert.deepEqual(values.workflowSchema.compatibility, { minimumVersion: 15, maximumVersion: 16 });
  assert.equal(values.release.production.database.managedWorkflowSchemaVersion, 16);
  assert.equal(values.release.production.chart.contentDigest, digest('f'));
  assert.equal(values.images.api.repository, 'example.test/rivet/api');
});

test('normal deployment never asks Helm to roll back a possibly migrated schema automatically', () => {
  const deployer = fs.readFileSync(
    path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'deploy-kubernetes-release.mjs'),
    'utf8',
  );
  assert.match(deployer, /\.\.\.\(rollbackManifestPath \? \['--atomic'\] : \[\]\),/);
  assert.doesNotMatch(deployer, /\.\.\.valueArgs,\s*'--atomic',/);
  assert.match(deployer, /candidate was intentionally not rolled back automatically/);
});

test('forward rollback refuses a schema that did not declare the previous release compatible', () => {
  const previous = promoted();
  const rollbackRelease = {
    ...previous,
    database: {
      managedWorkflowSchema: {
        version: 14,
        minimumRollbackCompatibleVersion: 2,
      },
    },
  };
  const failedRelease = assertStudioServerReleaseManifest(
    {
      ...promoted({}, { predecessorRelease: rollbackRelease, sourceSha: 'b'.repeat(40) }),
      database: {
        managedWorkflowSchema: {
          version: 15,
          minimumRollbackCompatibleVersion: 15,
        },
      },
    },
    { requirePromoted: true },
  );

  assert.throws(
    () => createForwardRollbackHelmValues({ failedRelease, rollbackRelease }),
    /is not declared compatible with rollback release schema/,
  );
});

test('forward rollback refuses a promoted release other than the exact predecessor', () => {
  const predecessor = promoted();
  const failedRelease = promoted(
    {},
    {
      predecessorRelease: predecessor,
      sourceSha: 'b'.repeat(40),
      imagePrefix: 'example.test/candidate',
    },
  );
  const olderOrSibling = promoted(
    {},
    {
      sourceSha: 'c'.repeat(40),
      imagePrefix: 'example.test/other',
    },
  );

  assert.throws(
    () => createForwardRollbackHelmValues({ failedRelease, rollbackRelease: olderOrSibling }),
    /does not match the candidate's exact predecessor manifest/,
  );
  assert.throws(
    () => createForwardRollbackHelmValues({ failedRelease: promoted(), rollbackRelease: predecessor }),
    /Bootstrap releases have no verified predecessor/,
  );
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
} from './release-manifest-oci.mjs';

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
    version: 10,
    minimumRollbackCompatibleVersion: 2,
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
    /const manifest = await readManifest\(manifestPath, \{ requirePromoted: true \}\);\s+await assertReleaseManifestMatchesCurrentCheckout\(manifest\);\s+await assertCleanTrackedCheckout\(\);\s+assertReleaseManifestMatchesCurrentChart\(manifest, rootDir\);/,
  );
  assert.match(deployer, /label: 'unstaged tracked changes',\s+args: \['diff', '--quiet', '--exit-code', '--'\]/);
  assert.match(
    deployer,
    /label: 'staged tracked changes',\s+args: \['diff', '--cached', '--quiet', '--exit-code', '--'\]/,
  );
});

test('only promoted manifests can produce production Helm values', () => {
  assert.throws(() => createProductionHelmValues(candidate()), /requires a promoted release manifest/);

  const values = createProductionHelmValues(promoted());
  assert.equal(values.release.production.enabled, true);
  assert.match(values.release.production.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(values.images.api.digest, digest('c'));
  assert.deepEqual(values.workflowSchema.compatibility, { minimumVersion: 10, maximumVersion: 10 });
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
          version: 10,
          minimumRollbackCompatibleVersion: 8,
        },
      },
    },
    { requirePromoted: true },
  );

  const values = createForwardRollbackHelmValues({ failedRelease, rollbackRelease });
  assert.equal(values.workflowSchema.migrationJob.enabled, false);
  assert.deepEqual(values.workflowSchema.compatibility, { minimumVersion: 2, maximumVersion: 10 });
  assert.equal(values.release.production.database.managedWorkflowSchemaVersion, 10);
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
        version: 9,
        minimumRollbackCompatibleVersion: previous.database.managedWorkflowSchema.minimumRollbackCompatibleVersion,
      },
    },
  };
  const failedRelease = assertStudioServerReleaseManifest(
    {
      ...promoted({}, { predecessorRelease: rollbackRelease, sourceSha: 'b'.repeat(40) }),
      database: {
        managedWorkflowSchema: {
          version: 10,
          minimumRollbackCompatibleVersion: 10,
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

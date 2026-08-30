import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseManifestMatchesCurrentChart,
  assertReleaseManifestMatchesCurrentSource,
  assertStudioServerReleaseManifest,
  createForwardRollbackHelmValues,
  createProductionHelmValues,
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
  readHelmChartIdentity,
  readManagedWorkflowSchemaReleaseContract,
} from './lib/studio-server-release-manifest.mjs';

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

function candidate() {
  return createStudioServerReleaseManifest({
    rootDir,
    source: {
      repository: 'valerypopoff/rivet2.0',
      ref: 'refs/heads/main',
      sha: 'a'.repeat(40),
    },
    images: images(),
    candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
    createdAt: '2026-08-29T12:00:00.000Z',
  });
}

function promoted(overrides = {}) {
  return promoteStudioServerReleaseManifest(
    { ...candidate(), ...overrides },
    {
      promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
      promotedAt: '2026-08-29T12:05:00.000Z',
    },
  );
}

test('release manifest reads the source-owned managed schema contract', () => {
  assert.deepEqual(readManagedWorkflowSchemaReleaseContract(rootDir), {
    version: 6,
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
  assert.equal(values.images.api.digest, digest('c'));
  assert.deepEqual(values.workflowSchema.compatibility, { minimumVersion: 6, maximumVersion: 6 });
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
      ...promoted({
        source: { repository: 'valerypopoff/rivet2.0', ref: 'refs/heads/main', sha: 'b'.repeat(40) },
        images: images('example.test/candidate'),
      }),
      chart: { ...rollbackRelease.chart, contentDigest: digest('f') },
      database: {
        managedWorkflowSchema: {
          version: 7,
          minimumRollbackCompatibleVersion: 6,
        },
      },
    },
    { requirePromoted: true },
  );

  const values = createForwardRollbackHelmValues({ failedRelease, rollbackRelease });
  assert.equal(values.workflowSchema.migrationJob.enabled, false);
  assert.deepEqual(values.workflowSchema.compatibility, { minimumVersion: 2, maximumVersion: 7 });
  assert.equal(values.release.production.database.managedWorkflowSchemaVersion, 7);
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
  const rollbackRelease = promoted();
  const failedRelease = assertStudioServerReleaseManifest(
    {
      ...promoted(),
      database: {
        managedWorkflowSchema: {
          version: 7,
          minimumRollbackCompatibleVersion: 7,
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

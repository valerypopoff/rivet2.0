import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { withLocalSourceBudget } from '../local-metadata/source-budget.js';
import { readMigrationSourceUtf8 } from '../scripts/migration-source-utf8.js';
import { iterateSourceRecordings } from '../local-metadata/filesystem-recording-source.js';
import { getRecordingArtifactPath } from '../routes/workflows/recordings-artifacts.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';
import { localUpgradeFailure } from '../local-metadata/upgrade-diagnostics.js';
import { prepareLegacyRestoreSource } from '../scripts/migrate-workflow-storage.js';
import { readWorkflowMigrationTargetConfig } from '../scripts/migrate-workflow-storage-lib.js';
import { collectSourceAppSettings } from '../scripts/migrate-app-settings.js';
import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import { loadProjectFromString } from '@valerypopoff/rivet2-node';

const target = readWorkflowMigrationTargetConfig({
  RIVET_MIGRATION_TARGET_DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture',
  RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE: 'disable',
  RIVET_MIGRATION_TARGET_S3_BUCKET: 'fixture',
  RIVET_MIGRATION_TARGET_S3_ENDPOINT: 'http://localhost:9000',
  RIVET_MIGRATION_TARGET_S3_REGION: 'us-east-1',
  RIVET_MIGRATION_TARGET_S3_PREFIX: 'fixture/',
  RIVET_MIGRATION_TARGET_S3_FORCE_PATH_STYLE: 'true',
  RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID: 'fixture',
  RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY: 'fixture',
});

async function restoreSource(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-preflight-budget-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = {
    workflows: path.join(root, 'workflows'),
    recordings: path.join(root, 'recordings'),
    appData: path.join(root, 'appData'),
    runtimeLibraries: path.join(root, 'runtimeLibraries'),
  };
  for (const directory of Object.values(roots)) await fs.mkdir(directory);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const project = createBlankProjectFile(`Fixture ${i}`);
    ids.push(loadProjectFromString(project, { logErrors: false }).metadata.id);
    await fs.writeFile(path.join(roots.workflows, `${i}.rivet-project`), project + '\n#' + 'x'.repeat(600 * 1024));
  }
  return { roots, ids };
}

async function recording(roots: { recordings: string }, projectId: string, runId: string, gzip = false) {
  const bundle = path.join(roots.recordings, projectId, runId);
  await fs.mkdir(bundle, { recursive: true });
  await fs.writeFile(
    path.join(bundle, 'metadata.json'),
    JSON.stringify({
      version: 1,
      id: runId,
      sourceProjectMetadataId: projectId,
      sourceProjectName: 'Fixture',
      sourceProjectRelativePath: '0.rivet-project',
      sourceProjectPath: '/workflows/0.rivet-project',
      endpointNameAtExecution: 'fixture',
      createdAt: '2026-01-01T00:00:00.000Z',
      runKind: 'published',
      status: 'succeeded',
      durationMs: 1,
    }),
  );
  await fs.writeFile(
    getRecordingArtifactPath(bundle, 'recording', gzip ? 'gzip' : 'identity'),
    gzip ? gzipSync('x'.repeat(2 * 1048576)) : '{}',
  );
  await fs.writeFile(getRecordingArtifactPath(bundle, 'replay-project', 'identity'), '{}');
}

test('restore preparation uses independent project budgets and rejects orphaned or duplicate recording owners before confirmation', async (t) => {
  const { roots, ids } = await restoreSource(t);
  await withEnvOverride('RIVET_EXTRA_ROOTS', path.dirname(roots.workflows), async () => {
    await withEnvOverride('RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB', '1', async () => {
      assert.equal((await prepareLegacyRestoreSource(roots, target)).projects, 3);
      await recording(roots, 'orphan-project', 'run');
      await assert.rejects(prepareLegacyRestoreSource(roots, target), /Recording project is missing/);
      await fs.rm(path.join(roots.recordings, 'orphan-project'), { recursive: true });
      await recording(roots, ids[0]!, 'same-run');
      await recording(roots, ids[1]!, 'same-run');
      await assert.rejects(prepareLegacyRestoreSource(roots, target), /incomplete or inconsistent/);
    });
  });
});

test('restore bounds the buffered runtime artifact before destructive confirmation', async (t) => {
  const { roots } = await restoreSource(t);
  const current = path.join(roots.runtimeLibraries, 'current');
  await fs.mkdir(path.join(current, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(current, 'package.json'), '{}');
  await fs.writeFile(path.join(current, 'large.js'), 'x'.repeat(2 * 1048576));
  await fs.writeFile(
    path.join(roots.runtimeLibraries, 'manifest.json'),
    JSON.stringify({
      packages: { fixture: { name: 'fixture', version: '1.0.0' } },
      updatedAt: '',
    }),
  );
  await withEnvOverride('RIVET_EXTRA_ROOTS', path.dirname(roots.workflows), async () => {
    await withEnvOverride('RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB', '1', async () => {
      await assert.rejects(prepareLegacyRestoreSource(roots, target), isBundleLimit);
    });
  });
});

test('restore preparation bounds expanded recording payloads and settings even without an inherited budget', async (t) => {
  const { roots, ids } = await restoreSource(t);
  await withEnvOverride('RIVET_EXTRA_ROOTS', path.dirname(roots.workflows), async () => {
    await withEnvOverride('RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB', '1', async () => {
      await recording(roots, ids[0]!, 'gzip-run', true);
      await assert.rejects(prepareLegacyRestoreSource(roots, target), isBundleLimit);
      await fs.rm(path.join(roots.recordings, ids[0]!), { recursive: true });
      await fs.mkdir(path.join(roots.appData, 'settings'));
      await fs.writeFile(path.join(roots.appData, 'settings', 'environment-variables.json'), ' '.repeat(2 * 1048576));
      await assert.rejects(collectSourceAppSettings(roots.appData, target), isBundleLimit);
      await assert.rejects(prepareLegacyRestoreSource(roots, target), isBundleLimit);
      const catalog = {
        listKeys: () => [],
        read: async () => ({ value: { oversized: 'x'.repeat(2 * 1048576) } }),
      };
      await assert.rejects(collectSourceAppSettings(roots.appData, target, catalog as never), isBundleLimit);
    });
  });
});

function isBundleLimit(error: unknown): boolean {
  assert.equal(localUpgradeFailure('workflows', error).reason, 'source-bundle-limit');
  return true;
}

test('decoded source budget is per bundle, accumulates across files, and isolates concurrent reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-source-budget-'));
  try {
    const file = path.join(root, 'small');
    await fs.writeFile(file, 'x'.repeat(600 * 1024));
    await withEnvOverride('RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB', '1', async () => {
      await Promise.all([
        withLocalSourceBudget(() => readMigrationSourceUtf8(file)),
        withLocalSourceBudget(() => readMigrationSourceUtf8(file)),
      ]);
      await assert.rejects(
        withLocalSourceBudget(async () => {
          await readMigrationSourceUtf8(file);
          await readMigrationSourceUtf8(file);
        }),
        isBundleLimit,
      );
      await withLocalSourceBudget(() => readMigrationSourceUtf8(file), { reuse: true });
      await assert.rejects(
        withLocalSourceBudget(async () => {
          await readMigrationSourceUtf8(file);
          await withLocalSourceBudget(() => readMigrationSourceUtf8(file), { reuse: true });
        }),
        isBundleLimit,
      );
      await fs.writeFile(file, 'x'.repeat(2 * 1048576));
      await assert.rejects(
        withLocalSourceBudget(() => readMigrationSourceUtf8(file)),
        isBundleLimit,
      );
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('legacy gzip bombs are refused by the recording source iterator before payload allocation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-bounded-recording-'));
  try {
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      const bundle = path.join(root, 'project', 'run');
      await fs.mkdir(bundle, { recursive: true });
      await fs.writeFile(getRecordingArtifactPath(bundle, 'recording', 'gzip'), gzipSync('x'.repeat(2 * 1048576)));
      await fs.writeFile(getRecordingArtifactPath(bundle, 'replay-project', 'identity'), '{}');
      await fs.writeFile(
        path.join(bundle, 'metadata.json'),
        JSON.stringify({
          version: 1,
          id: 'run',
          sourceProjectMetadataId: 'project',
          sourceProjectName: 'project',
          sourceProjectPath: '/workflows/project.rivet-project',
          sourceProjectRelativePath: 'project.rivet-project',
          endpointNameAtExecution: 'project',
          createdAt: '2026-01-01T00:00:00.000Z',
          runKind: 'published',
          status: 'succeeded',
          durationMs: 1,
        }),
      );
      await withEnvOverride('RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB', '1', async () => {
        await assert.rejects(iterateSourceRecordings(root, [{ workflowId: 'project' }]).next(), isBundleLimit);
      });
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

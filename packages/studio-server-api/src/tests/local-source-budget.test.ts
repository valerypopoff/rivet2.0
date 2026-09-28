import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { withLocalSourceBudget } from '../local-metadata/source-budget.js';
import { readMigrationSourceUtf8 } from '../scripts/migration-source-utf8.js';
import { iterateSourceRecordings } from '../local-metadata/filesystem-recording-source.js';
import { getRecordingArtifactPath } from '../routes/workflows/recordings-artifacts.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';

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
        /budget/,
      );
      await fs.writeFile(file, 'x'.repeat(2 * 1048576));
      await assert.rejects(
        withLocalSourceBudget(() => readMigrationSourceUtf8(file)),
        /budget/,
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
        await assert.rejects(iterateSourceRecordings(root, [{ workflowId: 'project' }]).next(), /budget/);
      });
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

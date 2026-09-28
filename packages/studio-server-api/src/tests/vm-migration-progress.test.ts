import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readMigrationProgress, recordMigrationProgress } from '../scripts/migration-progress.js';

test('migration receipts survive restart, deduplicate retries and ignore torn appends', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-migration-progress-'));
  const filePath = path.join(root, 'progress.jsonl');
  const previousPath = process.env.RIVET_MIGRATION_PROGRESS_PATH;
  const previousJobId = process.env.RIVET_MIGRATION_PROGRESS_JOB_ID;
  try {
    process.env.RIVET_MIGRATION_PROGRESS_PATH = filePath;
    process.env.RIVET_MIGRATION_PROGRESS_JOB_ID = 'job-a';
    const project = { domain: 'project' as const, id: 'folder/project.rivet-project', sourceHash: 'a'.repeat(64) };
    await recordMigrationProgress(project);
    await recordMigrationProgress(project);
    await recordMigrationProgress({ domain: 'recording', id: 'run-1', sourceHash: 'b'.repeat(64) });
    await fs.appendFile(filePath, '{"jobId":');
    assert.deepEqual(await readMigrationProgress(filePath, 'job-a'), {
      completed: 2,
      byDomain: { project: 1, recording: 1 },
      lastItem: { domain: 'recording', id: 'run-1' },
    });
    await fs.appendFile(filePath, '\n');
    await fs.appendFile(
      filePath,
      `${JSON.stringify({ jobId: 'job-a', domain: '__proto__', id: 'bad', sourceHash: 'd'.repeat(64) })}\n`,
    );
    await recordMigrationProgress({ domain: 'folder', id: 'folder', sourceHash: 'c'.repeat(64) });
    assert.deepEqual(await readMigrationProgress(filePath, 'job-a'), {
      completed: 3,
      byDomain: { project: 1, recording: 1, folder: 1 },
      lastItem: { domain: 'folder', id: 'folder' },
    });
    assert.equal((await readMigrationProgress(filePath, 'job-b')).completed, 0);
  } finally {
    if (previousPath === undefined) delete process.env.RIVET_MIGRATION_PROGRESS_PATH;
    else process.env.RIVET_MIGRATION_PROGRESS_PATH = previousPath;
    if (previousJobId === undefined) delete process.env.RIVET_MIGRATION_PROGRESS_JOB_ID;
    else process.env.RIVET_MIGRATION_PROGRESS_JOB_ID = previousJobId;
    await fs.rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  explainWorkflowRecordingWindow,
  listWorkflowRecordingRunRowsForWorkflowWindow,
  replaceWorkflowRecordingIndex,
  resetWorkflowRecordingDatabaseForTests,
  type WorkflowRecordingRunRow,
} from '../routes/workflows/recordings-db.js';

test('production SQLite listing seeks the composite boundary for all and failed runs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-query-plan-'));
  const previousRoot = process.env.RIVET_APP_DATA_ROOT;
  process.env.RIVET_APP_DATA_ROOT = root;
  try {
    const rows: WorkflowRecordingRunRow[] = Array.from({ length: 100 }, (_, i) => ({
      id: String(i).padStart(3, '0'),
      workflowId: 'workflow',
      createdAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 2)).toISOString(),
      runKind: 'published',
      status: i % 2 ? 'failed' : 'succeeded',
      durationMs: 1,
      endpointNameAtExecution: 'endpoint',
      bundlePath: 'unused',
      encoding: 'gzip',
      hasReplayDataset: false,
      recordingCompressedBytes: 0,
      recordingUncompressedBytes: 0,
      projectCompressedBytes: 0,
      projectUncompressedBytes: 0,
      datasetCompressedBytes: 0,
      datasetUncompressedBytes: 0,
    }));
    await replaceWorkflowRecordingIndex(
      [
        {
          workflowId: 'workflow',
          sourceProjectMetadataId: 'project',
          sourceProjectPath: 'project',
          sourceProjectRelativePath: 'project',
          sourceProjectName: 'project',
          updatedAt: rows[0]!.createdAt,
        },
      ],
      rows,
    );
    for (const statusFilter of ['all', 'failed'] as const) {
      const options = {
        statusFilter,
        offset: 0,
        limit: 5,
        after: { createdAt: rows[50]!.createdAt, recordingId: rows[50]!.id },
      };
      const result = await listWorkflowRecordingRunRowsForWorkflowWindow('workflow', options);
      const expected = rows
        .slice(0, 50)
        .filter((row) => statusFilter === 'all' || row.status === 'failed')
        .reverse()
        .slice(0, 5);
      assert.deepEqual(
        result.map((row) => row.id),
        expected.map((row) => row.id),
      );
      const plan = (await explainWorkflowRecordingWindow('workflow', options)).join('\n');
      assert.match(plan, /USING INDEX idx_recording_runs_workflow_(?:failed_)?created_at_id/);
      assert.match(plan, /\(created_at,id\)<\(\?,\?\)/);
      assert.doesNotMatch(plan, /TEMP B-TREE/);
    }
  } finally {
    await resetWorkflowRecordingDatabaseForTests();
    if (previousRoot == null) delete process.env.RIVET_APP_DATA_ROOT;
    else process.env.RIVET_APP_DATA_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

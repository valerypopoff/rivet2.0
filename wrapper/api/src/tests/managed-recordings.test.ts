import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createManagedWorkflowRecordingService,
  selectManagedRecordingRowsForCleanup,
} from '../routes/workflows/managed/recordings.js';
import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import type { RecordingInsertRowData, RecordingRow, TransactionHooks } from '../routes/workflows/managed/types.js';

function createRecordingRow(
  recordingId: string,
  endpointName: string,
  createdAt: string,
  compressedBytes = 10,
  workflowId = 'workflow-a',
): RecordingRow {
  return {
    recording_id: recordingId,
    workflow_id: workflowId,
    source_project_name: 'Project A',
    source_project_relative_path: 'Project A.rivet-project',
    created_at: createdAt,
    run_kind: 'published',
    status: 'succeeded',
    duration_ms: 1,
    endpoint_name_at_execution: endpointName,
    error_message: null,
    recording_blob_key: `${recordingId}/recording`,
    replay_project_blob_key: `${recordingId}/project`,
    replay_dataset_blob_key: null,
    has_replay_dataset: false,
    recording_compressed_bytes: compressedBytes,
    recording_uncompressed_bytes: compressedBytes,
    project_compressed_bytes: 0,
    project_uncompressed_bytes: 0,
    dataset_compressed_bytes: 0,
    dataset_uncompressed_bytes: 0,
  };
}

test('managed recording retention combines age, endpoint count, and total byte limits', () => {
  const now = Date.parse('2026-08-04T12:00:00.000Z');
  const rows = [
    createRecordingRow('expired', 'Endpoint A', '2026-07-01T00:00:00.000Z', 10),
    createRecordingRow('a-old', ' Endpoint A ', '2026-08-01T00:00:00.000Z', 10),
    createRecordingRow('a-new', 'endpoint a', '2026-08-03T00:00:00.000Z', 10),
    createRecordingRow('b-old', 'Endpoint B', '2026-08-02T00:00:00.000Z', 10),
    createRecordingRow('b-new', 'endpoint b', '2026-08-03T12:00:00.000Z', 10),
  ];

  const selected = selectManagedRecordingRowsForCleanup(rows, {
    retentionDays: 14,
    maxRunsPerEndpoint: 1,
    maxTotalBytes: 15,
  }, now);

  assert.deepEqual(selected.map((row) => row.recording_id), ['expired', 'a-old', 'b-old', 'a-new']);
});

test('managed per-endpoint retention does not combine projects that reused the same slug', () => {
  const rows = [
    createRecordingRow('a-old', 'shared', '2026-08-01T00:00:00.000Z'),
    createRecordingRow('a-new', 'shared', '2026-08-02T00:00:00.000Z'),
    createRecordingRow('b-only', 'shared', '2026-08-01T12:00:00.000Z', 10, 'workflow-b'),
  ];

  const selected = selectManagedRecordingRowsForCleanup(rows, {
    retentionDays: 0,
    maxRunsPerEndpoint: 1,
    maxTotalBytes: 0,
  });

  assert.deepEqual(selected.map((row) => row.recording_id), ['a-old']);
});

test('managed startup cleanup deletes only claimed rows and their blobs', async () => {
  const oldRow = createRecordingRow('old', 'endpoint', '2020-01-01T00:00:00.000Z');
  const currentRow = createRecordingRow('current', 'endpoint', new Date().toISOString());
  const deletedIds: string[] = [];
  const deletedBlobKeys: Array<string | null | undefined> = [];
  const commitTasks: Array<() => Promise<void>> = [];

  const context = {
    pool: {},
    initialize: async () => {},
    withTransaction: async (run: (client: object, hooks: TransactionHooks) => Promise<unknown>) => {
      const result = await run({}, {
        onCommit(task) {
          commitTasks.push(task);
        },
        onRollback() {},
      });
      for (const task of commitTasks.splice(0)) {
        await task();
      }
      return result;
    },
    revisions: {
      uploadRecordingBlobs: async () => ({
        recordingBlobKey: 'recording',
        replayProjectBlobKey: 'project',
        replayDatasetBlobKey: null,
      }),
      insertRecordingRow: async () => {},
      deleteBlobKeysBestEffort: async (_context: string, keys: Array<string | null | undefined>) => {
        deletedBlobKeys.push(...keys);
      },
    },
    db: {
      queryOne: async () => null,
      queryRows: async (_client: object, sql: string, params: unknown[] = []) => {
        if (sql.includes('DELETE FROM workflow_recordings')) {
          const ids = params[0] as string[];
          deletedIds.push(...ids);
          return ids.includes(oldRow.recording_id) ? [oldRow] : [];
        }
        return [oldRow, currentRow];
      },
    },
    blobStore: { getText: async () => '' },
    mappers: {
      getWorkflowStatus: () => 'unpublished',
      mapWorkflowRowToProjectItem: () => ({}),
      toIsoString: (value: unknown) => String(value),
      WORKFLOW_COLUMNS_QUALIFIED: '',
      RECORDING_COLUMNS: 'recording_id',
    },
  } as unknown as ManagedWorkflowContext;

  const service = createManagedWorkflowRecordingService({
    context,
    getRecordingConfig: () => ({
      enabled: true,
      compression: 'gzip',
      gzipLevel: 4,
      maxPendingWrites: 100,
      includePartialOutputs: false,
      includeTrace: false,
      datasetMode: 'none',
      retentionDays: 14,
      maxRunsPerEndpoint: 100,
      maxTotalBytes: 0,
    }),
  });
  await service.initialize();

  assert.deepEqual(deletedIds, ['old']);
  assert.deepEqual(deletedBlobKeys, ['old/recording', 'old/project', null]);
});

test('managed recording imports account for UTF-8 bytes instead of JavaScript characters', async () => {
  const insertedRows: RecordingInsertRowData[] = [];
  const context = {
    pool: {},
    initialize: async () => {},
    withTransaction: async () => {},
    revisions: {
      uploadRecordingBlobs: async () => ({
        recordingBlobKey: 'recording',
        replayProjectBlobKey: 'project',
        replayDatasetBlobKey: null,
      }),
      insertRecordingRow: async (_client: object, row: RecordingInsertRowData) => {
        insertedRows.push(row);
      },
      deleteBlobKeysBestEffort: async () => {},
    },
    db: {
      queryOne: async () => null,
      queryRows: async () => [],
    },
    blobStore: { getText: async () => '' },
    mappers: {
      getWorkflowStatus: () => 'unpublished',
      mapWorkflowRowToProjectItem: () => ({}),
      toIsoString: (value: unknown) => String(value),
      WORKFLOW_COLUMNS_QUALIFIED: '',
      RECORDING_COLUMNS: 'recording_id',
    },
  } as unknown as ManagedWorkflowContext;

  const service = createManagedWorkflowRecordingService({
    context,
    getRecordingConfig: () => ({
      enabled: true,
      compression: 'gzip',
      gzipLevel: 4,
      maxPendingWrites: 100,
      includePartialOutputs: false,
      includeTrace: false,
      datasetMode: 'none',
      retentionDays: 0,
      maxRunsPerEndpoint: 0,
      maxTotalBytes: 0,
    }),
  });
  await service.importWorkflowRecording({
    recordingId: 'unicode',
    workflowId: 'workflow-a',
    sourceProjectName: 'Project A',
    sourceProjectRelativePath: 'Project A.rivet-project',
    createdAt: '2026-08-04T00:00:00.000Z',
    runKind: 'published',
    status: 'succeeded',
    durationMs: 1,
    endpointName: 'endpoint',
    recordingContents: 'é',
    replayProjectContents: 'П',
    replayDatasetContents: null,
  });

  const insertedRow = insertedRows[0];
  assert.ok(insertedRow);
  assert.equal(insertedRow.recordingCompressedBytes, 2);
  assert.equal(insertedRow.projectCompressedBytes, 2);
  assert.equal(insertedRow.datasetCompressedBytes, 0);
});

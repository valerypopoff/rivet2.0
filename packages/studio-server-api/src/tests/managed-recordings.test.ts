import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createManagedWorkflowRecordingService,
  selectManagedRecordingRowsForCleanup,
} from '../routes/workflows/managed/recordings.js';
import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import type {
  ManagedWorkflowMaintenanceLease,
  ManagedWorkflowMaintenanceTask,
} from '../routes/workflows/managed/maintenance.js';
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
    execution_surface: null,
    graph_id_at_execution: null,
    graph_name_at_execution: null,
    revision_key_at_execution: null,
    ui_graph_id_at_execution: null,
    ui_graph_name_at_execution: null,
    web_app_slug_at_execution: null,
    component_id_at_execution: null,
    component_type_at_execution: null,
    component_label_at_execution: null,
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

  const selected = selectManagedRecordingRowsForCleanup(
    rows,
    {
      retentionDays: 14,
      maxRunsPerEndpoint: 1,
      maxTotalBytes: 15,
    },
    now,
  );

  assert.deepEqual(
    selected.map((row) => row.recording_id),
    ['expired', 'a-old', 'b-old', 'a-new'],
  );
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

  assert.deepEqual(
    selected.map((row) => row.recording_id),
    ['a-old'],
  );
});

test('managed recording statistics preserve web-app action identity and run-kind filtering', async () => {
  const webAppRow: RecordingRow = {
    ...createRecordingRow('web-app', '/apps/report', '2026-08-04T12:00:00.000Z'),
    run_kind: 'published',
    execution_surface: 'web_app_action',
    ui_graph_id_at_execution: 'ui-report',
    ui_graph_name_at_execution: 'Report',
    component_id_at_execution: 'generate',
    component_type_at_execution: 'button',
    component_label_at_execution: 'Generate report',
  };
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
      insertRecordingRow: async () => {},
      deleteBlobKeysBestEffort: async () => {},
    },
    db: {
      queryOne: async () => null,
      queryRows: async () => [webAppRow],
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

  const catalog = await service.listWorkflowRunStatisticsCatalog('web_app');

  assert.deepEqual(
    catalog.targets.map((entry) => entry.target),
    [{ surface: 'web_app', workflowId: 'workflow-a', uiGraphId: 'ui-report', componentId: 'generate' }],
  );
  assert.equal(catalog.targets[0]?.componentLabel, 'Generate report');
});

test('managed startup cleanup queues only the bounded claimed recording batch', async () => {
  const oldestRow = createRecordingRow('oldest', 'endpoint', '2019-01-01T00:00:00.000Z');
  const oldRow = createRecordingRow('old', 'endpoint', '2020-01-01T00:00:00.000Z');
  const currentRow = createRecordingRow('current', 'endpoint', new Date().toISOString());
  const deletedIds: string[] = [];
  let retentionQuery: { sql: string; parameters: unknown[] } | undefined;
  const commitTasks: Array<() => Promise<void>> = [];
  let leaseAssertions = 0;
  const maintenanceTasks = new Map<string, ManagedWorkflowMaintenanceTask>();
  const enqueuedObjectKeys: Array<{ domain: string; keys: Array<string | null | undefined> }> = [];
  const lease: ManagedWorkflowMaintenanceLease = {
    holderId: 'test-maintainer',
    fencingToken: 1,
    assertCurrent: async () => {
      leaseAssertions += 1;
    },
  };
  const maintenance = {
    config: { enabled: true, intervalMs: 60_000, leaseMs: 60_000, batchSize: 1 },
    registerTask(name: string, task: ManagedWorkflowMaintenanceTask) {
      maintenanceTasks.set(name, task);
      return () => maintenanceTasks.delete(name);
    },
    enqueueObjectDeletions: async (_client: object, domain: string, keys: Array<string | null | undefined>) => {
      enqueuedObjectKeys.push({ domain, keys });
    },
    initialize: async () => {},
    requestRun: async () => {},
    runNow: async () => {
      for (const task of maintenanceTasks.values()) {
        await task(lease);
      }
    },
    dispose: async () => {},
  };

  const context = {
    pool: {},
    initialize: async () => {},
    withTransaction: async (run: (client: object, hooks: TransactionHooks) => Promise<unknown>) => {
      const result = await run(
        {},
        {
          onCommit(task) {
            commitTasks.push(task);
          },
          onRollback() {},
        },
      );
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
      deleteBlobKeysBestEffort: async () => {},
    },
    db: {
      queryOne: async () => null,
      queryRows: async (_client: object, sql: string, params: unknown[] = []) => {
        if (sql.includes('DELETE FROM workflow_recordings')) {
          const ids = params[0] as string[];
          deletedIds.push(...ids);
          return [oldestRow, oldRow].filter((row) => ids.includes(row.recording_id));
        }
        retentionQuery = { sql, parameters: params };
        return [oldestRow];
      },
    },
    maintenance,
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

  assert.match(retentionQuery?.sql ?? '', /WITH classified/u);
  assert.deepEqual(retentionQuery?.parameters, [14, 100, 1]);
  assert.deepEqual(deletedIds, ['oldest']);
  assert.equal(leaseAssertions, 1);
  assert.deepEqual(enqueuedObjectKeys, [
    {
      domain: 'workflow-recording-retention',
      keys: ['oldest/recording', 'oldest/project', null],
    },
  ]);
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

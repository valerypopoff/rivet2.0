import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { serializeDatasets, serializeProject, type Project } from '@valerypopoff/rivet2-node';
import { type Pool, type PoolClient, type QueryResultRow } from 'pg';

import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunSummary,
  WorkflowRecordingWorkflowListResponse,
} from '../../../../../shared/workflow-recording-types.js';
import { WORKFLOW_PROJECT_EXTENSION } from '../../../../../shared/workflow-types.js';
import { createHttpError } from '../../../utils/httpError.js';
import { parseManagedWorkflowProjectVirtualPath } from '../virtual-paths.js';
import type { ManagedWorkflowBlobStore } from './blob-store.js';
import type { ManagedWorkflowContext } from './context.js';
import type {
  ImportManagedWorkflowRecordingOptions,
  PersistWorkflowExecutionRecordingOptions,
  RecordingBlobArtifacts,
  RecordingBlobKeys,
  RecordingInsertRowData,
  RecordingRow,
  TransactionHooks,
  WorkflowRecordingListRow,
  WorkflowRow,
} from './types.js';
import { filterRowsBySerializedRecordingInputPage } from '../recording-input-filter.js';

type ManagedWorkflowRecordingServiceDependencies = {
  context: ManagedWorkflowContext;
};

async function filterManagedRecordingRowsByInput(
  rows: RecordingRow[],
  inputFilter: WorkflowRecordingInputFilter,
  blobStore: ManagedWorkflowBlobStore,
  inputCursor: number,
  pageSize: number,
  signal?: AbortSignal,
) {
  return filterRowsBySerializedRecordingInputPage(
    rows,
    inputFilter,
    (row) => blobStore.getText(row.recording_blob_key),
    {
      cursor: inputCursor,
      pageSize,
      signal,
    },
  );
}

export function createManagedWorkflowRecordingService(options: ManagedWorkflowRecordingServiceDependencies) {
  const deps = {
    pool: options.context.pool,
    initialize: options.context.initialize,
    withTransaction: options.context.withTransaction,
    uploadRecordingBlobs: options.context.revisions.uploadRecordingBlobs,
    insertRecordingRow: options.context.revisions.insertRecordingRow,
    queryOne: options.context.db.queryOne,
    queryRows: options.context.db.queryRows,
    blobStore: options.context.blobStore,
    deleteBlobKeysBestEffort: options.context.revisions.deleteBlobKeysBestEffort,
    getWorkflowStatus: options.context.mappers.getWorkflowStatus,
    mapWorkflowRowToProjectItem: options.context.mappers.mapWorkflowRowToProjectItem,
    toIsoString: options.context.mappers.toIsoString,
    workflowColumnsQualified: options.context.mappers.WORKFLOW_COLUMNS_QUALIFIED,
    recordingColumns: options.context.mappers.RECORDING_COLUMNS,
  };

  return {
    async importWorkflowRecording(options: ImportManagedWorkflowRecordingOptions): Promise<void> {
      await deps.initialize();

      const createdAt = options.createdAt.trim() || new Date().toISOString();
      const existingRecording = await deps.queryOne<{ recording_id: string }>(
        deps.pool,
        'SELECT recording_id FROM workflow_recordings WHERE recording_id = $1',
        [options.recordingId],
      );
      if (existingRecording) {
        return;
      }

      const uploadedBlobs = await deps.uploadRecordingBlobs(
        options.workflowId,
        options.recordingId,
        {
          recording: options.recordingContents,
          replayProject: options.replayProjectContents,
          replayDataset: options.replayDatasetContents,
        },
        'recording import upload failure',
      );

      await deps.insertRecordingRow(
        deps.pool,
        {
          recordingId: options.recordingId,
          workflowId: options.workflowId,
          sourceProjectName: options.sourceProjectName,
          sourceProjectRelativePath: options.sourceProjectRelativePath,
          runKind: options.runKind,
          status: options.status,
          durationMs: Math.max(0, Math.round(options.durationMs)),
          endpointNameAtExecution: options.endpointName,
          errorMessage: options.errorMessage ?? null,
          recordingBlobKey: uploadedBlobs.recordingBlobKey,
          replayProjectBlobKey: uploadedBlobs.replayProjectBlobKey,
          replayDatasetBlobKey: uploadedBlobs.replayDatasetBlobKey,
          hasReplayDataset: Boolean(uploadedBlobs.replayDatasetBlobKey),
          recordingCompressedBytes: options.recordingContents.length,
          recordingUncompressedBytes: options.recordingContents.length,
          projectCompressedBytes: options.replayProjectContents.length,
          projectUncompressedBytes: options.replayProjectContents.length,
          datasetCompressedBytes: options.replayDatasetContents?.length ?? 0,
          datasetUncompressedBytes: options.replayDatasetContents?.length ?? 0,
        },
        {
          timestampMode: 'provided',
          createdAt,
          onConflict: 'ignore',
          cleanupContext: 'recording import failure',
        },
      );
    },

    async listWorkflowRecordingWorkflows(): Promise<WorkflowRecordingWorkflowListResponse> {
      await deps.initialize();
      const rows = await deps.queryRows<WorkflowRecordingListRow>(
        deps.pool,
        `
          SELECT ${deps.workflowColumnsQualified},
                 r.total_runs, r.failed_runs, r.suspicious_runs, r.latest_run_at
          FROM workflows w
          LEFT JOIN (
            SELECT workflow_id,
                   COUNT(*)::int AS total_runs,
                   COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
                   COUNT(*) FILTER (WHERE status = 'suspicious')::int AS suspicious_runs,
                   MAX(created_at) AS latest_run_at
            FROM workflow_recordings
            GROUP BY workflow_id
          ) r ON r.workflow_id = w.workflow_id
          ORDER BY w.relative_path ASC
        `,
      );

      const workflows = rows
        .filter((row) => (row.total_runs ?? 0) > 0 || (deps.getWorkflowStatus(row) !== 'unpublished' && Boolean(row.endpoint_name)))
        .map((row) => ({
          workflowId: row.workflow_id,
          project: deps.mapWorkflowRowToProjectItem(row),
          latestRunAt: deps.toIsoString(row.latest_run_at) ?? undefined,
          totalRuns: row.total_runs ?? 0,
          failedRuns: row.failed_runs ?? 0,
          suspiciousRuns: row.suspicious_runs ?? 0,
        }))
        .sort((left, right) => {
          const latestLeft = left.latestRunAt ?? '';
          const latestRight = right.latestRunAt ?? '';
          if (latestLeft && latestRight && latestLeft !== latestRight) {
            return latestRight.localeCompare(latestLeft);
          }

          if (latestLeft && !latestRight) {
            return -1;
          }

          if (!latestLeft && latestRight) {
            return 1;
          }

          return left.project.name.localeCompare(right.project.name);
        });

      return { workflows };
    },

    async listWorkflowRecordingRunsPage(
      workflowId: string,
      page: number,
      pageSize: number,
      statusFilter: WorkflowRecordingFilterStatus,
      inputFilter: WorkflowRecordingInputFilter | null = null,
      inputCursor = 0,
      signal?: AbortSignal,
    ): Promise<WorkflowRecordingRunsPageResponse> {
      await deps.initialize();
      const normalizedPage = Math.max(1, Math.floor(page));
      const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
      const offset = (normalizedPage - 1) * normalizedPageSize;
      const filterClause = statusFilter === 'failed'
        ? `AND status IN ('failed', 'suspicious')`
        : '';

      const countRow = inputFilter
        ? null
        : await deps.queryOne<{ total_runs: number }>(
          deps.pool,
          `SELECT COUNT(*)::int AS total_runs FROM workflow_recordings WHERE workflow_id = $1 ${filterClause}`,
          [workflowId],
        );
      const rows = await deps.queryRows<RecordingRow>(
        deps.pool,
        inputFilter
          ? `
            SELECT ${deps.recordingColumns}
            FROM workflow_recordings
            WHERE workflow_id = $1 ${filterClause}
            ORDER BY created_at DESC, recording_id DESC
          `
          : `
            SELECT ${deps.recordingColumns}
            FROM workflow_recordings
            WHERE workflow_id = $1 ${filterClause}
            ORDER BY created_at DESC, recording_id DESC
            LIMIT $2 OFFSET $3
          `,
        inputFilter ? [workflowId] : [workflowId, normalizedPageSize, offset],
      );
      const filteredPage = inputFilter
        ? await filterManagedRecordingRowsByInput(rows, inputFilter, deps.blobStore, inputCursor, normalizedPageSize, signal)
        : null;
      const pageRows = filteredPage?.rows ?? rows;

      const runs: WorkflowRecordingRunSummary[] = pageRows.map((row) => ({
        id: row.recording_id,
        workflowId: row.workflow_id,
        createdAt: deps.toIsoString(row.created_at) ?? new Date().toISOString(),
        runKind: row.run_kind,
        status: row.status,
        durationMs: row.duration_ms,
        endpointNameAtExecution: row.endpoint_name_at_execution,
        errorMessage: row.error_message ?? undefined,
        hasReplayDataset: row.has_replay_dataset,
        recordingCompressedBytes: row.recording_compressed_bytes,
        recordingUncompressedBytes: row.recording_uncompressed_bytes,
        projectCompressedBytes: row.project_compressed_bytes,
        projectUncompressedBytes: row.project_uncompressed_bytes,
        datasetCompressedBytes: row.dataset_compressed_bytes,
        datasetUncompressedBytes: row.dataset_uncompressed_bytes,
      }));

      return {
        workflowId,
        page: normalizedPage,
        pageSize: normalizedPageSize,
        totalRuns: filteredPage?.totalRuns ?? countRow?.total_runs ?? 0,
        totalRunsExact: filteredPage?.totalRunsExact ?? true,
        hasMore: filteredPage?.hasMore ?? normalizedPage * normalizedPageSize < (countRow?.total_runs ?? 0),
        nextInputCursor: filteredPage?.nextInputCursor,
        statusFilter,
        inputFilter,
        runs,
      };
    },

    async readWorkflowRecordingArtifact(recordingId: string, artifact: 'recording' | 'replay-project' | 'replay-dataset'): Promise<string> {
      await deps.initialize();
      const row = await deps.queryOne<RecordingRow>(
        deps.pool,
        `
          SELECT ${deps.recordingColumns}
          FROM workflow_recordings
          WHERE recording_id = $1
        `,
        [recordingId],
      );
      if (!row) {
        throw createHttpError(404, 'Recording not found');
      }

      if (artifact === 'replay-dataset' && !row.replay_dataset_blob_key) {
        throw createHttpError(404, 'Replay dataset not found');
      }

      return artifact === 'recording'
        ? deps.blobStore.getText(row.recording_blob_key)
        : artifact === 'replay-project'
          ? deps.blobStore.getText(row.replay_project_blob_key)
          : deps.blobStore.getText(row.replay_dataset_blob_key!);
    },

    async deleteWorkflowRecording(recordingId: string): Promise<void> {
      await deps.withTransaction(async (client, hooks) => {
        const row = await deps.queryOne<RecordingRow>(
          client,
          `
            SELECT ${deps.recordingColumns}
            FROM workflow_recordings
            WHERE recording_id = $1
            FOR UPDATE
          `,
          [recordingId],
        );
        if (!row) {
          throw createHttpError(404, 'Recording not found');
        }

        await client.query('DELETE FROM workflow_recordings WHERE recording_id = $1', [recordingId]);
        hooks.onCommit(() => deps.deleteBlobKeysBestEffort(
          `recording deletion (${recordingId})`,
          [row.recording_blob_key, row.replay_project_blob_key, row.replay_dataset_blob_key],
        ));
      });
    },

    async persistWorkflowExecutionRecording(options: PersistWorkflowExecutionRecordingOptions): Promise<void> {
      await deps.initialize();

      const workflowId = options.sourceProject.metadata.id;
      if (!workflowId) {
        return;
      }

      const recordingId = `${Date.now()}-${randomUUID()}`;
      const replayProject: Project = {
        ...options.executedProject,
        metadata: {
          ...options.executedProject.metadata,
          id: randomUUID() as Project['metadata']['id'],
        },
      };
      const replayProjectSerialized = serializeProject(replayProject, options.executedAttachedData);
      if (typeof replayProjectSerialized !== 'string') {
        throw new Error('Serialized replay project is not a string');
      }

      const replayDatasetSerialized = options.executedDatasets.length > 0
        ? serializeDatasets(options.executedDatasets)
        : null;
      const uploadedBlobs = await deps.uploadRecordingBlobs(
        workflowId,
        recordingId,
        {
          recording: options.recordingSerialized,
          replayProject: replayProjectSerialized,
          replayDataset: replayDatasetSerialized,
        },
        'recording persistence upload failure',
      );

      await deps.insertRecordingRow(
        deps.pool,
        {
          recordingId,
          workflowId,
          sourceProjectName: path.posix.basename(options.sourceProjectPath, WORKFLOW_PROJECT_EXTENSION),
          sourceProjectRelativePath: parseManagedWorkflowProjectVirtualPath(options.sourceProjectPath),
          runKind: options.runKind,
          status: options.status,
          durationMs: Math.max(0, Math.round(options.durationMs)),
          endpointNameAtExecution: options.endpointName,
          errorMessage: options.errorMessage ?? null,
          recordingBlobKey: uploadedBlobs.recordingBlobKey,
          replayProjectBlobKey: uploadedBlobs.replayProjectBlobKey,
          replayDatasetBlobKey: uploadedBlobs.replayDatasetBlobKey,
          hasReplayDataset: Boolean(uploadedBlobs.replayDatasetBlobKey),
          recordingCompressedBytes: options.recordingSerialized.length,
          recordingUncompressedBytes: options.recordingSerialized.length,
          projectCompressedBytes: replayProjectSerialized.length,
          projectUncompressedBytes: replayProjectSerialized.length,
          datasetCompressedBytes: replayDatasetSerialized?.length ?? 0,
          datasetUncompressedBytes: replayDatasetSerialized?.length ?? 0,
        },
        {
          timestampMode: 'now',
          onConflict: 'fail',
          cleanupContext: 'recording persistence failure',
        },
      );
    },
  };
}

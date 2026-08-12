import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { serializeDatasets, serializeProject, type Project } from '@valerypopoff/rivet2-node';

import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunSummary,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRunStatisticsCatalogResponse,
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsSurface,
  WorkflowRunStatisticsTarget,
} from '../../../../../shared/workflow-recording-types.js';
import { WORKFLOW_PROJECT_EXTENSION } from '../../../../../shared/workflow-types.js';
import { createHttpError } from '../../../utils/httpError.js';
import { getWorkflowRecordingConfig, type WorkflowRecordingConfig } from '../recordings-config.js';
import { parseManagedWorkflowProjectVirtualPath } from '../virtual-paths.js';
import type { ManagedWorkflowBlobStore } from './blob-store.js';
import type { ManagedWorkflowContext } from './context.js';
import type {
  ImportManagedWorkflowRecordingOptions,
  PersistWorkflowExecutionRecordingOptions,
  RecordingRow,
  WorkflowRecordingListRow,
} from './types.js';
import { filterRowsBySerializedRecordingInputPage } from '../recording-input-filter.js';
import {
  buildWorkflowRunStatistics,
  buildWorkflowRunStatisticsCatalog,
  type WorkflowRecordingStatisticsRow,
} from '../recording-statistics.js';

type ManagedWorkflowRecordingServiceDependencies = {
  context: ManagedWorkflowContext;
  getRecordingConfig?: () => WorkflowRecordingConfig;
};

type ManagedRecordingRetentionConfig = Pick<
  WorkflowRecordingConfig,
  'retentionDays' | 'maxRunsPerEndpoint' | 'maxTotalBytes'
>;

const DAY_MS = 24 * 60 * 60 * 1000;

function getEndpointRetentionKey(row: RecordingRow): string {
  return `${row.workflow_id}\0${row.endpoint_name_at_execution.trim().toLowerCase()}`;
}

function getCompressedBundleSize(row: RecordingRow): number {
  return row.recording_compressed_bytes + row.project_compressed_bytes + row.dataset_compressed_bytes;
}

function getCreatedAtMs(row: RecordingRow): number {
  const timestamp = row.created_at instanceof Date
    ? row.created_at.getTime()
    : Date.parse(String(row.created_at));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getExecutionIdentity(row: RecordingRow) {
  if (row.execution_surface !== 'workflow_endpoint' && row.execution_surface !== 'web_app_action') {
    return undefined;
  }

  return {
    surface: row.execution_surface,
    graphId: row.graph_id_at_execution ?? undefined,
    graphName: row.graph_name_at_execution ?? undefined,
    revisionKey: row.revision_key_at_execution ?? undefined,
    uiGraphId: row.ui_graph_id_at_execution ?? undefined,
    uiGraphName: row.ui_graph_name_at_execution ?? undefined,
    webAppSlug: row.web_app_slug_at_execution ?? undefined,
    componentId: row.component_id_at_execution ?? undefined,
    componentType: row.component_type_at_execution ?? undefined,
    componentLabel: row.component_label_at_execution ?? undefined,
  } as const;
}

function getManagedStatisticsTargetClause(target: WorkflowRunStatisticsTarget | undefined): {
  clause: string;
  parameters: string[];
} {
  if (!target) return { clause: '', parameters: [] };
  if (target.surface === 'endpoint') {
    return {
      clause: `AND workflow_id = $3
        AND (execution_surface = 'workflow_endpoint'
          OR (execution_surface IS NULL AND endpoint_name_at_execution NOT LIKE '/%'))`,
      parameters: [target.workflowId],
    };
  }
  if ('legacyEndpointName' in target) {
    return {
      clause: `AND workflow_id = $3
        AND (
          execution_surface IS NULL
          OR (
            execution_surface = 'web_app_action'
            AND (ui_graph_id_at_execution IS NULL OR component_id_at_execution IS NULL)
          )
        )
        AND endpoint_name_at_execution = $4`,
      parameters: [target.workflowId, target.legacyEndpointName],
    };
  }
  return {
    clause: `AND workflow_id = $3
      AND execution_surface = 'web_app_action'
      AND ui_graph_id_at_execution = $4
      AND component_id_at_execution = $5`,
    parameters: [target.workflowId, target.uiGraphId, target.componentId],
  };
}

function toStatisticsRow(row: RecordingRow, toIsoString: (value: Date | string | null | undefined) => string | null): WorkflowRecordingStatisticsRow {
  return {
    workflowId: row.workflow_id,
    sourceProjectName: row.source_project_name,
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    runKind: row.run_kind,
    status: row.status,
    durationMs: row.duration_ms,
    endpointNameAtExecution: row.endpoint_name_at_execution,
    executionIdentity: getExecutionIdentity(row),
  };
}

export function selectManagedRecordingRowsForCleanup(
  rows: RecordingRow[],
  config: ManagedRecordingRetentionConfig,
  now = Date.now(),
): RecordingRow[] {
  const oldestRows = [...rows].sort((left, right) => {
    const createdAtDifference = getCreatedAtMs(left) - getCreatedAtMs(right);
    return createdAtDifference || left.recording_id.localeCompare(right.recording_id);
  });
  const rowsToDelete = new Map<string, RecordingRow>();

  if (config.retentionDays > 0) {
    const cutoff = now - config.retentionDays * DAY_MS;
    for (const row of oldestRows) {
      if (getCreatedAtMs(row) < cutoff) {
        rowsToDelete.set(row.recording_id, row);
      }
    }
  }

  if (config.maxRunsPerEndpoint > 0) {
    const rowsByEndpoint = new Map<string, RecordingRow[]>();
    for (const row of oldestRows) {
      if (rowsToDelete.has(row.recording_id)) {
        continue;
      }

      const endpointKey = getEndpointRetentionKey(row);
      const endpointRows = rowsByEndpoint.get(endpointKey) ?? [];
      endpointRows.push(row);
      rowsByEndpoint.set(endpointKey, endpointRows);
    }

    for (const endpointRows of rowsByEndpoint.values()) {
      const excessCount = endpointRows.length - config.maxRunsPerEndpoint;
      for (const row of endpointRows.slice(0, Math.max(0, excessCount))) {
        rowsToDelete.set(row.recording_id, row);
      }
    }
  }

  if (config.maxTotalBytes > 0) {
    let retainedBytes = oldestRows.reduce((total, row) => total + getCompressedBundleSize(row), 0);
    for (const row of rowsToDelete.values()) {
      retainedBytes -= getCompressedBundleSize(row);
    }

    for (const row of oldestRows) {
      if (retainedBytes <= config.maxTotalBytes) {
        break;
      }
      if (rowsToDelete.has(row.recording_id)) {
        continue;
      }

      rowsToDelete.set(row.recording_id, row);
      retainedBytes -= getCompressedBundleSize(row);
    }
  }

  return [...rowsToDelete.values()];
}

function getUtf8ByteLength(value: string | null | undefined): number {
  return value == null ? 0 : Buffer.byteLength(value, 'utf8');
}

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
  let initialCleanupPromise: Promise<void> | null = null;

  const cleanupWorkflowRecordingStorage = async (workflowId?: string, endpointName?: string): Promise<void> => {
    const config = options.getRecordingConfig?.() ?? getWorkflowRecordingConfig();
    if (config.retentionDays <= 0 && config.maxRunsPerEndpoint <= 0 && config.maxTotalBytes <= 0) {
      return;
    }

    const cutoff = config.retentionDays > 0
      ? new Date(Date.now() - config.retentionDays * DAY_MS).toISOString()
      : null;
    const normalizedEndpointName = endpointName?.trim().toLowerCase() || null;
    const endpointScoped = Boolean(workflowId && normalizedEndpointName);
    const rows = await deps.queryRows<RecordingRow>(
      deps.pool,
      config.maxTotalBytes > 0 || !endpointScoped
        ? `SELECT ${deps.recordingColumns} FROM workflow_recordings ORDER BY created_at ASC, recording_id ASC`
        : `
          SELECT ${deps.recordingColumns}
          FROM workflow_recordings
          WHERE ($1::timestamptz IS NOT NULL AND created_at < $1::timestamptz)
             OR (workflow_id = $2 AND LOWER(BTRIM(endpoint_name_at_execution)) = $3)
          ORDER BY created_at ASC, recording_id ASC
        `,
      config.maxTotalBytes > 0 || !endpointScoped ? [] : [cutoff, workflowId, normalizedEndpointName],
    );
    const rowsToDelete = selectManagedRecordingRowsForCleanup(rows, config);
    if (rowsToDelete.length === 0) {
      return;
    }

    const recordingIds = rowsToDelete.map((row) => row.recording_id);
    await deps.withTransaction(async (client, hooks) => {
      const deletedRows = await deps.queryRows<RecordingRow>(
        client,
        `
          DELETE FROM workflow_recordings
          WHERE recording_id = ANY($1::text[])
          RETURNING ${deps.recordingColumns}
        `,
        [recordingIds],
      );
      if (deletedRows.length > 0) {
        hooks.onCommit(() => deps.deleteBlobKeysBestEffort(
          `recording retention cleanup (${deletedRows.length} recordings)`,
          deletedRows.flatMap((row) => [
            row.recording_blob_key,
            row.replay_project_blob_key,
            row.replay_dataset_blob_key,
          ]),
        ));
      }
    });
  };

  const cleanupAfterWrite = async (workflowId: string, endpointName: string): Promise<void> => {
    try {
      await cleanupWorkflowRecordingStorage(workflowId, endpointName);
    } catch (error) {
      console.error('[workflow-recordings] Managed recording cleanup failed:', error);
    }
  };

  return {
    async initialize(): Promise<void> {
      await deps.initialize();
      initialCleanupPromise ??= cleanupWorkflowRecordingStorage().catch((error) => {
        console.error('[workflow-recordings] Managed startup cleanup failed:', error);
      });
      await initialCleanupPromise;
    },

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
          executionIdentity: options.executionIdentity,
          errorMessage: options.errorMessage ?? null,
          recordingBlobKey: uploadedBlobs.recordingBlobKey,
          replayProjectBlobKey: uploadedBlobs.replayProjectBlobKey,
          replayDatasetBlobKey: uploadedBlobs.replayDatasetBlobKey,
          hasReplayDataset: Boolean(uploadedBlobs.replayDatasetBlobKey),
          recordingCompressedBytes: getUtf8ByteLength(options.recordingContents),
          recordingUncompressedBytes: getUtf8ByteLength(options.recordingContents),
          projectCompressedBytes: getUtf8ByteLength(options.replayProjectContents),
          projectUncompressedBytes: getUtf8ByteLength(options.replayProjectContents),
          datasetCompressedBytes: getUtf8ByteLength(options.replayDatasetContents),
          datasetUncompressedBytes: getUtf8ByteLength(options.replayDatasetContents),
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
        executionIdentity: getExecutionIdentity(row),
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

    async listWorkflowRunStatisticsCatalog(
      surface: WorkflowRunStatisticsSurface,
    ): Promise<WorkflowRunStatisticsCatalogResponse> {
      await deps.initialize();
      const rows = await deps.queryRows<RecordingRow>(
        deps.pool,
        `
          SELECT ${deps.recordingColumns}
          FROM workflow_recordings
          ORDER BY created_at ASC, recording_id ASC
        `,
        [],
      );
      return buildWorkflowRunStatisticsCatalog(
        rows.map((row) => toStatisticsRow(row, deps.toIsoString)),
        surface,
      );
    },

    async getWorkflowRunStatistics(query: WorkflowRunStatisticsQuery): Promise<WorkflowRunStatisticsResponse> {
      await deps.initialize();
      const target = getManagedStatisticsTargetClause(query.target);
      const rows = await deps.queryRows<RecordingRow>(
        deps.pool,
        `
          SELECT ${deps.recordingColumns}
          FROM workflow_recordings
          WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
          ${target.clause}
          ORDER BY created_at ASC, recording_id ASC
        `,
        [query.period.from, query.period.to, ...target.parameters],
      );
      return buildWorkflowRunStatistics(rows.map((row) => toStatisticsRow(row, deps.toIsoString)), query);
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
          executionIdentity: options.executionIdentity,
          errorMessage: options.errorMessage ?? null,
          recordingBlobKey: uploadedBlobs.recordingBlobKey,
          replayProjectBlobKey: uploadedBlobs.replayProjectBlobKey,
          replayDatasetBlobKey: uploadedBlobs.replayDatasetBlobKey,
          hasReplayDataset: Boolean(uploadedBlobs.replayDatasetBlobKey),
          recordingCompressedBytes: getUtf8ByteLength(options.recordingSerialized),
          recordingUncompressedBytes: getUtf8ByteLength(options.recordingSerialized),
          projectCompressedBytes: getUtf8ByteLength(replayProjectSerialized),
          projectUncompressedBytes: getUtf8ByteLength(replayProjectSerialized),
          datasetCompressedBytes: getUtf8ByteLength(replayDatasetSerialized),
          datasetUncompressedBytes: getUtf8ByteLength(replayDatasetSerialized),
        },
        {
          timestampMode: 'now',
          onConflict: 'fail',
          cleanupContext: 'recording persistence failure',
        },
      );
      await cleanupAfterWrite(workflowId, options.endpointName);
    },

    async cleanupWorkflowRecordingStorage(): Promise<void> {
      await deps.initialize();
      await cleanupWorkflowRecordingStorage();
    },
  };
}

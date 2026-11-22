import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  readScheduledRecordingFields,
  readWorkflowRunCost,
} from '../../../../../studio-server-shared/workflow-recording-types.js';
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
} from '../../../../../studio-server-shared/workflow-recording-types.js';
import { WORKFLOW_PROJECT_EXTENSION } from '../../../../../studio-server-shared/workflow-types.js';
import { createHttpError } from '../../../utils/httpError.js';
import { normalizeRivetCorrelationId } from '../../../request-correlation.js';
import {
  recordingHasSubRunsSql,
  recordingWorkflowScopeClause,
  type RecordingRunScope,
} from '../recording-workflow-scope.js';
import type { WorkflowRecordingConfig } from '../recordings-config.js';
import { notifyRecordingPersisted } from '../recording-diagnostics.js';
import { parseManagedWorkflowProjectVirtualPath } from '../virtual-paths.js';
import { parseManagedArtifactDescriptor } from './artifact-descriptor.js';
import {
  isMissingManagedWorkflowObject,
  isRecordingProjectSnapshotKey,
  type ManagedWorkflowBlobStore,
} from './blob-store.js';
import { readSharedRecordingProject } from './recording-project-snapshots.js';
import type { ManagedWorkflowContext } from './context.js';
import { createManagedRecordingRetentionTask } from './recording-retention.js';
export { selectManagedRecordingRowsForCleanup } from './recording-retention.js';
import type {
  ImportManagedWorkflowRecordingOptions,
  PersistWorkflowExecutionRecordingOptions,
  RecordingRow,
  WorkflowRecordingListRow,
} from './types.js';
import {
  createWorkflowRecordingInputAfter,
  filterRecordingInputWindows,
  isRequestIdInputFilter,
  matchesWorkflowRecordingInputFilter,
  observeRecordingInputQuery,
  parseWorkflowRecordingInputAfter,
} from '../recording-input-filter.js';
import { getManagedRecordingInputCacheKey, workflowRecordingInputCache } from '../recording-input-cache.js';
import { buildWorkflowRunStatistics, buildWorkflowRunStatisticsCatalog } from '../recording-statistics.js';
import type { ManagedRecordingEvidence } from './recording-evidence.js';
import { listRecordingHistory } from './recording-history.js';
import type { WorkflowRecordingPageQuery } from '../data-backend.js';
import {
  recordingStatisticsCatalogSql,
  recordingStatisticsIncompleteSql,
  recordingStatisticsRowsSql,
  statisticsSqlRow,
  type RecordingStatisticsSqlRow,
} from '../recording-statistics-sql.js';

type ManagedWorkflowRecordingServiceDependencies = {
  context: ManagedWorkflowContext;
  evidence?: ManagedRecordingEvidence;
  getRecordingConfig?: () => WorkflowRecordingConfig;
};

type RecordingInputCandidate = Pick<
  RecordingRow,
  | 'recording_id'
  | 'workflow_id'
  | 'created_at'
  | 'recording_cursor_created_at'
  | 'status'
  | 'execution_surface'
  | 'recording_blob_key'
  | 'recording_compressed_bytes'
  | 'recording_uncompressed_bytes'
>;

function getRecordingCursorCreatedAt(row: Pick<RecordingRow, 'created_at' | 'recording_cursor_created_at'>): string {
  // node-postgres turns `timestamptz` into a JavaScript Date, which removes
  // microseconds. A keyset boundary has to keep the exact selected timestamp
  // or recordings written by `NOW()` can be skipped at the same millisecond.
  if (
    typeof row.recording_cursor_created_at === 'string' &&
    Number.isFinite(Date.parse(row.recording_cursor_created_at))
  ) {
    return row.recording_cursor_created_at;
  }
  return row.created_at instanceof Date ? row.created_at.toISOString() : new Date(String(row.created_at)).toISOString();
}

function getExecutionIdentity(row: RecordingRow) {
  if (
    row.execution_surface !== 'workflow_endpoint' &&
    row.execution_surface !== 'web_app_action' &&
    row.execution_surface !== 'editor_local' &&
    row.execution_surface !== 'subgraph_project' &&
    row.execution_surface !== 'scheduled'
  ) {
    return undefined;
  }

  return {
    surface: row.execution_surface,
    ...readScheduledRecordingFields(row.scheduled_identity_json),
    graphId: row.graph_id_at_execution ?? undefined,
    graphName: row.graph_name_at_execution ?? undefined,
    revisionKey: row.revision_key_at_execution ?? undefined,
    uiGraphId: row.ui_graph_id_at_execution ?? undefined,
    uiGraphName: row.ui_graph_name_at_execution ?? undefined,
    webAppSlug: row.web_app_slug_at_execution ?? undefined,
    componentId: row.component_id_at_execution ?? undefined,
    componentType: row.component_type_at_execution ?? undefined,
    componentLabel: row.component_label_at_execution ?? undefined,
    correlationId: normalizeRivetCorrelationId(row.correlation_id) ?? undefined,
  } as const;
}

function getUtf8ByteLength(value: string | null | undefined): number {
  return value == null ? 0 : Buffer.byteLength(value, 'utf8');
}

function getStoredByteLength(key: string | null, text: string | null | undefined): number {
  return key ? parseManagedArtifactDescriptor(key)?.storedBytes ?? getUtf8ByteLength(text) : 0;
}

async function readManagedRecordingInput(
  row: RecordingInputCandidate,
  inputFilter: WorkflowRecordingInputFilter,
  blobStore: ManagedWorkflowBlobStore,
  signal?: AbortSignal,
) {
  const key = row.recording_blob_key;
  return workflowRecordingInputCache.getOrLoad(
    getManagedRecordingInputCacheKey(blobStore, key),
    async (cacheSignal) => {
      const descriptor = blobStore.getBytes ? parseManagedArtifactDescriptor(key) : null;
      return {
        kind: 'artifact' as const,
        bytes: blobStore.getBytes
          ? await blobStore.getBytes(key, { signal: cacheSignal })
          : Buffer.from(await blobStore.getText(key, { signal: cacheSignal }), 'utf8'),
        encoding: descriptor?.encoding ?? 'identity',
        ...(descriptor ? { decodedBytes: descriptor.decodedBytes } : {}),
      };
    },
    signal,
    Math.max(row.recording_compressed_bytes, row.recording_uncompressed_bytes) * 6,
    {
      requestIdOnly: isRequestIdInputFilter(inputFilter),
      immutable: !!blobStore.getBytes && parseManagedArtifactDescriptor(key) != null,
    },
  );
}

function sameRecordingIdentity(left: RecordingInputCandidate, right: RecordingInputCandidate): boolean {
  return (
    left.recording_id === right.recording_id &&
    left.workflow_id === right.workflow_id &&
    getRecordingCursorCreatedAt(left) === getRecordingCursorCreatedAt(right)
  );
}

async function filterManagedRecordingRowsByInput(
  loadWindow: (after: string | undefined, offset: number, limit: number) => Promise<RecordingInputCandidate[]>,
  workflowId: string,
  statusFilter: WorkflowRecordingFilterStatus,
  inputFilter: WorkflowRecordingInputFilter,
  blobStore: ManagedWorkflowBlobStore,
  inputCursor: number,
  inputAfterCursor: ReturnType<typeof parseWorkflowRecordingInputAfter>,
  inputAfter: string | undefined,
  pageSize: number,
  signal?: AbortSignal,
  includeSubgraphRuns = false,
  reload?: (row: RecordingInputCandidate, signal: AbortSignal) => Promise<RecordingInputCandidate | null | undefined>,
) {
  const replacements = new Map<string, RecordingInputCandidate>();
  const result = await filterRecordingInputWindows(
    inputFilter,
    loadWindow,
    async (row, readSignal) => {
      try {
        return await readManagedRecordingInput(row, inputFilter, blobStore, readSignal);
      } catch (error) {
        if (!reload || !isMissingManagedWorkflowObject(error)) throw error;
        const current = await reload(row, readSignal);
        if (!current || !sameRecordingIdentity(row, current)) return { exists: false, value: undefined };
        if (current.recording_blob_key === row.recording_blob_key) throw error;
        const input = await readManagedRecordingInput(current, inputFilter, blobStore, readSignal);
        replacements.set(row.recording_id, current);
        return input;
      }
    },
    {
      inputCursor: inputAfterCursor?.legacyCursor ?? inputCursor,
      inputAfter,
      pageSize,
      getInputAfter: (row, nextInputCursor) =>
        createWorkflowRecordingInputAfter(
          {
            createdAt: getRecordingCursorCreatedAt(row),
            recordingId: row.recording_id,
            legacyCursor: nextInputCursor,
          },
          { workflowId, statusFilter, filter: inputFilter, includeSubgraphRuns },
        ),
      signal,
    },
  );
  return { ...result, rows: result.rows.map((row) => replacements.get(row.recording_id) ?? row) };
}

export function createManagedWorkflowRecordingService(options: ManagedWorkflowRecordingServiceDependencies) {
  const evidence = options.evidence;
  const deps = {
    pool: options.context.pool,
    initialize: options.context.initialize,
    withTransaction: options.context.withTransaction,
    uploadRecordingBlobs: options.context.revisions.uploadRecordingBlobs,
    insertRecordingRow: options.context.revisions.insertRecordingRow,
    queryOne: options.context.db.queryOne,
    queryRows: options.context.db.queryRows,
    blobStore: options.context.blobStore,
    maintenance: options.context.maintenance,
    getWorkflowStatus: options.context.mappers.getWorkflowStatus,
    mapWorkflowRowToProjectItem: options.context.mappers.mapWorkflowRowToProjectItem,
    toIsoString: options.context.mappers.toIsoString,
    workflowColumnsQualified: options.context.mappers.WORKFLOW_COLUMNS_QUALIFIED,
    recordingColumns: options.context.mappers.RECORDING_COLUMNS,
  };
  const toRunSummary = (row: RecordingRow): WorkflowRecordingRunSummary => {
    return {
      hasSubRuns: row.has_sub_runs,
      id: row.recording_id,
      workflowId: row.workflow_id,
      sourceProjectName: row.source_project_name,
      sourceProjectRelativePath: row.source_project_relative_path,
      createdAt: deps.toIsoString(row.created_at) ?? new Date().toISOString(),
      runKind: row.run_kind,
      status: row.status,
      durationMs: row.duration_ms,
      cost: readWorkflowRunCost(row.cost_json),
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
    };
  };
  const cleanupWorkflowRecordingStorage = createManagedRecordingRetentionTask(options);

  let maintenanceTaskRegistered = false;
  let recoveryReady = false;
  const ensureMaintenanceTaskRegistered = (): void => {
    if (maintenanceTaskRegistered) return;
    deps.maintenance.registerTask('workflow-recording-retention', cleanupWorkflowRecordingStorage);
    if (options.evidence)
      deps.maintenance.registerTask('workflow-recording-recovery', async () => {
        if (recoveryReady) await options.evidence!.recover();
      });
    maintenanceTaskRegistered = true;
  };

  return {
    async initialize(): Promise<void> {
      await deps.initialize();
      ensureMaintenanceTaskRegistered();
      // Preserve the former startup reconciliation, then use the durable timer
      // so retention also runs when a managed installation is completely idle.
      await deps.maintenance.runNow();
      recoveryReady = true;
    },
    listHistory(query: WorkflowRecordingPageQuery) {
      return listRecordingHistory(options.context, query, toRunSummary);
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
          cost: options.cost,
          endpointNameAtExecution: options.endpointName,
          executionIdentity: options.executionIdentity,
          errorMessage: options.errorMessage ?? null,
          recordingBlobKey: uploadedBlobs.recordingBlobKey,
          replayProjectBlobKey: uploadedBlobs.replayProjectBlobKey,
          replayDatasetBlobKey: uploadedBlobs.replayDatasetBlobKey,
          hasReplayDataset: Boolean(uploadedBlobs.replayDatasetBlobKey),
          recordingCompressedBytes: getStoredByteLength(uploadedBlobs.recordingBlobKey, options.recordingContents),
          recordingUncompressedBytes: getUtf8ByteLength(options.recordingContents),
          projectCompressedBytes: getStoredByteLength(
            uploadedBlobs.replayProjectBlobKey,
            options.replayProjectContents,
          ),
          projectUncompressedBytes: getUtf8ByteLength(options.replayProjectContents),
          datasetCompressedBytes: getStoredByteLength(
            uploadedBlobs.replayDatasetBlobKey,
            options.replayDatasetContents,
          ),
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

    async listWorkflowRecordingWorkflows(includeEvidence = false): Promise<WorkflowRecordingWorkflowListResponse> {
      await deps.initialize();
      const withEvidence = includeEvidence && !!evidence;
      const catalog = await deps.queryOne<{
        projects: WorkflowRecordingListRow[];
        total_runs: number;
        failed_runs: number;
        suspicious_runs: number;
      }>(
        deps.pool,
        `
          WITH run_counts AS (
            SELECT workflow_id,
                   COUNT(*)::int AS total_runs,
                   COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
                   COUNT(*) FILTER (WHERE status = 'suspicious')::int AS suspicious_runs,
                   MAX(created_at) AS latest_run_at
            FROM (
              SELECT recording_id, workflow_id, status, created_at FROM workflow_recordings
              ${
                withEvidence
                  ? `UNION ALL
                SELECT e.run_id, e.workflow_id, e.state, e.created_at FROM workflow_run_evidence e
                WHERE e.availability NOT IN ('available', 'deleted')
                  AND NOT EXISTS (SELECT 1 FROM workflow_recordings r WHERE r.recording_id = e.run_id)`
                  : ''
              }
            ) attempts
            GROUP BY workflow_id
          ), project_rows AS (
            SELECT ${deps.workflowColumnsQualified},
                   r.total_runs, r.failed_runs, r.suspicious_runs, r.latest_run_at
            FROM workflows w LEFT JOIN run_counts r ON r.workflow_id = w.workflow_id
          )
          SELECT COALESCE((SELECT jsonb_agg(p ORDER BY p.relative_path) FROM project_rows p), '[]'::jsonb) AS projects,
                 COALESCE(SUM(total_runs), 0)::int AS total_runs,
                 COALESCE(SUM(failed_runs), 0)::int AS failed_runs,
                 COALESCE(SUM(suspicious_runs), 0)::int AS suspicious_runs
          FROM run_counts
        `,
      );
      if (!catalog) throw new Error('Recording catalog query returned no result.');
      const rows = catalog.projects;

      const workflows = rows
        .filter(
          (row) =>
            (row.total_runs ?? 0) > 0 || (deps.getWorkflowStatus(row) !== 'unpublished' && Boolean(row.endpoint_name)),
        )
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

      return {
        workflows,
        ...(withEvidence
          ? {
              totals: {
                totalRuns: catalog.total_runs,
                failedRuns: catalog.failed_runs,
                suspiciousRuns: catalog.suspicious_runs,
              },
            }
          : {}),
      };
    },

    async listWorkflowRecordingRunsPage(
      workflowId: string,
      page: number,
      pageSize: number,
      statusFilter: WorkflowRecordingFilterStatus,
      inputFilter: WorkflowRecordingInputFilter | null = null,
      inputCursor = 0,
      signal?: AbortSignal,
      inputAfter?: string,
      includeSubgraphRuns = false,
      runScope: RecordingRunScope = inputFilter ? 'roots' : 'all',
    ): Promise<WorkflowRecordingRunsPageResponse> {
      await deps.initialize();
      signal?.throwIfAborted();
      const timedRead = async <T>(stage: 'count' | 'candidates' | 'matches', read: () => Promise<T>): Promise<T> => {
        signal?.throwIfAborted();
        const start = performance.now();
        try {
          const result = await read();
          signal?.throwIfAborted();
          return result;
        } finally {
          if (inputFilter) observeRecordingInputQuery(stage, performance.now() - start);
        }
      };
      const normalizedPage = Math.max(1, Math.floor(page));
      const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
      const offset = (normalizedPage - 1) * normalizedPageSize;
      // Empty workflow ID represents the all-workflow scope, never a stored ID.
      // Keep its bound parameter so cursor/limit placeholders use the same positions in both scopes.
      const workflowClause = recordingWorkflowScopeClause(
        workflowId,
        includeSubgraphRuns,
        'managed',
        1,
        runScope,
        statusFilter,
      );
      const countsClause =
        runScope === 'families'
          ? recordingWorkflowScopeClause(workflowId, includeSubgraphRuns, 'managed')
          : workflowClause;
      const inputAfterCursor = inputFilter
        ? parseWorkflowRecordingInputAfter(inputAfter, {
            workflowId,
            statusFilter,
            filter: inputFilter,
            includeSubgraphRuns,
          })
        : undefined;
      const initialInputSearch = !inputAfter && inputCursor === 0;
      const scopeCounts =
        (!inputFilter || initialInputSearch) && ((workflowId && includeSubgraphRuns) || runScope === 'roots')
          ? (await timedRead('count', () =>
              deps.queryOne<{
                totalRuns: number;
                failedRuns: number;
                suspiciousRuns: number;
              }>(
                deps.pool,
                `SELECT COUNT(*)::int AS "totalRuns",
        COUNT(*) FILTER (WHERE status = 'failed')::int AS "failedRuns",
        COUNT(*) FILTER (WHERE status = 'suspicious')::int AS "suspiciousRuns"
        FROM workflow_recordings WHERE ${countsClause}`,
                [workflowId],
                signal,
              ),
            )) ?? undefined
          : undefined;
      const filterClause = statusFilter === 'failed' ? `AND status IN ('failed', 'suspicious')` : '';

      const countRow =
        inputFilter || (scopeCounts && runScope !== 'families')
          ? null
          : await deps.queryOne<{ total_runs: number }>(
              deps.pool,
              `SELECT COUNT(*)::int AS total_runs FROM workflow_recordings WHERE ${workflowClause} ${filterClause}`,
              [workflowId],
            );
      const loadWindow = async (after: string | undefined, legacyOffset: number, queryLimit: number) => {
        const boundary = inputFilter
          ? parseWorkflowRecordingInputAfter(after, {
              workflowId,
              statusFilter,
              filter: inputFilter,
              includeSubgraphRuns,
            })
          : undefined;
        // An opaque keyset continuation already identifies the exact row after
        // which to continue. Never combine it with a numeric offset: doing so
        // would silently skip rows when a legacy caller supplies both values.
        const queryOffset = boundary ? 0 : Math.max(0, Math.floor(legacyOffset));
        const inputAfterClause = boundary ? 'AND (created_at, recording_id) < ($2::timestamptz, $3)' : '';
        const queryParameters = boundary
          ? [workflowId, boundary.createdAt, boundary.recordingId, queryLimit, queryOffset]
          : [workflowId, queryLimit, queryOffset];
        const limitParameter = boundary ? '$4' : '$2';
        const offsetParameter = boundary ? '$5' : '$3';
        // Select the bounded window once before computing child presence.
        // Count ownership globally for its keys, never group unrelated history.
        return timedRead('candidates', () =>
          deps.queryRows<RecordingInputCandidate>(
            deps.pool,
            `
          WITH recording_page AS MATERIALIZED (
            SELECT ${
              inputFilter
                ? 'recording_id, workflow_id, created_at, status, execution_surface, recording_blob_key, recording_compressed_bytes, recording_uncompressed_bytes'
                : deps.recordingColumns
            },
                   TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                     AS recording_cursor_created_at
            FROM workflow_recordings
            WHERE ${workflowClause} ${filterClause} ${inputAfterClause}
            ORDER BY created_at DESC, recording_id DESC
            LIMIT ${limitParameter} OFFSET ${offsetParameter}
          )
          SELECT recording_page.*${inputFilter ? '' : `, ${recordingHasSubRunsSql('managed', 'recording_page')} AS has_sub_runs`}
          FROM recording_page
          ORDER BY created_at DESC, recording_id DESC
        `,
            queryParameters,
            signal,
          ),
        );
      };
      for (let sourceAttempt = 0; ; sourceAttempt++) {
        const filteredPage = inputFilter
          ? await filterManagedRecordingRowsByInput(
              loadWindow,
              workflowId,
              statusFilter,
              inputFilter,
              deps.blobStore,
              inputCursor,
              inputAfterCursor,
              inputAfter,
              normalizedPageSize,
              signal,
              includeSubgraphRuns,
              (row, readSignal) =>
                deps.queryOne<RecordingInputCandidate>(
                  deps.pool,
                  `SELECT recording_id,workflow_id,created_at,status,execution_surface,recording_blob_key,recording_compressed_bytes,recording_uncompressed_bytes,
                TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recording_cursor_created_at
               FROM workflow_recordings WHERE recording_id=$1`,
                  [row.recording_id],
                  readSignal,
                ),
            )
          : null;
        let pageRows: RecordingRow[];
        if (filteredPage) {
          const selected = filteredPage.rows;
          const hydrated = selected.length
            ? await timedRead('matches', () =>
                deps.queryRows<RecordingRow>(
                  deps.pool,
                  `WITH recording_matches AS MATERIALIZED (
            SELECT ${deps.recordingColumns},
              TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recording_cursor_created_at
            FROM workflow_recordings
            WHERE ${workflowClause} ${filterClause} AND recording_id = ANY($2::text[])
          )
          SELECT recording_matches.*, ${recordingHasSubRunsSql('managed', 'recording_matches')} AS has_sub_runs
          FROM recording_matches`,
                  [workflowId, selected.map((row) => row.recording_id)],
                  signal,
                ),
              )
            : [];
          const byId = new Map(hydrated.map((row) => [row.recording_id, row]));
          // Preserve scanner order and its consumed boundary even if a row was
          // removed/replaced between matching and decoration. Never show a match
          // evaluated against a different artifact or timestamp.
          pageRows = [];
          const changed: RecordingRow[] = [];
          let retrySource = false;
          for (const candidate of selected) {
            const row = byId.get(candidate.recording_id);
            if (!row || !sameRecordingIdentity(row, candidate)) continue;
            if (row.recording_blob_key !== candidate.recording_blob_key) {
              const input = await readManagedRecordingInput(row, inputFilter!, deps.blobStore, signal);
              if (!input?.exists || !matchesWorkflowRecordingInputFilter(input.value, inputFilter!)) {
                retrySource = true;
                break;
              }
              changed.push(row);
            }
            pageRows.push(row);
          }
          if (changed.length) {
            const checked = await deps.queryRows<Pick<RecordingRow, 'recording_id' | 'recording_blob_key'>>(
              deps.pool,
              'SELECT recording_id,recording_blob_key FROM workflow_recordings WHERE recording_id=ANY($1::text[])',
              [changed.map((row) => row.recording_id)],
              signal,
            );
            const keys = new Map(checked.map((row) => [row.recording_id, row.recording_blob_key]));
            retrySource ||= changed.some((row) => keys.get(row.recording_id) !== row.recording_blob_key);
          }
          if (retrySource) {
            if (sourceAttempt === 0) continue;
            throw createHttpError(409, 'Recording sources changed during search. Retry this page.', {
              code: 'recording_source_changed',
            });
          }
        } else {
          // Ordinary browsing selects the full projection in loadWindow.
          pageRows = (await loadWindow(undefined, offset, normalizedPageSize)) as RecordingRow[];
        }
        const totalRuns =
          scopeCounts && runScope !== 'families'
            ? statusFilter === 'failed'
              ? scopeCounts.failedRuns + scopeCounts.suspiciousRuns
              : scopeCounts.totalRuns
            : countRow?.total_runs ?? 0;

        const runs = pageRows.map((row) => ({
          ...toRunSummary(row),
          ...(runScope === 'families' && row.execution_surface === 'subgraph_project'
            ? { familyContext: true as const }
            : {}),
        }));

        return {
          workflowId,
          scopeCounts,
          page: normalizedPage,
          pageSize: normalizedPageSize,
          totalRuns: filteredPage ? pageRows.length : totalRuns,
          totalRunsExact: filteredPage
            ? filteredPage.totalRunsExact && pageRows.length === filteredPage.rows.length
            : true,
          hasMore: filteredPage?.hasMore ?? normalizedPage * normalizedPageSize < totalRuns,
          nextInputCursor: filteredPage?.nextInputCursor,
          inputSearchAnalyzedRuns: filteredPage?.analyzedRuns,
          nextInputAfter: filteredPage?.nextInputAfter,
          statusFilter,
          inputFilter,
          runs,
        };
      }
    },

    async listWorkflowRunStatisticsCatalog(
      surface: WorkflowRunStatisticsSurface,
    ): Promise<WorkflowRunStatisticsCatalogResponse> {
      await deps.initialize();
      const query = recordingStatisticsCatalogSql('postgres', surface, !!evidence);
      const rows = await deps.queryRows<RecordingStatisticsSqlRow>(deps.pool, query.sql, query.values);
      return buildWorkflowRunStatisticsCatalog(rows.map(statisticsSqlRow), surface);
    },

    async getWorkflowRunStatistics(query: WorkflowRunStatisticsQuery): Promise<WorkflowRunStatisticsResponse> {
      await deps.initialize();
      const statement = recordingStatisticsRowsSql('postgres', query, !!evidence);
      const rows = await deps.queryRows<RecordingStatisticsSqlRow>(deps.pool, statement.sql, statement.values);
      const result = buildWorkflowRunStatistics(rows.map(statisticsSqlRow), query, { includeCost: true });
      if (evidence) {
        const incomplete = recordingStatisticsIncompleteSql(query);
        result.incompleteRuns =
          (await deps.queryOne<{ count: number }>(deps.pool, incomplete.sql, incomplete.values))?.count ?? 0;
      }
      return result;
    },

    async getWorkflowRecordingSummary(recordingId: string): Promise<WorkflowRecordingRunSummary> {
      await deps.initialize();
      const row = await deps.queryOne<RecordingRow>(
        deps.pool,
        `SELECT ${deps.recordingColumns} FROM workflow_recordings WHERE recording_id = $1`,
        [recordingId],
      );
      if (!row) throw createHttpError(404, 'Recording not found');
      return toRunSummary(row);
    },

    async readWorkflowRecordingArtifact(
      recordingId: string,
      artifact: 'recording' | 'replay-project' | 'replay-dataset',
    ): Promise<string> {
      await deps.initialize();
      const readRow = () =>
        deps.queryOne<
          Pick<
            RecordingRow,
            'workflow_id' | 'recording_blob_key' | 'replay_project_blob_key' | 'replay_dataset_blob_key'
          >
        >(
          deps.pool,
          `SELECT workflow_id, recording_blob_key, replay_project_blob_key, replay_dataset_blob_key
         FROM workflow_recordings WHERE recording_id = $1`,
          [recordingId],
        );
      const row = await readRow();
      if (!row) {
        throw createHttpError(404, 'Recording not found');
      }
      if (artifact === 'recording') {
        try {
          return await deps.blobStore.getText(row.recording_blob_key);
        } catch (error) {
          if (!isMissingManagedWorkflowObject(error)) throw error;
          const latest = await readRow();
          if (latest?.workflow_id === row.workflow_id && latest.recording_blob_key !== row.recording_blob_key)
            return deps.blobStore.getText(latest.recording_blob_key);
          throw error;
        }
      }
      if (artifact === 'replay-dataset') {
        if (!row.replay_dataset_blob_key) throw createHttpError(404, 'Replay dataset not found');
        return deps.blobStore.getText(row.replay_dataset_blob_key);
      }

      const readShared = (key: string) =>
        readSharedRecordingProject(deps.pool, deps.blobStore, key, row.workflow_id, recordingId);
      if (isRecordingProjectSnapshotKey(row.replay_project_blob_key)) return readShared(row.replay_project_blob_key);
      try {
        return await deps.blobStore.getText(row.replay_project_blob_key);
      } catch (error) {
        if (!isMissingManagedWorkflowObject(error)) throw error;
        // The compactor may have replaced the key and the outbox may already
        // have removed it. Refresh the pointer once, only after a missing file.
        const latest = await readRow();
        if (latest?.workflow_id === row.workflow_id && isRecordingProjectSnapshotKey(latest.replay_project_blob_key))
          return readShared(latest.replay_project_blob_key);
        throw error;
      }
    },

    async deleteWorkflowRecording(recordingId: string): Promise<void> {
      if (await evidence?.deletePending(recordingId)) return;
      let deletedRecordingBlobKey: string | undefined;
      await deps.withTransaction(async (client) => {
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

        deletedRecordingBlobKey = row.recording_blob_key;
        await client.query('DELETE FROM workflow_recordings WHERE recording_id = $1', [recordingId]);
        await deps.maintenance.enqueueObjectDeletions(client, 'workflow-recording-deletion', [
          row.recording_blob_key,
          row.replay_project_blob_key,
          row.replay_dataset_blob_key,
        ]);
      });
      if (deletedRecordingBlobKey) {
        workflowRecordingInputCache.invalidate(
          getManagedRecordingInputCacheKey(deps.blobStore, deletedRecordingBlobKey),
        );
      }
    },

    async persistWorkflowExecutionRecording(
      options: PersistWorkflowExecutionRecordingOptions,
    ): Promise<string | undefined> {
      await deps.initialize();

      if (options.evidenceHandle) {
        if (!evidence) throw new Error('Durable recording evidence is unavailable.');
        const id = await evidence.persist(options, options.evidenceHandle);
        await notifyRecordingPersisted(options.onPersisted, id, {
          projectId: options.sourceProject.metadata.id,
          recordingId: id,
        });
        return id;
      }

      const workflowId = options.sourceProject.metadata.id;
      if (!workflowId) {
        return undefined;
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

      const replayDatasetSerialized =
        options.executedDatasets.length > 0 ? serializeDatasets(options.executedDatasets) : null;
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
          cost: options.cost,
          executionIdentity: options.executionIdentity,
          errorMessage: options.errorMessage ?? null,
          recordingBlobKey: uploadedBlobs.recordingBlobKey,
          replayProjectBlobKey: uploadedBlobs.replayProjectBlobKey,
          replayDatasetBlobKey: uploadedBlobs.replayDatasetBlobKey,
          hasReplayDataset: Boolean(uploadedBlobs.replayDatasetBlobKey),
          recordingCompressedBytes: getStoredByteLength(uploadedBlobs.recordingBlobKey, options.recordingSerialized),
          recordingUncompressedBytes: getUtf8ByteLength(options.recordingSerialized),
          projectCompressedBytes: getStoredByteLength(uploadedBlobs.replayProjectBlobKey, replayProjectSerialized),
          projectUncompressedBytes: getUtf8ByteLength(replayProjectSerialized),
          datasetCompressedBytes: getStoredByteLength(uploadedBlobs.replayDatasetBlobKey, replayDatasetSerialized),
          datasetUncompressedBytes: getUtf8ByteLength(replayDatasetSerialized),
        },
        {
          timestampMode: options.createdAt ? 'provided' : 'now',
          createdAt: options.createdAt,
          onConflict: 'fail',
          cleanupContext: 'recording persistence failure',
        },
      );
      await notifyRecordingPersisted(options.onPersisted, recordingId, {
        projectId: workflowId,
        graphId: options.executionIdentity?.graphId,
        correlationId: options.executionIdentity?.correlationId,
        runKind: options.runKind,
      });
      // Do not force a global cleanup scan onto a published endpoint request.
      // The control-plane maintenance owner enforces retention independently.
      return recordingId;
    },

    async cleanupWorkflowRecordingStorage(): Promise<void> {
      await deps.initialize();
      ensureMaintenanceTaskRegistered();
      await deps.maintenance.runNow();
    },
  };
}

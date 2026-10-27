import type { WorkflowProjectItem } from './workflow-types';

/**
 * `editor` is a locally executed graph replay captured by the hosted editor.
 * It is intentionally distinct from endpoint traffic and excluded from run
 * statistics, while still using the normal recording browser and retention.
 */
export type WorkflowRecordingRunKind = 'published' | 'latest' | 'editor';

export type WorkflowRecordingStatus = 'succeeded' | 'failed' | 'suspicious';

/**
 * Identifies the surface that started a recorded processor run. Fields are
 * intentionally snapshots: project, web-app, and component names can change
 * after a recording is created.
 */
export type WorkflowRecordingExecutionIdentity = {
  surface: 'workflow_endpoint' | 'web_app_action' | 'editor_local' | 'subgraph_project' | 'scheduled';
  scheduleId?: string;
  scheduleName?: string;
  occurrenceId?: string;
  graphId?: string;
  graphName?: string;
  revisionKey?: string;
  uiGraphId?: string;
  uiGraphName?: string;
  webAppSlug?: string;
  componentId?: string;
  componentType?: 'button' | 'chat';
  componentLabel?: string;
  correlationId?: string;
};

/** Additional scheduled identity is stored separately from endpoint identities. */
export function readScheduledRecordingFields(
  value: unknown,
): Pick<WorkflowRecordingExecutionIdentity, 'scheduleId' | 'scheduleName' | 'occurrenceId'> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const field = (name: string) => (typeof raw[name] === 'string' && raw[name].length <= 200 ? raw[name] : undefined);
  return { scheduleId: field('scheduleId'), scheduleName: field('scheduleName'), occurrenceId: field('occurrenceId') };
}

export type WorkflowRecordingFilterStatus = 'all' | 'failed';
export const WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS = [
  '==',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'exists',
  'not_exists',
] as const;
export type WorkflowRecordingInputFilterOperator = (typeof WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS)[number];

export type WorkflowRecordingInputFilter = {
  path: string;
  operator: WorkflowRecordingInputFilterOperator;
  value: string;
};

export type WorkflowRecordingBlobEncoding = 'identity' | 'gzip';

export type WorkflowRecordingRunSummary = {
  /** Browse-only retained child presence; omitted by older servers. Never persisted. */
  hasSubRuns?: boolean;
  /** Browse-only context representative, not a claimed parent. Never persisted. */
  familyContext?: true;
  id: string;
  workflowId: string;
  sourceProjectName?: string;
  sourceProjectRelativePath?: string;
  /** Logical run creation/start for new captures; legacy/imported rows may retain save time. */
  createdAt: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  cost?: WorkflowRunCost;
  endpointNameAtExecution: string;
  executionIdentity?: WorkflowRecordingExecutionIdentity;
  errorMessage?: string;
  hasReplayDataset: boolean;
  recordingCompressedBytes: number;
  recordingUncompressedBytes: number;
  projectCompressedBytes: number;
  projectUncompressedBytes: number;
  datasetCompressedBytes: number;
  datasetUncompressedBytes: number;
};

export type WorkflowRecordingWorkflowSummary = {
  workflowId: string;
  project: WorkflowProjectItem;
  latestRunAt?: string;
  totalRuns: number;
  failedRuns: number;
  suspiciousRuns: number;
};

export type WorkflowRecordingWorkflowListResponse = {
  workflows: WorkflowRecordingWorkflowSummary[];
  /** Includes retained recordings even when their source project is no longer in the catalog. */
  totals?: WorkflowRecordingCounts;
};

export type WorkflowRecordingCounts = Pick<
  WorkflowRecordingWorkflowSummary,
  'totalRuns' | 'failedRuns' | 'suspiciousRuns'
>;

export function sumWorkflowRecordingCounts(rows: readonly WorkflowRecordingCounts[]): WorkflowRecordingCounts {
  return rows.reduce(
    (counts, row) => ({
      totalRuns: counts.totalRuns + row.totalRuns,
      failedRuns: counts.failedRuns + row.failedRuns,
      suspiciousRuns: counts.suspiciousRuns + row.suspiciousRuns,
    }),
    { totalRuns: 0, failedRuns: 0, suspiciousRuns: 0 },
  );
}

export type WorkflowRecordingRunsPageResponse = {
  /** Empty for Any; sub-runs pages identify the primary recording. Each run retains its actual workflowId. */
  workflowId: string;
  /** Counts before predicates; input searches count only root candidates, never child context rows. */
  scopeCounts?: WorkflowRecordingCounts;
  page: number;
  pageSize: number;
  totalRuns: number;
  totalRunsExact?: boolean;
  hasMore?: boolean;
  /**
   * Legacy offset continuation. New dashboard clients prefer nextInputAfter so
   * concurrent recording insertions/deletions cannot shift the next search.
   */
  nextInputCursor?: number;
  /** Exact number of status-scoped candidates evaluated by an input-filter search. */
  inputSearchAnalyzedRuns?: number;
  /** Opaque newest-first continuation for an input-filtered recording search. */
  nextInputAfter?: string;
  statusFilter: WorkflowRecordingFilterStatus;
  inputFilter?: WorkflowRecordingInputFilter | null;
  runs: WorkflowRecordingRunSummary[];
};

export type WorkflowRunStatisticsSurface = 'endpoint' | 'web_app';
export type WorkflowRunStatisticsRunKind = Exclude<WorkflowRecordingRunKind, 'editor'> | 'both';
export type WorkflowRunStatisticsAggregation = 'auto' | 'day' | 'week';

export type WorkflowRunStatisticsPeriod = {
  from: string;
  to: string;
};

export type WorkflowRunStatisticsStatusCounts = {
  succeeded: number;
  failed: number;
  suspicious: number;
};

export type WorkflowRunStatisticsMetrics = {
  runCount: number;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  averageDurationMs: number | null;
  minDurationMs: number | null;
  maxDurationMs: number | null;
};

/** Accounting is an estimate, not an invoice. Missing historical data is unknown. */
export type WorkflowRunCost =
  | { status: 'complete' | 'partial'; knownCostUsd: number }
  | { status: 'unknown'; knownCostUsd: null };

/** Untrusted metadata must never turn missing or invalid estimates into zero. */
export function readWorkflowRunCost(value: unknown): WorkflowRunCost | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const cost = value as Record<string, unknown>;
  if (cost.status === 'unknown' && cost.knownCostUsd === null) return { status: 'unknown', knownCostUsd: null };
  if (
    (cost.status === 'complete' || cost.status === 'partial') &&
    typeof cost.knownCostUsd === 'number' &&
    Number.isFinite(cost.knownCostUsd) &&
    cost.knownCostUsd >= 0
  ) {
    return { status: cost.status, knownCostUsd: cost.knownCostUsd };
  }
  return undefined;
}

export type WorkflowRunCostStatistics = {
  runCount: number;
  completeCount: number;
  partialCount: number;
  unknownCount: number;
  knownCostUsd: number | null;
  averageCompleteCostUsd: number | null;
};

export type WorkflowRunCostBucket = WorkflowRunCostStatistics & { from: string; to: string };

export type WorkflowRunStatisticsTarget =
  | {
      surface: 'endpoint';
      workflowId: string;
    }
  | {
      surface: 'web_app';
      workflowId: string;
      uiGraphId: string;
      componentId: string;
    }
  | {
      surface: 'web_app';
      workflowId: string;
      legacyEndpointName: string;
    };

/**
 * Produces an opaque, collision-safe key for a statistics target. This key is
 * only used for in-memory catalog and UI selection, never as persistent data.
 */
export function getWorkflowRunStatisticsTargetKey(target: WorkflowRunStatisticsTarget): string {
  if (target.surface === 'endpoint') {
    return JSON.stringify([0, target.workflowId]);
  }
  if ('legacyEndpointName' in target) {
    return JSON.stringify([1, 0, target.workflowId, target.legacyEndpointName]);
  }
  return JSON.stringify([1, 1, target.workflowId, target.uiGraphId, target.componentId]);
}

export type WorkflowRunStatisticsTargetSummary = {
  target: WorkflowRunStatisticsTarget;
  projectName: string;
  latestRunAt?: string;
  totalRuns: number;
  uiGraphName?: string;
  componentType?: 'button' | 'chat';
  componentLabel?: string;
  endpointNameAtExecution?: string;
  isLegacy?: boolean;
};

export type WorkflowRunStatisticsCatalogResponse = {
  surface: WorkflowRunStatisticsSurface;
  targets: WorkflowRunStatisticsTargetSummary[];
};

export type WorkflowRunStatisticsQuery = {
  target: WorkflowRunStatisticsTarget;
  period: WorkflowRunStatisticsPeriod;
  runKind: WorkflowRunStatisticsRunKind;
  includeFailed: boolean;
  includeWarnings: boolean;
  /**
   * Duration chart grouping, also used for cost unless costAggregation is set.
   * Omitting it preserves the adaptive grouping used by older clients.
   */
  aggregation?: WorkflowRunStatisticsAggregation;
  /** Cost chart grouping; defaults to aggregation. Both charts share one metadata snapshot. */
  costAggregation?: WorkflowRunStatisticsAggregation;
};

export type WorkflowRunStatisticsBucket = WorkflowRunStatisticsMetrics & {
  from: string;
  to: string;
};

export type WorkflowRunStatisticsResponse = {
  target: WorkflowRunStatisticsTarget;
  period: WorkflowRunStatisticsPeriod;
  current: WorkflowRunStatisticsMetrics;
  currentStatusCounts: WorkflowRunStatisticsStatusCounts;
  currentExcludedStatusCounts: WorkflowRunStatisticsStatusCounts;
  buckets: WorkflowRunStatisticsBucket[];
  /** Present only when supported; uses the same outcome filters as duration statistics. */
  cost?: WorkflowRunCostStatistics;
  costBuckets?: WorkflowRunCostBucket[];
};

export const WORKFLOW_RECORDING_VIRTUAL_PROJECT_PATH_PREFIX = 'recording://';

export function getWorkflowRecordingVirtualProjectPath(recordingId: string): string {
  return `${WORKFLOW_RECORDING_VIRTUAL_PROJECT_PATH_PREFIX}${encodeURIComponent(recordingId)}/replay.rivet-project`;
}

export function getWorkflowRecordingIdFromVirtualProjectPath(filePath: string): string | null {
  if (!filePath.startsWith(WORKFLOW_RECORDING_VIRTUAL_PROJECT_PATH_PREFIX)) {
    return null;
  }

  const remainder = filePath.slice(WORKFLOW_RECORDING_VIRTUAL_PROJECT_PATH_PREFIX.length);
  const slashIndex = remainder.indexOf('/');
  if (slashIndex <= 0) {
    return null;
  }

  const recordingId = remainder.slice(0, slashIndex);
  const fileName = remainder.slice(slashIndex + 1);
  if (fileName !== 'replay.rivet-project') {
    return null;
  }

  try {
    return decodeURIComponent(recordingId);
  } catch {
    return null;
  }
}

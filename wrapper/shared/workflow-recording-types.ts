import type { WorkflowProjectItem } from './workflow-types';

export type WorkflowRecordingRunKind = 'published' | 'latest';

export type WorkflowRecordingStatus = 'succeeded' | 'failed' | 'suspicious';

/**
 * Identifies the surface that started a recorded processor run. Fields are
 * intentionally snapshots: project, web-app, and component names can change
 * after a recording is created.
 */
export type WorkflowRecordingExecutionIdentity = {
  surface: 'workflow_endpoint' | 'web_app_action';
  graphId?: string;
  graphName?: string;
  revisionKey?: string;
  uiGraphId?: string;
  uiGraphName?: string;
  webAppSlug?: string;
  componentId?: string;
  componentType?: 'button' | 'chat';
  componentLabel?: string;
};

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
export type WorkflowRecordingInputFilterOperator =
  typeof WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS[number];

export type WorkflowRecordingInputFilter = {
  path: string;
  operator: WorkflowRecordingInputFilterOperator;
  value: string;
};

export type WorkflowRecordingBlobEncoding = 'identity' | 'gzip';

export type WorkflowRecordingRunSummary = {
  id: string;
  workflowId: string;
  createdAt: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
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
};

export type WorkflowRecordingRunsPageResponse = {
  workflowId: string;
  page: number;
  pageSize: number;
  totalRuns: number;
  totalRunsExact?: boolean;
  hasMore?: boolean;
  nextInputCursor?: number;
  statusFilter: WorkflowRecordingFilterStatus;
  inputFilter?: WorkflowRecordingInputFilter | null;
  runs: WorkflowRecordingRunSummary[];
};

export type WorkflowRunStatisticsSurface = 'endpoint' | 'web_app';
export type WorkflowRunStatisticsRunKind = WorkflowRecordingRunKind | 'both';

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
  period: WorkflowRunStatisticsPeriod;
  targets: WorkflowRunStatisticsTargetSummary[];
};

export type WorkflowRunStatisticsQuery = {
  target: WorkflowRunStatisticsTarget;
  period: WorkflowRunStatisticsPeriod;
  runKind: WorkflowRunStatisticsRunKind;
  includeFailed: boolean;
  includeWarnings: boolean;
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

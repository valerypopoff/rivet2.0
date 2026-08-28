import { getWorkflowRunStatisticsTargetKey } from '../../../../studio-server-shared/workflow-recording-types.js';
import type {
  WorkflowRecordingExecutionIdentity,
  WorkflowRecordingRunKind,
  WorkflowRecordingStatus,
  WorkflowRunStatisticsBucket,
  WorkflowRunStatisticsAggregation,
  WorkflowRunStatisticsCatalogResponse,
  WorkflowRunStatisticsMetrics,
  WorkflowRunStatisticsPeriod,
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsStatusCounts,
  WorkflowRunStatisticsSurface,
  WorkflowRunStatisticsTarget,
  WorkflowRunStatisticsTargetSummary,
} from '../../../../studio-server-shared/workflow-recording-types.js';

export type WorkflowRecordingStatisticsRow = {
  workflowId: string;
  sourceProjectName: string;
  createdAt: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  endpointNameAtExecution: string;
  executionIdentity?: WorkflowRecordingExecutionIdentity;
};

const EMPTY_STATUS_COUNTS: WorkflowRunStatisticsStatusCounts = {
  succeeded: 0,
  failed: 0,
  suspicious: 0,
};

export function buildWorkflowRunStatisticsCatalog(
  rows: readonly WorkflowRecordingStatisticsRow[],
  surface: WorkflowRunStatisticsSurface,
): WorkflowRunStatisticsCatalogResponse {
  const targets = new Map<string, WorkflowRunStatisticsTargetSummary>();

  for (const row of rows) {
    const target = getTargetForRow(row);
    if (!target || target.surface !== surface) continue;

    const key = getWorkflowRunStatisticsTargetKey(target);
    const existing = targets.get(key);
    const isLatestRow = !existing?.latestRunAt || row.createdAt >= existing.latestRunAt;
    targets.set(key, {
      target,
      projectName: isLatestRow ? row.sourceProjectName : existing.projectName,
      latestRunAt: isLatestRow ? row.createdAt : existing.latestRunAt,
      totalRuns: (existing?.totalRuns ?? 0) + 1,
      uiGraphName: isLatestRow
        ? row.executionIdentity?.uiGraphName ?? existing?.uiGraphName
        : existing?.uiGraphName,
      componentType: isLatestRow
        ? row.executionIdentity?.componentType ?? existing?.componentType
        : existing?.componentType,
      componentLabel: isLatestRow
        ? row.executionIdentity?.componentLabel ?? existing?.componentLabel
        : existing?.componentLabel,
      endpointNameAtExecution: isLatestRow ? row.endpointNameAtExecution : existing?.endpointNameAtExecution,
      isLegacy: existing?.isLegacy ?? isLegacyWebAppRow(row),
    });
  }

  return {
    surface,
    targets: [...targets.values()].sort((left, right) => {
      const latestDifference = (right.latestRunAt ?? '').localeCompare(left.latestRunAt ?? '');
      if (latestDifference) return latestDifference;
      const projectDifference = left.projectName.localeCompare(right.projectName);
      if (projectDifference) return projectDifference;
      return getWorkflowRunStatisticsTargetKey(left.target)
        .localeCompare(getWorkflowRunStatisticsTargetKey(right.target));
    }),
  };
}

export function buildWorkflowRunStatistics(
  rows: readonly WorkflowRecordingStatisticsRow[],
  query: WorkflowRunStatisticsQuery,
): WorkflowRunStatisticsResponse {
  const fromMs = parseTime(query.period.from);
  const toMs = parseTime(query.period.to);
  const currentRows = rows.filter((row) => isInPeriod(row, fromMs, toMs) && matchesQuery(row, query));
  const currentIncluded = currentRows.filter((row) => shouldIncludeStatus(row.status, query));
  const current = summarizeDurations(currentIncluded);

  return {
    target: query.target,
    period: query.period,
    current,
    currentStatusCounts: countStatuses(currentRows),
    currentExcludedStatusCounts: countStatuses(currentRows.filter((row) => !shouldIncludeStatus(row.status, query))),
    buckets: buildBuckets(currentIncluded, query.period, query.aggregation ?? 'auto'),
  };
}

export function getStatisticsQueryPeriod(input: { from: string; to: string }): WorkflowRunStatisticsPeriod {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new Error('Statistics period must contain valid ascending timestamps.');
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function getTargetForRow(row: WorkflowRecordingStatisticsRow): WorkflowRunStatisticsTarget | null {
  const identity = row.executionIdentity;
  if (identity?.surface === 'workflow_endpoint') {
    return { surface: 'endpoint', workflowId: row.workflowId };
  }
  if (hasStableWebAppActionIdentity(identity)) {
    return {
      surface: 'web_app',
      workflowId: row.workflowId,
      uiGraphId: identity.uiGraphId,
      componentId: identity.componentId,
    };
  }
  if (isLegacyWebAppRow(row)) {
    return { surface: 'web_app', workflowId: row.workflowId, legacyEndpointName: row.endpointNameAtExecution };
  }
  return { surface: 'endpoint', workflowId: row.workflowId };
}

function isLegacyWebAppRow(row: WorkflowRecordingStatisticsRow): boolean {
  return (!row.executionIdentity && row.endpointNameAtExecution.startsWith('/')) ||
    (row.executionIdentity?.surface === 'web_app_action' && !hasStableWebAppActionIdentity(row.executionIdentity));
}

function hasStableWebAppActionIdentity(
  identity: WorkflowRecordingExecutionIdentity | undefined,
): identity is WorkflowRecordingExecutionIdentity & {
  surface: 'web_app_action';
  uiGraphId: string;
  componentId: string;
} {
  return identity?.surface === 'web_app_action' && Boolean(identity.uiGraphId && identity.componentId);
}

function matchesQuery(row: WorkflowRecordingStatisticsRow, query: WorkflowRunStatisticsQuery): boolean {
  if (!matchesTarget(row, query.target)) return false;
  return query.runKind === 'both' || row.runKind === query.runKind;
}

function matchesTarget(row: WorkflowRecordingStatisticsRow, target: WorkflowRunStatisticsTarget): boolean {
  if (row.workflowId !== target.workflowId) return false;
  const identity = row.executionIdentity;
  if (target.surface === 'endpoint') {
    return identity?.surface === 'workflow_endpoint' || (!identity && !row.endpointNameAtExecution.startsWith('/'));
  }
  if ('legacyEndpointName' in target) {
    return isLegacyWebAppRow(row) && row.endpointNameAtExecution === target.legacyEndpointName;
  }
  return identity?.surface === 'web_app_action' &&
    identity.uiGraphId === target.uiGraphId &&
    identity.componentId === target.componentId;
}

function shouldIncludeStatus(status: WorkflowRecordingStatus, query: WorkflowRunStatisticsQuery): boolean {
  return status === 'succeeded' ||
    (status === 'failed' && query.includeFailed) ||
    (status === 'suspicious' && query.includeWarnings);
}

function countStatuses(rows: readonly WorkflowRecordingStatisticsRow[]): WorkflowRunStatisticsStatusCounts {
  const counts = { ...EMPTY_STATUS_COUNTS };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

function summarizeDurations(rows: readonly WorkflowRecordingStatisticsRow[]): WorkflowRunStatisticsMetrics {
  if (rows.length === 0) {
    return {
      runCount: 0,
      medianDurationMs: null,
      p95DurationMs: null,
      averageDurationMs: null,
      minDurationMs: null,
      maxDurationMs: null,
    };
  }

  const durations = rows.map((row) => Math.max(0, row.durationMs)).sort((left, right) => left - right);
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  return {
    runCount: durations.length,
    medianDurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    averageDurationMs: total / durations.length,
    minDurationMs: durations[0] ?? null,
    maxDurationMs: durations.at(-1) ?? null,
  };
}

function percentile(sortedValues: readonly number[], fraction: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sortedValues[lower] ?? 0;
  const upperValue = sortedValues[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function buildBuckets(
  rows: readonly WorkflowRecordingStatisticsRow[],
  period: WorkflowRunStatisticsPeriod,
  aggregation: WorkflowRunStatisticsAggregation,
): WorkflowRunStatisticsBucket[] {
  const fromMs = parseTime(period.from);
  const toMs = parseTime(period.to);
  const automaticBucketMs = getBucketDurationMs(toMs - fromMs);
  const buckets = new Map<number, WorkflowRecordingStatisticsRow[]>();
  for (const row of rows) {
    const start = getBucketStartMs(parseTime(row.createdAt), aggregation, automaticBucketMs);
    const bucketRows = buckets.get(start) ?? [];
    bucketRows.push(row);
    buckets.set(start, bucketRows);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([start, bucketRows]) => ({
      from: new Date(Math.max(start, fromMs)).toISOString(),
      to: new Date(Math.min(getBucketEndMs(start, aggregation, automaticBucketMs), toMs)).toISOString(),
      ...summarizeDurations(bucketRows),
    }));
}

function getBucketStartMs(
  timestamp: number,
  aggregation: WorkflowRunStatisticsAggregation,
  automaticBucketMs: number,
): number {
  if (aggregation === 'auto') return Math.floor(timestamp / automaticBucketMs) * automaticBucketMs;

  const date = new Date(timestamp);
  if (aggregation === 'day') {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }

  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday);
}

function getBucketEndMs(
  start: number,
  aggregation: WorkflowRunStatisticsAggregation,
  automaticBucketMs: number,
): number {
  if (aggregation === 'auto') return start + automaticBucketMs;
  const date = new Date(start);
  date.setUTCDate(date.getUTCDate() + (aggregation === 'day' ? 1 : 7));
  return date.getTime();
}

function getBucketDurationMs(periodMs: number): number {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (periodMs <= 36 * hour) return hour;
  if (periodMs <= 14 * day) return day;
  if (periodMs <= 120 * day) return 7 * day;
  return 30 * day;
}

function isInPeriod(row: WorkflowRecordingStatisticsRow, fromMs: number, toMs: number): boolean {
  const createdAt = parseTime(row.createdAt);
  return createdAt >= fromMs && createdAt < toMs;
}

function parseTime(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid recording timestamp: ${value}`);
  return timestamp;
}

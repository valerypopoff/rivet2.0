import type { WorkflowRecordingCounts } from '../../studio-server-shared/workflow-recording-types';
import type { WorkflowRecordingRunSummary } from './types';

export function countsAfterDeletingRun<T extends WorkflowRecordingCounts>(
  counts: T,
  run: WorkflowRecordingRunSummary,
): T {
  return {
    ...counts,
    totalRuns: Math.max(0, counts.totalRuns - 1),
    failedRuns: Math.max(0, counts.failedRuns - Number(run.status === 'failed')),
    suspiciousRuns: Math.max(0, counts.suspiciousRuns - Number(run.status === 'suspicious')),
  };
}

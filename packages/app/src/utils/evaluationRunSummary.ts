import type { EvaluationRun } from '@valerypopoff/rivet2-evaluations';

const qualityLabels = {
  passed: 'Passed',
  failed: 'Failed',
  scored: 'Scored',
  'not-evaluated': 'Not evaluated',
  'unable-to-evaluate': 'Unable to evaluate',
} as const;

const executionLabels = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  canceled: 'canceled',
  error: 'failed',
} as const;

export function formatEvaluationCompletionToast(
  run: Pick<EvaluationRun, 'purpose' | 'evaluationMode' | 'executionStatus' | 'qualityStatus' | 'aggregate' | 'trials'>,
): string {
  const aggregate = run.aggregate;
  if (run.purpose === 'execution-benchmark') {
    const trialCount = aggregate?.trialCount ?? run.trials.length;
    const erroredTrialCount =
      aggregate?.erroredTrialCount ?? run.trials.filter((trial) => trial.executionStatus === 'error').length;
    const canceledTrialCount =
      aggregate?.canceledTrialCount ?? run.trials.filter((trial) => trial.executionStatus === 'canceled').length;
    const measuredTrialCount = Math.max(0, trialCount - erroredTrialCount - canceledTrialCount);
    if (run.executionStatus === 'error') return 'Execution benchmark failed before completion.';
    if (run.executionStatus === 'canceled') {
      return `Execution benchmark canceled: ${measuredTrialCount} of ${trialCount} ${trialCount === 1 ? 'trial' : 'trials'} measured.`;
    }
    if (erroredTrialCount > 0 || canceledTrialCount > 0) {
      const problems = [
        ...(erroredTrialCount > 0
          ? [`${erroredTrialCount} ${erroredTrialCount === 1 ? 'execution error' : 'execution errors'}`]
          : []),
        ...(canceledTrialCount > 0
          ? [`${canceledTrialCount} canceled ${canceledTrialCount === 1 ? 'trial' : 'trials'}`]
          : []),
      ].join(', ');
      return `Execution benchmark completed with ${problems}: ${measuredTrialCount} of ${trialCount} ${trialCount === 1 ? 'trial' : 'trials'} measured.`;
    }
    return `Execution benchmark ${executionLabels[run.executionStatus]}: ${trialCount} ${trialCount === 1 ? 'trial' : 'trials'} measured.`;
  }

  if (run.evaluationMode === 'scoring' || run.qualityStatus === 'scored' || (aggregate?.scoredTrialCount ?? 0) > 0) {
    const scored = aggregate?.scoredTrialCount ?? 0;
    const trialCount = aggregate?.trialCount ?? run.trials.length;
    const score = aggregate?.meanScore;
    const formattedScore = score === undefined ? 'unavailable' : `${(score * 100).toFixed(1).replace(/\.0$/u, '')}/100`;
    return `Evaluation ${qualityLabels[run.qualityStatus]}: ${formattedScore}; ${scored} of ${trialCount} requested trials scored.`;
  }

  const passed = aggregate?.passedTrialCount ?? 0;
  const evaluated = aggregate?.evaluatedTrialCount ?? 0;
  if (evaluated === 0) {
    const aggregateSummary = {
      passed: 'aggregate requirements passed',
      failed: 'one or more aggregate requirements failed',
      scored: 'all requested trials produced scores',
      'not-evaluated': 'no output quality requirements were evaluated',
      'unable-to-evaluate': 'aggregate requirements could not be evaluated',
    } as const;
    return `Evaluation ${qualityLabels[run.qualityStatus]}: ${aggregateSummary[run.qualityStatus]}; no per-trial quality checks ran.`;
  }
  return `Evaluation ${qualityLabels[run.qualityStatus]}: ${passed}/${evaluated} evaluated trials passed.`;
}

/** Keeps storage failures actionable without confusing them with evaluation quality. */
export function formatEvaluationRunHistoryPersistenceWarning(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : '';
  return detail
    ? `This completed evaluation could not be saved to run history: ${detail}`
    : 'This completed evaluation could not be saved to run history.';
}

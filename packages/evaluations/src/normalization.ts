import type {
  EvaluationAccountingStatus,
  EvaluationAggregate,
  EvaluationBaselineSnapshot,
  EvaluationQualityReason,
  EvaluationQualityStatus,
  EvaluationRun,
  EvaluationRunPurpose,
  EvaluationSuiteMode,
  EvaluationTrial,
  EvaluationTrialExecutionStatus,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isQualityStatus(value: unknown): value is EvaluationQualityStatus {
  return ['passed', 'failed', 'scored', 'not-evaluated', 'unable-to-evaluate'].includes(String(value));
}

function isEvaluationMode(value: unknown): value is EvaluationSuiteMode {
  return value === 'pass-fail' || value === 'scoring';
}

function isQualityStatusForMode(status: EvaluationQualityStatus, evaluationMode: EvaluationSuiteMode): boolean {
  return evaluationMode === 'scoring' ? status !== 'passed' && status !== 'failed' : status !== 'scored';
}

function isExecutionStatus(value: unknown): value is EvaluationTrialExecutionStatus {
  return ['completed', 'error', 'canceled'].includes(String(value));
}

function isRunExecutionStatus(value: unknown): value is EvaluationRun['executionStatus'] {
  return ['queued', 'running', 'completed', 'canceled', 'error'].includes(String(value));
}

function isTerminalRunExecutionStatus(status: EvaluationRun['executionStatus']): boolean {
  return status === 'completed' || status === 'canceled' || status === 'error';
}

/**
 * Orders snapshots for one run without allowing an equal-revision progress
 * update to demote a terminal result. Writers and delayed UI reads share this
 * rule so persistence cannot disagree with what the workspace presents.
 */
export function shouldReplaceEvaluationRun(
  existing: Pick<EvaluationRun, 'executionStatus' | 'revision'> | undefined,
  incoming: Pick<EvaluationRun, 'executionStatus' | 'revision'>,
): boolean {
  if (!existing) return true;
  const existingRevision = existing.revision ?? 0;
  const incomingRevision = incoming.revision ?? 0;
  if (incomingRevision !== existingRevision) return incomingRevision > existingRevision;
  return !isTerminalRunExecutionStatus(existing.executionStatus) || isTerminalRunExecutionStatus(incoming.executionStatus);
}

function isPurpose(value: unknown): value is EvaluationRunPurpose {
  return value === 'evaluation' || value === 'execution-benchmark';
}

function isAccountingStatus(value: unknown): value is EvaluationAccountingStatus {
  return value === 'complete' || value === 'partial';
}

/** Run records keep scores normalized even though evaluator graphs use 0..100. */
function isNormalizedScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function reasonForQualityStatus(
  status: EvaluationQualityStatus,
  executionStatus?: EvaluationTrialExecutionStatus,
): EvaluationQualityReason {
  if (executionStatus === 'canceled') return { code: 'canceled', message: 'The execution was canceled.' };
  if (executionStatus === 'error' && status === 'failed') {
    return { code: 'target-error', message: 'The target graph failed before it could produce a valid result.' };
  }
  switch (status) {
    case 'passed':
      return { code: 'checks-passed', message: 'All required quality criteria passed.' };
    case 'failed':
      return { code: 'checks-failed', message: 'One or more required quality criteria failed.' };
    case 'scored':
      return { code: 'scores-complete', message: 'Every requested trial produced a score.' };
    case 'not-evaluated':
      return { code: 'no-trial-quality-checks', message: 'No per-trial quality check evaluated this result.' };
    case 'unable-to-evaluate':
      return { code: 'required-check-error', message: 'A required quality criterion could not be evaluated.' };
  }
}

function reasonForQualityStatusInMode(
  status: EvaluationQualityStatus,
  evaluationMode: EvaluationSuiteMode,
  executionStatus?: EvaluationTrialExecutionStatus,
): EvaluationQualityReason {
  if (evaluationMode === 'scoring' && status === 'unable-to-evaluate') {
    return { code: 'scores-incomplete', message: 'One or more requested trials did not produce a usable score.' };
  }
  return reasonForQualityStatus(status, executionStatus);
}

function isTargetExecutionError(value: Record<string, unknown>, observations: readonly unknown[]): boolean {
  if (typeof value.error === 'string' && value.error.length > 0) return true;
  return observations.some(
    (observation) =>
      isRecord(observation) &&
      observation.id === 'target-error' &&
      observation.kind === 'assertion' &&
      observation.status === 'error',
  );
}

function legacyQualityFromObservations(
  observations: readonly unknown[],
  targetExecutionError: boolean,
): EvaluationQualityStatus {
  if (targetExecutionError) return 'failed';
  const required = observations.filter(
    (observation) => isRecord(observation) && observation.required !== false,
  ) as Array<Record<string, unknown>>;
  if (required.some((observation) => observation.status === 'failed')) return 'failed';
  if (required.some((observation) => observation.status === 'error')) return 'unable-to-evaluate';
  if (required.some((observation) => observation.status === 'passed')) return 'passed';
  return 'not-evaluated';
}

/**
 * Scoring runs are new enough that they do not need to preserve a legacy
 * pass/fail quality label. Do still recover a useful status when a partial or
 * hand-edited scoring record lacks its derived status, but never let an old
 * `passed`/`failed` value leak into the scoring UI.
 */
function scoringQualityFromObservations(observations: readonly unknown[]): EvaluationQualityStatus {
  const evaluatorObservations = observations.filter(
    (observation): observation is Record<string, unknown> => isRecord(observation) && observation.kind === 'graph',
  );
  const hasCompleteScore =
    evaluatorObservations.length > 0 &&
    evaluatorObservations.every(
      (observation) =>
        observation.status === 'scored' &&
        typeof observation.score === 'number' &&
        Number.isFinite(observation.score) &&
        observation.score >= 0 &&
        observation.score <= 1,
    );
  return hasCompleteScore ? 'scored' : 'unable-to-evaluate';
}

function isQualityReasonCompatible(
  reason: EvaluationQualityReason,
  status: EvaluationQualityStatus,
  purpose: EvaluationRunPurpose,
  executionStatus?: EvaluationTrialExecutionStatus | EvaluationRun['executionStatus'],
): boolean {
  if (purpose === 'execution-benchmark') {
    return executionStatus === 'canceled' ? reason.code === 'canceled' : reason.code === 'benchmark';
  }
  if (executionStatus === 'queued' || executionStatus === 'running') return reason.code === 'in-progress';
  if (executionStatus === 'canceled') return reason.code === 'canceled';
  switch (status) {
    case 'passed':
      return reason.code === 'checks-passed' || reason.code === 'thresholds-passed';
    case 'failed':
      return reason.code === 'checks-failed' || reason.code === 'thresholds-failed' || reason.code === 'target-error';
    case 'scored':
      return reason.code === 'scores-complete';
    case 'not-evaluated':
      return reason.code === 'no-trial-quality-checks' || reason.code === 'no-completed-trials';
    case 'unable-to-evaluate':
      return (
        reason.code === 'required-check-error' ||
        reason.code === 'required-metric-unavailable' ||
        reason.code === 'scores-incomplete'
      );
  }
}

function normalizeQualityReason(
  value: unknown,
  fallback: EvaluationQualityReason,
  status: EvaluationQualityStatus,
  purpose: EvaluationRunPurpose,
  executionStatus?: EvaluationTrialExecutionStatus | EvaluationRun['executionStatus'],
): EvaluationQualityReason {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') return fallback;
  const reason = value as unknown as EvaluationQualityReason;
  return isQualityReasonCompatible(reason, status, purpose, executionStatus) ? reason : fallback;
}

export function normalizeEvaluationTrial(
  value: EvaluationTrial | unknown,
  purpose: EvaluationRunPurpose = 'evaluation',
  evaluationMode: EvaluationSuiteMode = 'pass-fail',
): EvaluationTrial {
  if (!isRecord(value)) throw new Error('Evaluation trial must be an object.');
  const legacyStatus = value.status;
  const observations = Array.isArray(value.observations) ? value.observations : [];
  const targetExecutionError = isTargetExecutionError(value, observations);
  const executionStatus = isExecutionStatus(value.executionStatus)
    ? value.executionStatus
    : legacyStatus === 'canceled'
      ? 'canceled'
      : targetExecutionError
        ? 'error'
        : legacyStatus === 'error' &&
            !observations.some(
              (observation) =>
                isRecord(observation) && observation.required !== false && observation.status === 'error',
            )
          ? 'error'
          : 'completed';
  const qualityStatus: EvaluationQualityStatus =
    purpose === 'execution-benchmark' || executionStatus === 'canceled'
      ? 'not-evaluated'
      : executionStatus === 'error'
        ? evaluationMode === 'scoring'
          ? 'unable-to-evaluate'
          : 'failed'
        : evaluationMode === 'scoring'
          ? scoringQualityFromObservations(observations)
          : isQualityStatus(value.qualityStatus) && isQualityStatusForMode(value.qualityStatus, evaluationMode)
            ? value.qualityStatus
            : legacyQualityFromObservations(observations, targetExecutionError);
  const normalized = structuredClone(value) as Record<string, unknown>;
  // Legacy runs stored a single status that conflated execution and quality.
  // Read it above, then remove it so normalized v2 values cannot contradict
  // their authoritative executionStatus/qualityStatus pair.
  delete normalized.status;
  return {
    ...(normalized as unknown as EvaluationTrial),
    executionStatus,
    qualityStatus,
    qualityReason: normalizeQualityReason(
      value.qualityReason,
      executionStatus === 'canceled'
        ? { code: 'canceled', message: 'The execution was canceled.' }
        : purpose === 'execution-benchmark'
          ? { code: 'benchmark', message: 'This run measured execution without evaluating output quality.' }
          : reasonForQualityStatusInMode(qualityStatus, evaluationMode, executionStatus),
      qualityStatus,
      purpose,
      executionStatus,
    ),
  };
}

export function normalizeEvaluationAggregate(
  value: EvaluationAggregate | unknown,
  trials?: readonly EvaluationTrial[],
): EvaluationAggregate {
  if (!isRecord(value)) throw new Error('Evaluation aggregate must be an object.');
  const normalized = structuredClone(value) as unknown as EvaluationAggregate;
  // Never let a graph-facing 0..100 value (or corrupt local data) masquerade
  // as the persisted normalized score and render as an impossible 9900/100.
  if (!isNormalizedScore(normalized.meanScore)) delete normalized.meanScore;
  if (!isNormalizedScore(normalized.medianScore)) delete normalized.medianScore;
  if (!isNormalizedScore(normalized.p95Score)) delete normalized.p95Score;
  if (
    typeof normalized.medianLatencyMs !== 'number' ||
    !Number.isFinite(normalized.medianLatencyMs) ||
    normalized.medianLatencyMs < 0
  ) {
    delete normalized.medianLatencyMs;
  }
  if (trials) {
    const completed = trials.filter((trial) => trial.executionStatus === 'completed');
    const evaluated = completed.filter((trial) => trial.qualityStatus === 'passed' || trial.qualityStatus === 'failed');
    const passed = evaluated.filter((trial) => trial.qualityStatus === 'passed');
    const failed = evaluated.filter((trial) => trial.qualityStatus === 'failed');
    const notEvaluated = completed.filter((trial) => trial.qualityStatus === 'not-evaluated');
    const unable = completed.filter((trial) => trial.qualityStatus === 'unable-to-evaluate');
    const scored = completed.filter((trial) => trial.qualityStatus === 'scored');
    return {
      ...normalized,
      trialCount: trials.length,
      evaluatedTrialCount: evaluated.length,
      notEvaluatedTrialCount: notEvaluated.length,
      unableToEvaluateTrialCount: unable.length,
      passedTrialCount: passed.length,
      failedTrialCount: failed.length,
      erroredTrialCount: trials.filter((trial) => trial.executionStatus === 'error').length,
      canceledTrialCount: trials.filter((trial) => trial.executionStatus === 'canceled').length,
      ...(scored.length > 0 || normalized.scoredTrialCount !== undefined
        ? { scoredTrialCount: scored.length, missingScoreTrialCount: trials.length - scored.length }
        : {}),
      passRate: evaluated.length === 0 ? 0 : passed.length / evaluated.length,
    };
  }
  const trialCount = Number(value.trialCount ?? 0);
  const passed = Number(value.passedTrialCount ?? 0);
  const failed = Number(value.failedTrialCount ?? 0);
  const errored = Number(value.erroredTrialCount ?? 0);
  const canceled = Number(value.canceledTrialCount ?? 0);
  const evaluated = Number(value.evaluatedTrialCount ?? passed + failed);
  const unable = Number(value.unableToEvaluateTrialCount ?? 0);
  const notEvaluated = Number(
    value.notEvaluatedTrialCount ?? Math.max(0, trialCount - evaluated - unable - errored - canceled),
  );
  return {
    ...normalized,
    evaluatedTrialCount: evaluated,
    notEvaluatedTrialCount: notEvaluated,
    unableToEvaluateTrialCount: unable,
    passRate: evaluated === 0 ? 0 : passed / evaluated,
  };
}

function withoutAuthoritativeCost(aggregate: EvaluationAggregate): EvaluationAggregate {
  const normalized = { ...aggregate };
  delete normalized.totalCostUsd;
  delete normalized.averageCostUsd;
  return normalized;
}

export function normalizeEvaluationBaselineSnapshot(
  value: EvaluationBaselineSnapshot | unknown,
): EvaluationBaselineSnapshot {
  if (!isRecord(value)) throw new Error('Evaluation baseline snapshot must be an object.');
  const accountingStatus = isAccountingStatus(value.accountingStatus)
    ? value.accountingStatus
    : isRecord(value.provenance) && value.provenance.accountingComplete === false
      ? 'partial'
      : 'complete';
  const aggregate = normalizeEvaluationAggregate(value.aggregate);
  const purpose = isPurpose(value.purpose) ? value.purpose : 'evaluation';
  const evaluationMode = isEvaluationMode(value.evaluationMode) ? value.evaluationMode : 'pass-fail';
  const hasCompleteScoringAggregate =
    aggregate.trialCount > 0 &&
    aggregate.scoredTrialCount === aggregate.trialCount &&
    aggregate.missingScoreTrialCount === 0 &&
    aggregate.meanScore !== undefined;
  const qualityStatus: EvaluationQualityStatus =
    purpose === 'execution-benchmark'
      ? 'not-evaluated'
      : evaluationMode === 'scoring'
        ? hasCompleteScoringAggregate
          ? 'scored'
          : 'unable-to-evaluate'
        : isQualityStatus(value.qualityStatus) && isQualityStatusForMode(value.qualityStatus, evaluationMode)
          ? value.qualityStatus
          : aggregate.failedTrialCount > 0 || aggregate.erroredTrialCount > 0
            ? 'failed'
            : aggregate.evaluatedTrialCount > 0
              ? 'passed'
              : 'not-evaluated';
  const qualityReasonFallback =
    purpose === 'execution-benchmark'
      ? { code: 'benchmark' as const, message: 'This run measured execution without evaluating output quality.' }
      : reasonForQualityStatusInMode(qualityStatus, evaluationMode);
  return {
    ...(structuredClone(value) as unknown as EvaluationBaselineSnapshot),
    purpose,
    evaluationMode,
    qualityStatus,
    qualityReason: normalizeQualityReason(value.qualityReason, qualityReasonFallback, qualityStatus, purpose),
    accountingStatus,
    aggregate: accountingStatus === 'partial' ? withoutAuthoritativeCost(aggregate) : aggregate,
  };
}

export function normalizeEvaluationRun(value: EvaluationRun | unknown): EvaluationRun {
  if (!isRecord(value)) throw new Error('Evaluation run must be an object.');
  const purpose = isPurpose(value.purpose) ? value.purpose : 'evaluation';
  const evaluationMode = isEvaluationMode(value.evaluationMode) ? value.evaluationMode : 'pass-fail';
  const executionStatus = isRunExecutionStatus(value.executionStatus)
    ? value.executionStatus
    : typeof value.completedAt === 'string'
      ? 'completed'
      : 'running';
  const trials = Array.isArray(value.trials)
    ? value.trials.map((trial) => normalizeEvaluationTrial(trial, purpose, evaluationMode))
    : [];
  const accountingStatus = isAccountingStatus(value.accountingStatus)
    ? value.accountingStatus
    : isRecord(value.provenance) && value.provenance.accountingComplete === false
      ? 'partial'
      : 'complete';
  let qualityStatus: EvaluationQualityStatus;
  if (purpose === 'execution-benchmark' || executionStatus === 'canceled') {
    qualityStatus = 'not-evaluated';
  } else if (executionStatus === 'error') {
    qualityStatus = evaluationMode === 'scoring' ? 'unable-to-evaluate' : 'failed';
  } else if (executionStatus === 'queued' || executionStatus === 'running') {
    qualityStatus = 'not-evaluated';
  } else if (evaluationMode === 'scoring') {
    const scored = trials.filter((trial) => trial.qualityStatus === 'scored').length;
    qualityStatus = scored > 0 && scored === trials.length ? 'scored' : 'unable-to-evaluate';
  } else if (isQualityStatus(value.qualityStatus) && isQualityStatusForMode(value.qualityStatus, evaluationMode)) {
    qualityStatus = value.qualityStatus;
  } else if (trials.some((trial) => trial.executionStatus === 'error' || trial.qualityStatus === 'failed')) {
    qualityStatus = 'failed';
  } else if (trials.some((trial) => trial.qualityStatus === 'unable-to-evaluate')) {
    qualityStatus = 'unable-to-evaluate';
  } else if (trials.some((trial) => trial.qualityStatus === 'passed')) {
    qualityStatus = 'passed';
  } else if (value.verdict === 'fail') {
    // Old runs could fail an aggregate threshold without having a per-trial
    // quality observation. Preserve that authoritative failure. Only legacy
    // success-without-evidence is reinterpreted as Not evaluated.
    qualityStatus = 'failed';
  } else {
    // Legacy runs used `pass` for a graph that merely completed. If no stored
    // required check proves quality, reinterpret it as Not evaluated instead
    // of preserving the misleading pass label.
    qualityStatus = 'not-evaluated';
  }
  const qualityReasonFallback =
    executionStatus === 'canceled'
      ? { code: 'canceled' as const, message: 'The evaluation run was canceled.' }
      : executionStatus === 'queued' || executionStatus === 'running'
        ? { code: 'in-progress' as const, message: 'The run is still in progress.' }
        : purpose === 'execution-benchmark'
          ? { code: 'benchmark' as const, message: 'This run measured execution without evaluating output quality.' }
          : (executionStatus === 'error' || trials.some((trial) => trial.executionStatus === 'error')) &&
              qualityStatus === 'failed'
            ? { code: 'target-error' as const, message: 'One or more target graph executions failed.' }
            : reasonForQualityStatusInMode(qualityStatus, evaluationMode);
  const provenance = isRecord(value.provenance)
    ? {
        ...structuredClone(value.provenance),
        accountingComplete: accountingStatus === 'complete',
      }
    : value.provenance;
  const normalized = structuredClone(value) as Record<string, unknown>;
  // As with legacy trial.status, the old verdict is input-only compatibility
  // data. New v2 values expose one unambiguous qualityStatus instead.
  delete normalized.verdict;
  const aggregate = value.aggregate === undefined ? undefined : normalizeEvaluationAggregate(value.aggregate, trials);
  return {
    ...(normalized as unknown as EvaluationRun),
    version: 2,
    purpose,
    evaluationMode,
    executionStatus,
    qualityStatus,
    qualityReason: normalizeQualityReason(
      value.qualityReason,
      qualityReasonFallback,
      qualityStatus,
      purpose,
      executionStatus,
    ),
    accountingStatus,
    provenance: provenance as EvaluationRun['provenance'],
    trials,
    thresholdResults: Array.isArray(value.thresholdResults)
      ? (structuredClone(value.thresholdResults) as EvaluationRun['thresholdResults'])
      : [],
    ...(aggregate === undefined
      ? {}
      : { aggregate: accountingStatus === 'partial' ? withoutAuthoritativeCost(aggregate) : aggregate }),
  };
}

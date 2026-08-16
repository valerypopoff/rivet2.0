import type {
  EvaluationAccountingStatus,
  EvaluationAggregate,
  EvaluationBaselineSnapshot,
  EvaluationQualityReason,
  EvaluationQualityStatus,
  EvaluationRun,
  EvaluationRunPurpose,
  EvaluationTrial,
  EvaluationTrialExecutionStatus,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isQualityStatus(value: unknown): value is EvaluationQualityStatus {
  return ['passed', 'failed', 'not-evaluated', 'unable-to-evaluate'].includes(String(value));
}

function isExecutionStatus(value: unknown): value is EvaluationTrialExecutionStatus {
  return ['completed', 'error', 'canceled'].includes(String(value));
}

function isRunExecutionStatus(value: unknown): value is EvaluationRun['executionStatus'] {
  return ['queued', 'running', 'completed', 'canceled', 'error'].includes(String(value));
}

function isPurpose(value: unknown): value is EvaluationRunPurpose {
  return value === 'evaluation' || value === 'execution-benchmark';
}

function isAccountingStatus(value: unknown): value is EvaluationAccountingStatus {
  return value === 'complete' || value === 'partial';
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
    case 'not-evaluated':
      return { code: 'no-trial-quality-checks', message: 'No per-trial quality check evaluated this result.' };
    case 'unable-to-evaluate':
      return { code: 'required-check-error', message: 'A required quality criterion could not be evaluated.' };
  }
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
    case 'not-evaluated':
      return reason.code === 'no-trial-quality-checks' || reason.code === 'no-completed-trials';
    case 'unable-to-evaluate':
      return reason.code === 'required-check-error' || reason.code === 'required-metric-unavailable';
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
        ? 'failed'
        : isQualityStatus(value.qualityStatus)
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
          : reasonForQualityStatus(qualityStatus, executionStatus),
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
  if (trials) {
    const completed = trials.filter((trial) => trial.executionStatus === 'completed');
    const evaluated = completed.filter((trial) => trial.qualityStatus === 'passed' || trial.qualityStatus === 'failed');
    const passed = evaluated.filter((trial) => trial.qualityStatus === 'passed');
    const failed = evaluated.filter((trial) => trial.qualityStatus === 'failed');
    const notEvaluated = completed.filter((trial) => trial.qualityStatus === 'not-evaluated');
    const unable = completed.filter((trial) => trial.qualityStatus === 'unable-to-evaluate');
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
  const qualityStatus: EvaluationQualityStatus =
    purpose === 'execution-benchmark'
      ? 'not-evaluated'
      : isQualityStatus(value.qualityStatus)
        ? value.qualityStatus
        : aggregate.failedTrialCount > 0 || aggregate.erroredTrialCount > 0
          ? 'failed'
          : aggregate.evaluatedTrialCount > 0
            ? 'passed'
            : 'not-evaluated';
  const qualityReasonFallback =
    purpose === 'execution-benchmark'
      ? { code: 'benchmark' as const, message: 'This run measured execution without evaluating output quality.' }
      : reasonForQualityStatus(qualityStatus);
  return {
    ...(structuredClone(value) as unknown as EvaluationBaselineSnapshot),
    purpose,
    qualityStatus,
    qualityReason: normalizeQualityReason(value.qualityReason, qualityReasonFallback, qualityStatus, purpose),
    accountingStatus,
    aggregate: accountingStatus === 'partial' ? withoutAuthoritativeCost(aggregate) : aggregate,
  };
}

export function normalizeEvaluationRun(value: EvaluationRun | unknown): EvaluationRun {
  if (!isRecord(value)) throw new Error('Evaluation run must be an object.');
  const purpose = isPurpose(value.purpose) ? value.purpose : 'evaluation';
  const executionStatus = isRunExecutionStatus(value.executionStatus)
    ? value.executionStatus
    : typeof value.completedAt === 'string'
      ? 'completed'
      : 'running';
  const trials = Array.isArray(value.trials)
    ? value.trials.map((trial) => normalizeEvaluationTrial(trial, purpose))
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
    qualityStatus = 'failed';
  } else if (isQualityStatus(value.qualityStatus)) {
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
            : reasonForQualityStatus(qualityStatus);
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

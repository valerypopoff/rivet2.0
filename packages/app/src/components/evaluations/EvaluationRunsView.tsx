import Button from '@atlaskit/button';
import Checkbox from '@atlaskit/checkbox';
import {
  reconcileEvaluationRunSnapshots,
  type EvaluationDataset,
  type EvaluationRunSummary as EvaluationHistoryEntry,
  type EvaluationRun,
} from '@valerypopoff/rivet2-evaluations';
import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useHostedEvaluationCoordinator, type HostedEvaluationRunState } from '../../providers/ProvidersContext.js';
import { type EvaluationRunTrialExpansion } from '../../state/evaluations.js';
import { CollapsiblePanel } from '../CollapsiblePanel.js';
import { EvaluationFormField } from './EvaluationFormField.js';
import { EvaluationSelect as Select } from './EvaluationSelect.js';
import { EvaluationTrialDetails } from './EvaluationTrialDetails.js';
import { getEvaluationRunRecordingReferences } from './evaluationRunCommands.js';
import {
  formatEvaluationDurationSeconds,
  formatEvaluationRunOptionLabel,
  formatEvaluationScore,
  getEvaluationRunQualityPresentation,
  meanEvaluationTrialScore,
  sortEvaluationTrialsByScore,
  type EvaluationScoreSort,
} from './evaluationWorkspaceModel.js';

import {
  describeEvaluationThreshold,
  evaluationScoreSortOptions,
  formatEvaluationMetricValue,
  getCachedEvaluationRunSummary,
  humanizeEvaluationMetric,
  ResourceTitle,
} from './evaluationPresentation.js';
const HostedInterruptedTrialRetry: FC<{
  run: EvaluationRun;
  retrying: boolean;
  onRetry: (run: EvaluationRun, jobIds: readonly string[]) => void;
}> = ({ run, retrying, onRetry }) => {
  const hostedEvaluationCoordinator = useHostedEvaluationCoordinator();
  const [hostedState, setHostedState] = useState<HostedEvaluationRunState>();
  const [retryEnabled, setRetryEnabled] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState<readonly string[]>([]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const readGeneration = useRef(0);

  // A durable run snapshot may advance while an operator is choosing a subset
  // of interrupted work. Only changing the run scope invalidates that choice;
  // a background refresh merely revalidates it against the latest job set.
  useEffect(() => {
    setHostedState(undefined);
    setRetryEnabled(false);
    setSelectedJobIds([]);
  }, [hostedEvaluationCoordinator, run.id, run.projectId]);

  useEffect(() => {
    const generation = readGeneration.current + 1;
    readGeneration.current = generation;
    if (!hostedEvaluationCoordinator) return;

    void Promise.all([
      hostedEvaluationCoordinator.getRunState({ projectId: run.projectId, runId: run.id }),
      hostedEvaluationCoordinator.getCapability(),
    ])
      .then(([next, capability]) => {
        if (readGeneration.current !== generation) return;
        setHostedState(next);
        setRetryEnabled(capability.enabled);
      })
      // Local and ordinary remote runs have no scheduler state. A missing or
      // temporarily unavailable retry capability must never manufacture retry UI.
      .catch(() => {
        if (readGeneration.current !== generation) return;
        setHostedState(undefined);
        setRetryEnabled(false);
      });
    // The durable run snapshot is refreshed by the normal hosted-run observer.
    // Include its revision so an interruption that happens while this tab is
    // already open triggers a fresh scheduler read and exposes the guarded retry
    // controls without making the operator navigate away first.
  }, [hostedEvaluationCoordinator, refreshVersion, run.id, run.projectId, run.revision]);

  const interruptedJobs = useMemo(
    () =>
      hostedState &&
      !hostedState.cancelRequested &&
      (hostedState.status === 'interrupted' || hostedState.status === 'running')
        ? hostedState.jobs.filter((job) => job.status === 'interrupted')
        : [],
    [hostedState],
  );
  const interruptedJobIds = useMemo(() => new Set(interruptedJobs.map((job) => job.jobId)), [interruptedJobs]);
  const selectedInterruptedJobIds = useMemo(
    () => selectedJobIds.filter((jobId) => interruptedJobIds.has(jobId)),
    [interruptedJobIds, selectedJobIds],
  );

  useEffect(() => {
    setSelectedJobIds((current) => current.filter((jobId) => interruptedJobIds.has(jobId)));
  }, [interruptedJobIds]);

  if (!retryEnabled || interruptedJobs.length === 0) return null;

  const allSelected = selectedInterruptedJobIds.length === interruptedJobs.length;
  const toggleJob = (jobId: string, selected: boolean) => {
    setSelectedJobIds((current) =>
      selected ? [...new Set([...current, jobId])] : current.filter((candidate) => candidate !== jobId),
    );
  };

  return (
    <section className="evaluation-hosted-retry" aria-label="Interrupted hosted trials">
      <div>
        <h3>Interrupted hosted trials</h3>
        <p>
          {interruptedJobs.length} trial{interruptedJobs.length === 1 ? ' was' : 's were'} interrupted after dispatch.
          Select only work that is safe to run again. A retry can repeat model calls, tool calls, external side effects,
          and cost.
        </p>
      </div>
      <div className="evaluation-hosted-retry-selection">
        <Checkbox
          isChecked={allSelected}
          label="Select all interrupted trials"
          onChange={(event) => setSelectedJobIds(event.target.checked ? interruptedJobs.map((job) => job.jobId) : [])}
        />
        <div className="evaluation-hosted-retry-job-list">
          {interruptedJobs.map((job) => (
            <Checkbox
              key={job.jobId}
              isChecked={selectedInterruptedJobIds.includes(job.jobId)}
              label={`${job.caseName} · Trial ${job.trialIndex + 1} · Worker attempt ${job.attempt}`}
              onChange={(event) => toggleJob(job.jobId, event.target.checked)}
            />
          ))}
        </div>
      </div>
      <div className="evaluation-hosted-retry-actions">
        <Button appearance="subtle" isDisabled={retrying} onClick={() => setRefreshVersion((version) => version + 1)}>
          Refresh status
        </Button>
        <Button
          appearance="primary"
          isDisabled={retrying || selectedInterruptedJobIds.length === 0}
          onClick={() => onRetry(run, selectedInterruptedJobIds)}
        >
          {retrying
            ? 'Retrying…'
            : selectedInterruptedJobIds.length === 0
              ? 'Select trials to retry'
              : `Retry ${selectedInterruptedJobIds.length} ${selectedInterruptedJobIds.length === 1 ? 'trial' : 'trials'}`}
        </Button>
      </div>
    </section>
  );
};

export const Runs: FC<{
  dataset?: EvaluationDataset;
  runs: EvaluationRun[];
  historyEntries: EvaluationHistoryEntry[];
  detailsLoading: boolean;
  detailsError?: string;
  onRetryDetails: () => void;
  hasMoreHistory: boolean;
  loadingHistoryPage: boolean;
  onLoadMoreHistory: () => void;
  currentRun?: EvaluationRun;
  selectedRunId?: string;
  scoreSort: EvaluationScoreSort;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  refreshError?: string;
  expandedTrialExpansion?: EvaluationRunTrialExpansion;
  onSelect: (runId: string) => void;
  retryingHostedRunId?: string;
  onScoreSortChange: (scoreSort: EvaluationScoreSort) => void;
  onExpandedTrialsChange: (runId: string | undefined, trialIds: readonly string[]) => void;
  onRename: (runId: string, name: string) => void;
  onDelete: (run: EvaluationRun) => void;
  onKeepRecordings: (run: EvaluationRun) => void;
  onReleaseRecordings: (run: EvaluationRun) => void;
  onOpenRecording: (recordingId: string) => void;
  onRetryInterrupted: (run: EvaluationRun, jobIds: readonly string[]) => void;
}> = ({
  dataset,
  runs,
  historyEntries,
  detailsLoading,
  detailsError,
  onRetryDetails,
  hasMoreHistory,
  loadingHistoryPage,
  onLoadMoreHistory,
  currentRun,
  selectedRunId,
  scoreSort,
  status,
  error,
  refreshError,
  expandedTrialExpansion,
  onSelect,
  retryingHostedRunId,
  onScoreSortChange,
  onExpandedTrialsChange,
  onRename,
  onDelete,
  onKeepRecordings,
  onReleaseRecordings,
  onOpenRecording,
  onRetryInterrupted,
}) => {
  const liveRun =
    currentRun?.executionStatus === 'queued' || currentRun?.executionStatus === 'running' ? currentRun : undefined;
  const selectedRun = useMemo(() => runs.find((candidate) => candidate.id === selectedRunId), [runs, selectedRunId]);
  const selectedRunSnapshot = useMemo(
    () =>
      selectedRun && currentRun?.id === selectedRun.id && selectedRun !== currentRun
        ? reconcileEvaluationRunSnapshots(selectedRun, currentRun)
        : selectedRun,
    [currentRun, selectedRun],
  );
  const run = useMemo(
    () => liveRun ?? (selectedRunId ? selectedRunSnapshot : currentRun ?? runs[0]),
    [currentRun, liveRun, runs, selectedRunSnapshot, selectedRunId],
  );
  const sortedTrials = useMemo(() => (run ? sortEvaluationTrialsByScore(run.trials, scoreSort) : []), [run, scoreSort]);
  const runSummary = useMemo(() => (run ? getCachedEvaluationRunSummary(run) : undefined), [run]);
  const expectedFieldLabels = useMemo(() => {
    const expectedFieldNameCounts = new Map<string, number>();
    for (const field of dataset?.fields ?? []) {
      expectedFieldNameCounts.set(field.name, (expectedFieldNameCounts.get(field.name) ?? 0) + 1);
    }
    return new Map(
      (dataset?.fields ?? []).map((field) => [
        field.id,
        expectedFieldNameCounts.get(field.name) === 1 ? field.name : `${field.name} (${field.id})`,
      ]),
    );
  }, [dataset?.fields]);
  const runOptions = useMemo(
    () =>
      historyEntries.map((candidate) => ({ label: formatEvaluationRunOptionLabel(candidate), value: candidate.id })),
    [historyEntries],
  );
  const selectedRunOption = useMemo(
    () =>
      run
        ? runOptions.find((option) => option.value === run.id) ?? {
            label: formatEvaluationRunOptionLabel(run),
            value: run.id,
          }
        : undefined,
    [run, runOptions],
  );
  const expandedTrialIds = useMemo(
    () =>
      new Set(
        expandedTrialExpansion !== undefined && expandedTrialExpansion.runId === run?.id
          ? expandedTrialExpansion.trialIds
          : [],
      ),
    [expandedTrialExpansion, run?.id],
  );
  const [renamingRunId, setRenamingRunId] = useState<string>();

  // Trial ids are run-scoped. Clearing an old run's explicit expansion when
  // the selected run changes avoids a stale card state leaking into a newly
  // selected history entry while still keeping every panel initially closed.
  useEffect(() => {
    if (expandedTrialExpansion?.runId && expandedTrialExpansion.runId !== run?.id) {
      onExpandedTrialsChange(run?.id, []);
    }
    setRenamingRunId(undefined);
  }, [expandedTrialExpansion?.runId, onExpandedTrialsChange, run?.id]);

  if (status === 'loading') return <div className="empty">Loading evaluation runs…</div>;
  if (status === 'error') return <div className="empty danger">Could not load evaluation runs: {error}</div>;
  if (!liveRun && (detailsLoading || detailsError))
    return (
      <section className="section">
        <Select
          className="field"
          options={runOptions}
          value={runOptions.find((option) => option.value === selectedRunId)}
          onChange={(value) => value && onSelect(value.value)}
        />
        <p className={detailsError ? 'danger' : 'empty'}>{detailsError ?? 'Loading selected run…'}</p>
        {detailsError ? (
          <button type="button" onClick={onRetryDetails}>
            Retry loading run
          </button>
        ) : null}
      </section>
    );
  if (!run) {
    return (
      <section className="section">
        <h2>Runs</h2>
        {refreshError ? (
          <p className="evaluation-run-history-refresh-warning">Could not refresh run history: {refreshError}</p>
        ) : null}
        <p className="empty">Run a suite to inspect trials, metrics, and retained recordings here.</p>
      </section>
    );
  }

  const quality = getEvaluationRunQualityPresentation(run);
  const aggregate = run.aggregate;
  const summaryAggregate = runSummary?.aggregate ?? aggregate;
  const isScoringRun = run.evaluationMode === 'scoring';
  const isRunInProgress = run.executionStatus === 'queued' || run.executionStatus === 'running';
  const recordingReferences = getEvaluationRunRecordingReferences(run);
  const hasKeepableReplayRecordings = recordingReferences.some(
    (reference) =>
      reference.retention === 'temporary' &&
      (reference.expiresAt === undefined || Date.parse(reference.expiresAt) > Date.now()),
  );
  const hasRetainedReplayRecordings = recordingReferences.some((reference) => reference.retention === 'retained');
  const executionLabel = `${run.executionStatus.charAt(0).toUpperCase()}${run.executionStatus.slice(1)}`;
  const isExecutionSettled = !isRunInProgress;
  const isAccountingPartial = run.accountingStatus === 'partial';
  const hasIncompleteExecution =
    run.executionStatus === 'error' ||
    run.executionStatus === 'canceled' ||
    run.trials.some((trial) => trial.executionStatus === 'error' || trial.executionStatus === 'canceled');
  const hasQualityProblem =
    run.purpose === 'evaluation' && (run.qualityStatus === 'failed' || run.qualityStatus === 'unable-to-evaluate');
  const hasCostProblem =
    isExecutionSettled &&
    (isAccountingPartial || (run.executionStatus === 'completed' && summaryAggregate?.totalCostUsd === undefined));
  const hasScoreProblem =
    isScoringRun &&
    run.purpose === 'evaluation' &&
    isExecutionSettled &&
    (summaryAggregate === undefined ||
      (summaryAggregate.scoredTrialCount ?? 0) < summaryAggregate.trialCount ||
      !Number.isFinite(summaryAggregate.meanScore) ||
      !Number.isFinite(summaryAggregate.medianScore) ||
      !Number.isFinite(summaryAggregate.p95Score));
  const hasInvalidLatencySummary =
    summaryAggregate !== undefined &&
    (summaryAggregate.trialCount === 0 ||
      !Number.isFinite(summaryAggregate.averageLatencyMs) ||
      !Number.isFinite(summaryAggregate.medianLatencyMs) ||
      !Number.isFinite(summaryAggregate.p95LatencyMs) ||
      summaryAggregate.averageLatencyMs < 0 ||
      (summaryAggregate.medianLatencyMs ?? 0) < 0 ||
      summaryAggregate.p95LatencyMs < 0);
  const hasLatencyProblem =
    isExecutionSettled && (hasIncompleteExecution || summaryAggregate === undefined || hasInvalidLatencySummary);
  const hasExplanationWarning = hasQualityProblem || hasIncompleteExecution;
  const pendingSummaryValue = '…';
  const formatScoreStatistic = (value: number | undefined) =>
    isRunInProgress ? pendingSummaryValue : formatEvaluationScore(value);
  const formatLatencyStatistic = (value: number | undefined) => {
    if (isRunInProgress) return pendingSummaryValue;
    if (!summaryAggregate) return 'Unavailable';
    if (summaryAggregate.trialCount === 0) return 'Unavailable';
    return formatEvaluationDurationSeconds(value);
  };
  const summaryItemClass = (hasProblem: boolean) =>
    `evaluation-run-summary-item${hasProblem ? ' evaluation-run-summary-item-warning' : ''}`;
  const qualitySummary = isRunInProgress
    ? `${run.executionStatus === 'queued' ? 'Queued' : 'Evaluating'}: ${run.trials.length}/${run.requestedTrialCount ?? '…'} ran`
    : isScoringRun && summaryAggregate
      ? `${quality.label}: ${summaryAggregate.scoredTrialCount ?? 0} of ${summaryAggregate.trialCount} trials`
      : summaryAggregate
        ? summaryAggregate.evaluatedTrialCount > 0
          ? `${quality.label}: ${summaryAggregate.passedTrialCount} of ${summaryAggregate.evaluatedTrialCount} passed`
          : summaryAggregate.unableToEvaluateTrialCount > 0
            ? `${quality.label}: ${summaryAggregate.unableToEvaluateTrialCount} trials`
            : quality.label
        : `${quality.label}: ${run.trials.length} recorded`;
  const visibleWarnings = run.warnings.filter(
    (warning) =>
      !(
        isAccountingPartial &&
        warning ===
          'Some provider pricing was unavailable. Cost totals are unavailable, and cost requirements cannot be evaluated.'
      ),
  );
  return (
    <section className="section">
      <h2>Runs</h2>
      {refreshError ? (
        <p className="evaluation-run-history-refresh-warning">Could not refresh run history: {refreshError}</p>
      ) : null}
      {historyEntries.length > 1 && (
        <div className="row">
          <Select
            className="field"
            options={runOptions}
            value={selectedRunOption}
            onChange={(value) => onSelect(value!.value)}
          />
        </div>
      )}
      {hasMoreHistory && (
        <Button isDisabled={loadingHistoryPage} onClick={onLoadMoreHistory}>
          {loadingHistoryPage ? 'Loading…' : 'Load older runs'}
        </Button>
      )}
      <ResourceTitle
        className="evaluation-run-name"
        editing={renamingRunId === run.id}
        fallback="Unnamed"
        headingLevel="h4"
        label="evaluation run"
        value={run.name ?? ''}
        onStartEditing={() => setRenamingRunId(run.id)}
        onFinishEditing={() => setRenamingRunId(undefined)}
        onCommit={(name) => onRename(run.id, name)}
      />
      <div className="evaluation-run-summary">
        <div className="evaluation-run-summary-row">
          <div className={summaryItemClass(hasQualityProblem)}>
            <span className="evaluation-run-summary-label">Quality</span>
            <span className={`evaluation-run-summary-value status-${run.qualityStatus}`} title={qualitySummary}>
              {qualitySummary}
            </span>
          </div>
          <div className={summaryItemClass(hasIncompleteExecution)}>
            <span className="evaluation-run-summary-label">Execution</span>
            <span className="evaluation-run-summary-value">{executionLabel}</span>
          </div>
          <div className={summaryItemClass(hasCostProblem)}>
            <span className="evaluation-run-summary-label">Total cost</span>
            <span className="evaluation-run-summary-value">
              {isRunInProgress
                ? pendingSummaryValue
                : isAccountingPartial || summaryAggregate?.totalCostUsd === undefined
                  ? 'Unavailable'
                  : `$${summaryAggregate.totalCostUsd.toFixed(4)}`}
            </span>
            {isAccountingPartial ? (
              <span className="evaluation-run-summary-cost-warning">
                Provider pricing was unavailable. Cost thresholds cannot be evaluated and cost comparisons are
                unavailable.
              </span>
            ) : null}
          </div>
        </div>
        <div className="evaluation-run-summary-statistics-row">
          {isScoringRun ? (
            <div className={summaryItemClass(hasScoreProblem)} aria-label="Score statistics">
              <span className="evaluation-run-summary-label">Score</span>
              <div className="evaluation-run-summary-statistics-values">
                <div>
                  <span className="evaluation-run-summary-statistic-label">Mean</span>
                  <span className="evaluation-run-summary-statistic-value">
                    {formatScoreStatistic(summaryAggregate?.meanScore)}
                  </span>
                </div>
                <div>
                  <span className="evaluation-run-summary-statistic-label">Median</span>
                  <span className="evaluation-run-summary-statistic-value">
                    {formatScoreStatistic(summaryAggregate?.medianScore)}
                  </span>
                </div>
                <div>
                  <span className="evaluation-run-summary-statistic-label">P95</span>
                  <span className="evaluation-run-summary-statistic-value">
                    {formatScoreStatistic(summaryAggregate?.p95Score)}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
          <div
            className={`${summaryItemClass(hasLatencyProblem)}${isScoringRun ? '' : ' evaluation-run-summary-statistics-card-full'}`}
            aria-label="Latency statistics"
          >
            <span className="evaluation-run-summary-label">Target graph latency</span>
            <div className="evaluation-run-summary-statistics-values">
              <div>
                <span className="evaluation-run-summary-statistic-label">Mean</span>
                <span className="evaluation-run-summary-statistic-value">
                  {formatLatencyStatistic(summaryAggregate?.averageLatencyMs)}
                </span>
              </div>
              <div>
                <span className="evaluation-run-summary-statistic-label">Median</span>
                <span className="evaluation-run-summary-statistic-value">
                  {formatLatencyStatistic(summaryAggregate?.medianLatencyMs)}
                </span>
              </div>
              <div>
                <span className="evaluation-run-summary-statistic-label">P95</span>
                <span className="evaluation-run-summary-statistic-value">
                  {formatLatencyStatistic(summaryAggregate?.p95LatencyMs)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="evaluation-run-summary-notice">
        <p
          className={`evaluation-run-explanation${hasExplanationWarning ? ' evaluation-run-explanation-warning' : ''}`}
        >
          {quality.explanation}
        </p>
      </div>
      <HostedInterruptedTrialRetry run={run} retrying={retryingHostedRunId === run.id} onRetry={onRetryInterrupted} />
      {isScoringRun && runSummary ? (
        <div className="evaluation-threshold-results">
          <h3>Scores by case</h3>
          <p className="muted">
            Each case average uses its scored trials. The overall score gives every case with an available average equal
            weight; incomplete coverage never appears as a complete score.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Average score</th>
                <th>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {runSummary.cases.map((testCase) => (
                <tr key={testCase.caseId}>
                  <td>{testCase.caseName}</td>
                  <td>{formatEvaluationScore(testCase.meanScore)}</td>
                  <td>
                    {testCase.scoredTrialCount ?? 0} of{' '}
                    {(testCase.scoredTrialCount ?? 0) + (testCase.missingScoreTrialCount ?? 0)} trials
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {run.thresholdResults.length > 0 && aggregate?.evaluatedTrialCount === 0 ? (
        <p className="evaluation-run-no-checks">
          Individual trials were not judged. This suite judges the aggregate run metrics, so the overall quality result
          comes from the requirements below.
        </p>
      ) : null}
      {run.thresholdResults.length > 0 ? (
        <div className="evaluation-threshold-results">
          <h3>Aggregate quality requirements</h3>
          <div className="evaluation-threshold-result-list">
            {run.thresholdResults.map((result) => {
              const statusLabel =
                result.status === 'passed' ? 'Passed' : result.status === 'failed' ? 'Failed' : 'Unable to evaluate';
              const statusClass =
                result.status === 'passed' ? 'pass' : result.status === 'failed' ? 'fail' : 'unable-to-evaluate';
              return (
                <div className="evaluation-threshold-result" key={result.id}>
                  <div className="evaluation-threshold-result-heading">
                    <strong>{humanizeEvaluationMetric(result.metric)}</strong>
                    <span className={`status-${statusClass}`}>{statusLabel}</span>
                  </div>
                  <p>
                    Actual: {formatEvaluationMetricValue(result.metric, result.actualValue)} · Requirement:{' '}
                    {describeEvaluationThreshold(result.metric, result.operator, result.expectedValue)}
                  </p>
                  {result.baselineValue === undefined ? null : (
                    <p className="muted">
                      Baseline: {formatEvaluationMetricValue(result.metric, result.baselineValue)}
                      {result.regression === undefined
                        ? ''
                        : ` · Observed regression: ${formatEvaluationMetricValue('pass-rate', result.regression)}`}
                    </p>
                  )}
                  <p className="muted">{result.message}</p>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {isScoringRun && runSummary && (runs.length > 1 || run.trials.length > 1) ? (
        <div className="evaluation-trial-sort">
          <EvaluationFormField className="evaluation-runs-score-sort" label="Sort by score">
            <Select
              options={evaluationScoreSortOptions}
              value={evaluationScoreSortOptions.find((option) => option.value === scoreSort)}
              onChange={(value) => onScoreSortChange((value?.value ?? 'default') as EvaluationScoreSort)}
            />
          </EvaluationFormField>
        </div>
      ) : null}

      <div className="evaluation-trial-list">
        {sortedTrials.map((trial) => {
          const isOpen = expandedTrialIds.has(trial.id);
          const trialQualityLabel =
            trial.qualityStatus === 'passed'
              ? 'Quality passed'
              : trial.qualityStatus === 'failed'
                ? 'Quality failed'
                : trial.qualityStatus === 'scored'
                  ? `Scored ${formatEvaluationScore(meanEvaluationTrialScore(trial))}`
                  : trial.qualityStatus === 'not-evaluated'
                    ? 'Quality not evaluated'
                    : 'Unable to evaluate quality';
          const trialStatusClass =
            trial.executionStatus !== 'completed'
              ? 'fail'
              : trial.qualityStatus === 'passed'
                ? 'pass'
                : trial.qualityStatus === 'scored'
                  ? 'scored'
                  : trial.qualityStatus;
          const toggleTrial = () => {
            const next = new Set(expandedTrialIds);
            if (next.has(trial.id)) next.delete(trial.id);
            else next.add(trial.id);
            onExpandedTrialsChange(run.id, [...next]);
          };
          return (
            <CollapsiblePanel
              key={trial.id}
              className="evaluation-trial"
              open={isOpen}
              onToggle={toggleTrial}
              ariaControls={`evaluation-trial-${trial.id}`}
              label={
                <span className="evaluation-trial-toggle-summary">
                  <span className="trial-case" title={`${trial.caseName} · Trial ${trial.trialIndex + 1}`}>
                    {trial.caseName} · Trial {trial.trialIndex + 1}
                  </span>
                  <span
                    className={`trial-execution status-${trial.executionStatus === 'completed' ? 'pass' : 'fail'}`}
                    title={trial.executionStatus === 'completed' ? 'Executed' : `Execution ${trial.executionStatus}`}
                  >
                    {trial.executionStatus === 'completed' ? 'Executed' : `Execution ${trial.executionStatus}`}
                  </span>
                  <span className={`trial-quality status-${trialStatusClass}`} title={trial.qualityReason.message}>
                    {trialQualityLabel}
                  </span>
                  <span
                    className="trial-duration"
                    title={formatEvaluationDurationSeconds(trial.totalMetrics.durationMs)}
                  >
                    {formatEvaluationDurationSeconds(trial.totalMetrics.durationMs)}
                  </span>
                </span>
              }
            >
              <EvaluationTrialDetails
                expectedFieldLabels={expectedFieldLabels}
                expanded={isOpen}
                onOpenRecording={onOpenRecording}
                runPurpose={run.purpose}
                trial={trial}
              />
            </CollapsiblePanel>
          );
        })}
      </div>
      {visibleWarnings.length > 0 ? (
        <ul className="warning">
          {visibleWarnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {isRunInProgress || (!hasKeepableReplayRecordings && !hasRetainedReplayRecordings) ? null : (
        <div className="evaluation-run-recording-actions">
          {hasKeepableReplayRecordings ? (
            <Button appearance="primary" onClick={() => onKeepRecordings(run)}>
              Keep replay recordings
            </Button>
          ) : null}
          {hasRetainedReplayRecordings ? (
            <Button
              appearance="subtle"
              className="evaluation-secondary-action"
              onClick={() => onReleaseRecordings(run)}
            >
              Release replay recordings
            </Button>
          ) : null}
        </div>
      )}
      <div className="evaluation-run-delete-action">
        <Button
          appearance="danger"
          isDisabled={isRunInProgress}
          title={
            isRunInProgress
              ? 'A running evaluation cannot be deleted.'
              : 'Permanently delete this run and its retained recordings.'
          }
          onClick={() => onDelete(run)}
        >
          Delete run
        </Button>
      </div>
    </section>
  );
};

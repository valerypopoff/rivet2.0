import Button from '@atlaskit/button';
import {
  canonicalStringify,
  getEvaluationSuiteMode,
  type EvaluationBaselineSnapshot,
  type EvaluationRun,
  type EvaluationSuite,
} from '@valerypopoff/rivet2-evaluations';
import { useMemo, useState, type FC } from 'react';
import { EvaluationSelect as Select } from './EvaluationSelect.js';
import { formatEvaluationScore, getEvaluationRunQualityPresentation } from './evaluationWorkspaceModel.js';

import { formatEvaluationComparisonMetric, relativeDelta } from './evaluationPresentation.js';
function compatibleProvenance(
  current: EvaluationRun['provenance'],
  reference: EvaluationRun['provenance'] | EvaluationBaselineSnapshot['provenance'],
): boolean {
  return (
    current.suiteFingerprint === reference.suiteFingerprint &&
    current.datasetFingerprint === reference.datasetFingerprint &&
    current.targetFingerprint === reference.targetFingerprint &&
    canonicalStringify(current.evaluatorFingerprints) === canonicalStringify(reference.evaluatorFingerprints)
  );
}

export const Compare: FC<{
  suite?: EvaluationSuite;
  runs: EvaluationRun[];
  run?: EvaluationRun;
  baseline?: EvaluationBaselineSnapshot;
  onPromote: () => void;
}> = ({ suite, runs, run, baseline, onPromote }) => {
  const [referenceId, setReferenceId] = useState('baseline');
  // Store and runner boundaries normalize these immutable records before they
  // reach the workspace. Re-normalizing here would clone every persisted run
  // and all of its trial payloads each time Compare mounts.
  const selectedRun = run;
  const selectedBaseline = baseline;
  const comparisonRuns = useMemo(
    () =>
      runs.filter(
        (candidate): candidate is EvaluationRun & { aggregate: NonNullable<EvaluationRun['aggregate']> } =>
          candidate.id !== selectedRun?.id &&
          candidate.executionStatus === 'completed' &&
          candidate.aggregate !== undefined,
      ),
    [runs, selectedRun?.id],
  );
  const comparisonOptions = useMemo(
    () => [
      ...(selectedBaseline ? [{ label: 'Suite baseline', value: 'baseline' }] : []),
      ...comparisonRuns.map((candidate) => ({
        label: `${candidate.suiteName} · ${new Date(candidate.startedAt).toLocaleString()} · ${
          candidate.purpose === 'execution-benchmark'
            ? 'Execution benchmark · no quality result'
            : getEvaluationRunQualityPresentation(candidate).label
        }`,
        value: candidate.id,
      })),
    ],
    [comparisonRuns, selectedBaseline],
  );
  const effectiveReferenceId =
    (referenceId === 'baseline' && selectedBaseline) || comparisonRuns.some((candidate) => candidate.id === referenceId)
      ? referenceId
      : selectedBaseline
        ? 'baseline'
        : comparisonRuns[0]?.id ?? 'baseline';
  const referenceRun = comparisonRuns.find((candidate) => candidate.id === effectiveReferenceId);
  const reference = effectiveReferenceId === 'baseline' ? selectedBaseline : referenceRun;
  const referenceAggregate = reference?.aggregate;
  const compatible = selectedRun && reference && compatibleProvenance(selectedRun.provenance, reference.provenance);
  const hasReplayArtifact = useMemo(
    () =>
      selectedRun?.trials.some(
        (trial) => trial.recording != null || trial.observations.some((observation) => observation.recording != null),
      ) ?? false,
    [selectedRun],
  );
  const hasCompleteScoringBaseline =
    selectedRun === undefined ||
    selectedRun.purpose === 'execution-benchmark' ||
    getEvaluationSuiteMode(selectedRun) !== 'scoring' ||
    selectedRun.qualityStatus === 'scored';
  const canPromoteBaseline = hasReplayArtifact && hasCompleteScoringBaseline;
  const referenceLabel = effectiveReferenceId === 'baseline' ? 'Baseline' : 'Selected run';
  const baselinePurpose = selectedBaseline?.purpose ?? 'evaluation';
  const baselineQualityLabel =
    baselinePurpose === 'execution-benchmark'
      ? 'Not evaluated'
      : selectedBaseline?.qualityStatus === 'passed'
        ? 'Passed'
        : selectedBaseline?.qualityStatus === 'failed'
          ? 'Failed'
          : selectedBaseline?.qualityStatus === 'scored'
            ? 'Scored'
            : selectedBaseline?.qualityStatus === 'unable-to-evaluate'
              ? 'Unable to evaluate'
              : selectedBaseline?.qualityStatus === 'not-evaluated'
                ? 'Not evaluated'
                : 'Legacy result';
  const baselineAccountingLabel = selectedBaseline?.accountingStatus === 'partial' ? 'Partial' : 'Complete';
  const currentAggregate = selectedRun?.aggregate;
  const currentCost = selectedRun?.accountingStatus === 'partial' ? undefined : currentAggregate?.totalCostUsd;
  const referenceAccountingPartial =
    reference != null && 'accountingStatus' in reference && reference.accountingStatus === 'partial';
  const referenceCost = referenceAccountingPartial ? undefined : referenceAggregate?.totalCostUsd;
  return (
    <section className="section">
      <h2>Compare</h2>
      <p className="muted">
        Compare any two stored runs, or compare the selected run with the suite baseline. A baseline keeps only compact
        metrics and provenance in the project; raw output and replay artifacts remain in the run store. Threshold
        comparisons are authoritative only when target, dataset, bindings, and evaluator fingerprints match.
      </p>
      {selectedRun ? (
        <div className="row">
          <Select
            className="field"
            options={comparisonOptions}
            value={
              effectiveReferenceId === 'baseline'
                ? selectedBaseline
                  ? { label: 'Suite baseline', value: 'baseline' }
                  : undefined
                : comparisonOptions.find((option) => option.value === effectiveReferenceId)
            }
            placeholder="Choose a run or baseline"
            onChange={(value) => setReferenceId(value?.value ?? 'baseline')}
          />
        </div>
      ) : null}
      {selectedBaseline ? (
        <p>
          {`Baseline recorded ${new Date(selectedBaseline.createdAt).toLocaleString()} · ${
            baselinePurpose === 'execution-benchmark' ? 'Execution benchmark' : 'Evaluation'
          } · Quality: ${baselineQualityLabel} · Accounting: ${baselineAccountingLabel}`}
          {(selectedBaseline.aggregate.evaluatedTrialCount ?? 0) > 0
            ? ` · Pass rate ${Math.round(selectedBaseline.aggregate.passRate * 100)}%`
            : selectedBaseline.aggregate.meanScore === undefined
              ? ''
              : ` · Score ${formatEvaluationScore(selectedBaseline.aggregate.meanScore)}`}
        </p>
      ) : (
        <p>
          {suite
            ? 'No baseline has been promoted yet. You can still compare two stored runs.'
            : 'Choose an evaluation suite first.'}
        </p>
      )}
      {selectedRun && reference && referenceAggregate && (
        <table className="table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Current</th>
              <th>{referenceLabel}</th>
              <th>Delta</th>
            </tr>
          </thead>
          <tbody>
            {[
              ...(currentAggregate?.evaluatedTrialCount && referenceAggregate.evaluatedTrialCount
                ? [['Pass rate', currentAggregate.passRate, referenceAggregate.passRate]]
                : []),
              ...(currentAggregate?.meanScore !== undefined && referenceAggregate.meanScore !== undefined
                ? [['Overall score', currentAggregate.meanScore, referenceAggregate.meanScore]]
                : []),
              ['P95 latency', currentAggregate?.p95LatencyMs, referenceAggregate.p95LatencyMs],
              ['Total cost', currentCost, referenceCost],
            ].map(([label, current, previous]) => (
              <tr key={String(label)}>
                <td>{label}</td>
                <td>{formatEvaluationComparisonMetric(String(label), current as number | undefined)}</td>
                <td>{formatEvaluationComparisonMetric(String(label), previous as number | undefined)}</td>
                <td>{relativeDelta(current as number | undefined, previous as number | undefined)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {reference && !compatible && (
        <p className="warning">
          This comparison is stale. You can inspect it, but baseline-relative thresholds will not be applied.
        </p>
      )}
      {selectedRun && selectedRun.executionStatus === 'completed' && (
        <>
          <Button isDisabled={!canPromoteBaseline} onClick={onPromote}>
            Use this run as baseline
          </Button>
          {!hasReplayArtifact && <p className="muted">A baseline needs at least one retained replay artifact.</p>}
          {hasReplayArtifact && !hasCompleteScoringBaseline && (
            <p className="muted">A scoring baseline needs a complete score for every requested trial.</p>
          )}
        </>
      )}
    </section>
  );
};

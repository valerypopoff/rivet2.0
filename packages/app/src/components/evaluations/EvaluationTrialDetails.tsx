import AtlaskitButton from '@atlaskit/button';
import type { EvaluationRecordingReference, EvaluationRun, EvaluationRunPurpose } from '@valerypopoff/rivet2-evaluations';
import { memo } from 'react';
import {
  evaluationAssertionOperatorOptions,
  formatEvaluationDurationSeconds,
  formatEvaluationScore,
} from './evaluationWorkspaceModel.js';

// Vite resolves Atlaskit's default ESM export directly, while the focused
// Node renderer reaches its CommonJS default wrapper. Resolve once at this
// boundary so the lazily mounted details remain testable in both hosts.
const Button = ((AtlaskitButton as { default?: typeof AtlaskitButton }).default ?? AtlaskitButton) as typeof AtlaskitButton;

type EvaluationTrialDetailsProps = {
  expectedFieldLabels: ReadonlyMap<string, string>;
  expanded: boolean;
  onOpenRecording: (recordingId: string) => void;
  runPurpose: EvaluationRunPurpose;
  trial: EvaluationRun['trials'][number];
};

/**
 * Full trial evidence can be much larger than the compact trial list. Keep it
 * behind the user-controlled disclosure so switching to Runs only renders the
 * list facts, not every input/output/evidence JSON payload in history.
 */
export const EvaluationTrialDetails = memo<EvaluationTrialDetailsProps>(
  ({ expectedFieldLabels, expanded, onOpenRecording, runPurpose, trial }) => {
    if (!expanded) return <div id={`evaluation-trial-${trial.id}`} />;

    const recordings: Array<{ label: string; reference: EvaluationRecordingReference }> = [];
    if (trial.recording) recordings.push({ label: 'Load target graph recording', reference: trial.recording });
    for (const observation of trial.observations) {
      if (observation.recording) {
        recordings.push({
          label: `Load '${observation.name}' graph recording`,
          reference: observation.recording,
        });
      }
    }
    const expiredRecordingIds = new Set(
      recordings
        .filter(
          ({ reference }) =>
            reference.retention === 'temporary' &&
            reference.expiresAt !== undefined &&
            Date.parse(reference.expiresAt) <= Date.now(),
        )
        .map(({ reference }) => reference.id),
    );
    const expectedValues = Object.fromEntries(
      Object.entries(trial.expected).map(([fieldId, value]) => [expectedFieldLabels.get(fieldId) ?? fieldId, value]),
    );

    return (
      <div className="evaluation-trial-content" id={`evaluation-trial-${trial.id}`}>
        <div className="evaluation-trial-results">
          <div className="evaluation-result-block">
            <h4>Inputs</h4>
            <pre>{formatEvaluationValue(trial.inputs)}</pre>
          </div>
          <div className="evaluation-result-block">
            <h4>Target outputs</h4>
            <pre>{formatEvaluationValue(trial.outputs)}</pre>
          </div>
          <div className="evaluation-result-block">
            <h4>Expected values</h4>
            <pre>{formatEvaluationValue(expectedValues)}</pre>
          </div>
          <div className="evaluation-result-block">
            <h4>Metrics</h4>
            <pre>
              {formatEvaluationValue({
                duration: formatEvaluationDurationSeconds(trial.totalMetrics.durationMs),
                ...Object.fromEntries(Object.entries(trial.totalMetrics).filter(([key]) => key !== 'durationMs')),
              })}
            </pre>
          </div>
        </div>

        <div className="evaluation-checks">
          <h4>Checks</h4>
          {trial.observations.length === 0 ? (
            <p className="muted">
              {runPurpose === 'execution-benchmark'
                ? 'This execution benchmark did not judge output quality.'
                : 'No deterministic checks or evaluator graphs ran for this trial.'}
            </p>
          ) : (
            <div className="evaluation-observation-list">
              {trial.observations.map((observation) => {
                const evidenceRecord =
                  observation.evidence !== null &&
                  typeof observation.evidence === 'object' &&
                  !Array.isArray(observation.evidence)
                    ? observation.evidence
                    : undefined;
                const hasActualExpected =
                  evidenceRecord !== undefined &&
                  (Object.hasOwn(evidenceRecord, 'actual') || Object.hasOwn(evidenceRecord, 'expected'));
                const assertionOperator =
                  observation.kind === 'assertion' && typeof evidenceRecord?.operator === 'string'
                    ? evaluationAssertionOperatorOptions.find((option) => option.value === evidenceRecord.operator)?.label
                    : undefined;
                const assertionOutputPath =
                  observation.kind === 'assertion' && typeof evidenceRecord?.outputPath === 'string'
                    ? evidenceRecord.outputPath
                    : undefined;
                const rawExpectedSource = evidenceRecord?.expectedSource;
                const structuredExpectedSource =
                  rawExpectedSource !== null && typeof rawExpectedSource === 'object' && !Array.isArray(rawExpectedSource)
                    ? rawExpectedSource
                    : undefined;
                const expectedSourceKind =
                  typeof rawExpectedSource === 'string'
                    ? rawExpectedSource
                    : typeof structuredExpectedSource?.kind === 'string'
                      ? structuredExpectedSource.kind
                      : undefined;
                const assertionExpectedFieldId =
                  typeof structuredExpectedSource?.fieldId === 'string'
                    ? structuredExpectedSource.fieldId
                    : typeof evidenceRecord?.expectedFieldId === 'string'
                      ? evidenceRecord.expectedFieldId
                      : undefined;
                const expectedSource =
                  observation.kind === 'assertion' && expectedSourceKind === 'dataset-field'
                    ? assertionExpectedFieldId
                      ? `Dataset field: ${expectedFieldLabels.get(assertionExpectedFieldId) ?? assertionExpectedFieldId}`
                      : 'Dataset field'
                    : observation.kind === 'assertion' && expectedSourceKind === 'literal'
                      ? 'Literal JSON'
                      : undefined;
                const actualFound =
                  typeof evidenceRecord?.actualFound === 'boolean' ? evidenceRecord.actualFound : undefined;
                return (
                  <div className="evaluation-observation" key={observation.id}>
                    <div className="evaluation-observation-heading">
                      <h5>{observation.name}</h5>
                      <span
                        className={`status-${
                          observation.status === 'passed'
                            ? 'pass'
                            : observation.status === 'scored'
                              ? 'scored'
                              : observation.status === 'failed' || observation.status === 'error'
                                ? 'fail'
                                : 'not-evaluated'
                        }`}
                      >
                        {observation.status.charAt(0).toUpperCase() + observation.status.slice(1)}
                      </span>
                    </div>
                    <span className="muted">
                      {observation.kind === 'graph' ? 'Evaluator graph' : 'Deterministic check'} ·{' '}
                      {observation.required ? 'required' : 'informational'}
                      {observation.score === undefined ? '' : ` · score ${formatEvaluationScore(observation.score)}`}
                    </span>
                    {assertionOutputPath || assertionOperator || expectedSource ? (
                      <p className="muted">
                        {assertionOutputPath ? `Target: ${assertionOutputPath}` : ''}
                        {assertionOperator ? ` · Comparison: ${assertionOperator}` : ''}
                        {expectedSource ? ` · Expected source: ${expectedSource}` : ''}
                      </p>
                    ) : null}
                    {observation.message ? <p>{observation.message}</p> : null}
                    {observation.evidence === undefined ? null : hasActualExpected ? (
                      <div className="evaluation-observation-evidence">
                        <div>
                          <h6>Actual output value</h6>
                          <pre>
                            {actualFound === false ? 'Output path was not found.' : formatEvaluationValue(evidenceRecord.actual)}
                          </pre>
                        </div>
                        <div>
                          <h6>Expected value</h6>
                          <pre>{formatEvaluationValue(evidenceRecord.expected)}</pre>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="muted">Evidence</p>
                        <pre>{formatEvaluationValue(observation.evidence)}</pre>
                      </>
                    )}
                    {observation.metrics === undefined ? null : (
                      <>
                        <p className="muted">Custom metrics</p>
                        <pre>{formatEvaluationValue(observation.metrics)}</pre>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {trial.error ? <p className="danger">{trial.error}</p> : null}
        {trial.targetProviderAttempts === undefined ? null : (
          <div className="evaluation-checks evaluation-result-block">
            <h4>Provider attempts</h4>
            <pre>{formatEvaluationValue(formatEvaluationTimingDiagnostics(trial.targetProviderAttempts))}</pre>
          </div>
        )}
        <div className="evaluation-trial-footer">
          {recordings.length === 0 ? (
            <span className="muted">No replay recording is retained for this trial.</span>
          ) : (
            recordings.map((recording) =>
              expiredRecordingIds.has(recording.reference.id) ? (
                <span key={recording.reference.id} className="muted">
                  <span className="pill">expired</span> Temporary replay recording expired
                </span>
              ) : (
                <span key={recording.reference.id}>
                  <span className="pill">{recording.reference.retention}</span>{' '}
                  <Button
                    appearance="subtle"
                    className="evaluation-secondary-action"
                    onClick={() => onOpenRecording(recording.reference.id)}
                  >
                    {recording.label}
                  </Button>
                </span>
              ),
            )
          )}
        </div>
      </div>
    );
  },
);

EvaluationTrialDetails.displayName = 'EvaluationTrialDetails';

/** Detailed trial values are portable JSON and are serialized only when opened. */
function formatEvaluationValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** Presents nested timing diagnostics in seconds without changing stored fields. */
function formatEvaluationTimingDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(formatEvaluationTimingDiagnostics);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => {
      if (key === 'durationMs' && typeof nestedValue === 'number') {
        return ['duration', formatEvaluationDurationSeconds(nestedValue)];
      }
      if (key === 'averageLatencyMs' && typeof nestedValue === 'number') {
        return ['averageLatency', formatEvaluationDurationSeconds(nestedValue)];
      }
      if (key === 'medianLatencyMs' && typeof nestedValue === 'number') {
        return ['medianLatency', formatEvaluationDurationSeconds(nestedValue)];
      }
      if (key === 'p95LatencyMs' && typeof nestedValue === 'number') {
        return ['p95Latency', formatEvaluationDurationSeconds(nestedValue)];
      }
      return [key, formatEvaluationTimingDiagnostics(nestedValue)];
    }),
  );
}

import { css } from '@emotion/react';
import Button from '@atlaskit/button';
import type { FC } from 'react';

export type EvaluationSuiteWarningState = {
  mode: 'pass-fail' | 'scoring';
  hasQualityCriteria: boolean;
  projectAvailable: boolean;
  datasetExists: boolean;
  targetGraphExists: boolean;
  evaluatorGraphsExist: boolean;
  executionCount: number;
  hasInvalidDatasetDraft: boolean;
  hasInvalidDatasetValues: boolean;
  hasInvalidExecutionSetup: boolean;
  hasInvalidQualityChecks: boolean;
  hasInvalidExpectedValues: boolean;
  hasInvalidEvaluatorConfiguration: boolean;
  hasInvalidThresholdConfiguration: boolean;
  usesPromptDesignerDraft: boolean;
  hasDormantPassFailConfiguration: boolean;
  anotherEvaluationRunning: boolean;
};

export const getEvaluationSuiteWarnings = (state: EvaluationSuiteWarningState): string[] => {
  const warnings: string[] = [];
  // Assertions and aggregate thresholds are deliberately dormant in scoring
  // mode. Keep this guard in the shared warning formatter too, rather than
  // relying on every caller to have already stripped those pass/fail-only
  // validation results.
  const hasInvalidQualityChecks = state.mode === 'pass-fail' && state.hasInvalidQualityChecks;
  const hasInvalidThresholdConfiguration =
    state.mode === 'pass-fail' && state.hasInvalidThresholdConfiguration;
  if (!state.hasQualityCriteria) {
    warnings.push(
      state.mode === 'scoring'
        ? 'This scoring suite has no evaluator graph that returns result.score. Add one to run an evaluation. You can still run it as an execution benchmark to inspect outputs, latency, and accounting without producing a score.'
        : 'This suite has no required quality criteria. Add a required check, evaluator graph, or threshold to run an evaluation. You can still run it as an execution benchmark to inspect outputs, latency, and accounting without declaring the result passed or failed.',
    );
  }
  if (!state.projectAvailable) {
    warnings.push('Open a project containing this suite\'s target graph and any evaluator graphs before running it.');
  }
  if (!state.datasetExists) {
    warnings.push('The assigned evaluation dataset is missing. Select another dataset before running.');
  } else if (state.executionCount === 0) {
    warnings.push('Enable or add at least one dataset case before running this suite.');
  }
  if (state.projectAvailable && !state.targetGraphExists) {
    warnings.push('The target graph is missing from the open project. Select another graph before running.');
  }
  if (state.projectAvailable && state.targetGraphExists && !state.evaluatorGraphsExist) {
    warnings.push('An evaluator graph is missing from the open project. Repair or remove its evaluator.');
  }
  if (state.hasInvalidDatasetDraft) {
    warnings.push('Fix invalid dataset values before running this suite.');
  }
  if (state.hasInvalidDatasetValues) {
    warnings.push('Fix dataset values that do not match their declared field types before running.');
  }
  if (state.hasInvalidExecutionSetup) {
    warnings.push('Fix target input bindings, missing case input values, and execution settings before running.');
  }
  if (hasInvalidQualityChecks) {
    warnings.push('Fix the highlighted deterministic quality checks before running this evaluation.');
  }
  if (state.hasInvalidExpectedValues) {
    warnings.push(
      state.mode === 'scoring'
        ? 'Add missing required dataset values and fix values that do not match their declared field types.'
        : 'Add required expected values and fix values that do not match their quality checks.',
    );
  }
  if (state.hasInvalidEvaluatorConfiguration && state.evaluatorGraphsExist) {
    warnings.push(
      hasInvalidThresholdConfiguration
        ? 'Fix the highlighted evaluator graph and aggregate threshold settings before running.'
        : 'Fix the highlighted evaluator graph settings before running.',
    );
  } else if (hasInvalidThresholdConfiguration) {
    warnings.push('Fix the highlighted aggregate threshold settings before running.');
  }
  if (state.usesPromptDesignerDraft) {
    warnings.push(
      'This suite will run the current unsaved Prompt Designer configuration. That candidate is not written to the project.',
    );
  }
  if (state.hasDormantPassFailConfiguration) {
    warnings.push(
      'Existing deterministic checks and aggregate thresholds are preserved but ignored while this suite uses scoring. Switch back to Pass/fail to edit or apply them.',
    );
  }
  if (state.anotherEvaluationRunning) {
    warnings.push('Another evaluation is already running for this project.');
  }
  return warnings;
};

const styles = css`
  position: sticky;
  top: 0;
  z-index: 40;
  display: flow-root;
  height: 0;
  pointer-events: none;

  .evaluation-suite-run-status {
    display: flex;
    width: var(--evaluation-suite-status-width);
    max-width: calc(100% - 64px);
    box-sizing: border-box;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin: 12px 32px 0 auto;
    padding: 8px;
    border: 1px solid var(--grey-darkish);
    border-radius: 6px;
    background: color-mix(in srgb, var(--grey-darker) 96%, transparent);
    box-shadow: 0 3px 12px color-mix(in srgb, black 24%, transparent);
    pointer-events: auto;
  }

  .evaluation-suite-run-actions {
    display: flex;
    width: 100%;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
  }

  .evaluation-suite-run-count {
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
    line-height: 1.2;
    white-space: nowrap;
  }

  button.evaluation-suite-run-export {
    display: none;
  }

  .evaluation-suite-warnings {
    display: flex;
    width: 100%;
    box-sizing: border-box;
    flex-direction: column;
    gap: 5px;
    margin: 0;
    padding: 9px 12px 9px 28px;
    border: 1px solid color-mix(in srgb, var(--warning) 30%, var(--grey-darkish));
    border-radius: 5px;
    background: color-mix(in srgb, var(--warning) 8%, var(--grey-darker));
    color: var(--warning);
    text-align: left;
  }

  button.evaluation-run-button {
    background: var(--success);
    color: var(--grey-lightest);
  }

  button.evaluation-run-button:hover:not(:disabled) {
    background: var(--success-dark);
  }

  button.evaluation-run-button.secondary:not(:disabled) {
    background: color-mix(in srgb, var(--success) 58%, var(--grey-darkish));
  }

  button.evaluation-run-button.secondary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--success-dark) 58%, var(--grey-darkish));
  }

  button.evaluation-run-button:disabled {
    background: var(--grey-darkish);
    box-shadow: none;
    color: var(--grey-light);
    cursor: not-allowed;
    opacity: 0.8;
  }

  @media (max-width: 1260px) {
    height: auto;

    .evaluation-suite-run-status {
      width: auto;
      max-width: none;
      margin: 0;
      border-right: 0;
      border-left: 0;
      border-radius: 0;
    }

    button.evaluation-suite-run-export {
      display: inline-flex;
    }
  }
`;

export const EvaluationSuiteRunStatus: FC<{
  warnings: readonly string[];
  targetExecutionLabel: string;
  isRunning: boolean;
  showBenchmark: boolean;
  benchmarkDisabled: boolean;
  evaluationDisabled: boolean;
  exportDisabled: boolean;
  benchmarkTitle?: string;
  evaluationTitle?: string;
  exportTitle?: string;
  onExport: () => void;
  onRunBenchmark: () => void;
  onRunEvaluation: () => void;
  onCancel: () => void;
}> = ({
  warnings,
  targetExecutionLabel,
  isRunning,
  showBenchmark,
  benchmarkDisabled,
  evaluationDisabled,
  exportDisabled,
  benchmarkTitle,
  evaluationTitle,
  exportTitle,
  onExport,
  onRunBenchmark,
  onRunEvaluation,
  onCancel,
}) => (
  <div css={styles}>
    <aside className="evaluation-suite-run-status" aria-label="Evaluation suite status">
      <div className="evaluation-suite-run-actions">
        <Button
          appearance="subtle"
          className="evaluation-secondary-action evaluation-suite-run-export"
          isDisabled={exportDisabled}
          title={exportTitle}
          onClick={onExport}
        >
          Export suite + dataset
        </Button>
        {isRunning ? (
          <Button appearance="danger" onClick={onCancel}>
            Cancel evaluation
          </Button>
        ) : (
          <>
            <Button
              appearance="primary"
              className="evaluation-run-button"
              isDisabled={evaluationDisabled}
              title={evaluationTitle}
              onClick={onRunEvaluation}
            >
              Run evaluation
            </Button>
            {showBenchmark ? (
              <Button
                className="evaluation-run-button secondary"
                isDisabled={benchmarkDisabled}
                title={benchmarkTitle}
                onClick={onRunBenchmark}
              >
                Run execution benchmark
              </Button>
            ) : null}
          </>
        )}
        <span className="evaluation-suite-run-count">{targetExecutionLabel}</span>
      </div>
      {warnings.length > 0 ? (
        <ul className="evaluation-suite-warnings" aria-label="Suite warnings">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </aside>
  </div>
);

import { css } from '@emotion/react';
import Button from '@atlaskit/button';
import Textfield from '@atlaskit/textfield';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { nanoid } from 'nanoid/non-secure';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parse as parseCsv } from 'csv-parse/browser/esm/sync';
import { stringify as stringifyCsv } from 'csv-stringify/browser/esm/sync';
import { toast } from 'react-toastify';
import {
  createEvaluationBaselineSnapshot,
  canonicalStringify,
  deserializeEvaluationDatasetJson,
  isEvaluationValueCompatibleWithDataType,
  normalizeEvaluationBaselineSnapshot,
  normalizeEvaluationRun,
  hasAuthoritativeEvaluationCriteria,
  serializeEvaluationDatasetJson,
  type EvaluationBaselineSnapshot,
  type EvaluationDataset,
  type EvaluationDatasetField,
  type EvaluationAssertionOperator,
  type EvaluationRun,
  type EvaluationRunPurpose,
  type EvaluationRecordingReference,
  type EvaluationSuite,
  type EvaluationThreshold,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';
import type { GraphInputNode, Project, ProjectId } from '@valerypopoff/rivet2-core';
import { graphState } from '../../state/graph.js';
import { projectState } from '../../state/savedGraphs.js';
import { evaluationsState } from '../../state/evaluations.js';
import { overlayOpenState } from '../../state/ui.js';
import { useEvaluationRunStore, useIOProvider } from '../../providers/ProvidersContext.js';
import { useLoadRecording } from '../../hooks/useLoadRecording.js';
import { CollapsiblePanel } from '../CollapsiblePanel.js';
import type { AbortEvaluation, TryRunEvaluation } from './api.js';
import { CreateEvaluationSuiteModal, type CreateEvaluationSuiteValue } from './CreateEvaluationSuiteModal.js';
import { EvaluationConfirmModal, type EvaluationConfirmation } from './EvaluationConfirmModal.js';
import { EvaluationFormField } from './EvaluationFormField.js';
import { EvaluationSectionTabs } from './EvaluationSectionTabs.js';
import { EvaluationSelect as Select } from './EvaluationSelect.js';
import { EvaluationSuiteSidebar } from './EvaluationSuiteSidebar.js';
import {
  canCompareEvaluationSuite,
  evaluationAssertionOperatorOptions,
  getEvaluationTargetOutputs,
  getEvaluationRunQualityPresentation,
  getEvaluationSuiteReferenceStatus,
  getEvaluationTargetOutputPath,
  getEvaluationAssertionAuthoringIssue,
  getEvaluationInputBindingAuthoringIssues,
  getEvaluationExpectedValueAuthoringIssues,
  getEvaluationEvaluatorAuthoringIssue,
  getEvaluationExecutionConfigurationAuthoringIssues,
  getEvaluationThresholdAuthoringIssue,
  getUnusedExpectedFields,
  resolveComparableEvaluationRun,
  resolveEvaluationTargetOutput,
  resolveProjectEvaluationDataset,
  resolvePromptDesignerEvaluationProject,
  resolveSelectedEvaluationSuite,
  suggestEvaluationAssertionOperator,
  type EvaluationTargetOutput,
  type EvaluationWorkspaceView,
} from './evaluationWorkspaceModel.js';

const styles = css`
  position: fixed;
  inset: var(--project-selector-height) 0 0;
  z-index: 150;
  display: grid;
  grid-template-columns: minmax(230px, 280px) minmax(0, 1fr);
  background: var(--grey-darker);
  color: var(--foreground);

  .evaluation-main {
    min-width: 0;
    overflow: auto;
  }
  .evaluation-suite-header {
    padding: 18px 32px 0;
    background: var(--grey-darker);
  }
  .evaluation-dataset-header h1 {
    margin: 0 0 5px;
    font-size: var(--ui-font-size-xl);
  }
  .evaluation-suite-title-row {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 5px;
  }
  .evaluation-suite-title-row h1 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--ui-font-size-xl);
  }
  .evaluation-suite-title-row .spacer {
    flex: 1;
  }
  .evaluation-run-actions {
    display: flex;
    align-items: center;
    gap: 8px;
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
  .evaluation-suite-subtitle {
    margin: 0 0 8px;
    color: var(--grey-light);
  }
  .evaluation-panel {
    padding: 24px 32px 44px;
  }
  .section {
    max-width: 950px;
    margin-bottom: 28px;
    padding-bottom: 22px;
    border-bottom: 1px solid color-mix(in srgb, var(--grey-light) 18%, transparent);
  }
  .section h2 {
    margin: 0 0 8px;
  }
  .section h3 {
    margin: 18px 0 8px;
  }
  .section > p {
    margin: 0;
    line-height: 1.5;
  }
  .section > .warning {
    margin-top: 14px;
  }
  .section > .evaluation-form-grid + p {
    margin-top: 14px;
  }
  .muted {
    color: var(--grey-light);
    max-width: 760px;
    line-height: 1.5;
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 10px;
  }
  .row > * {
    min-width: 0;
  }
  .row .field {
    flex: 1;
  }
  .evaluation-form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
    margin-top: 16px;
  }
  .evaluation-execution-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 18px 16px;
    margin-top: 16px;
  }
  .evaluation-execution-grid .evaluation-field-description {
    min-height: 2.7em;
  }
  .evaluation-dataset-metadata {
    display: flex;
    max-width: 760px;
    flex-direction: column;
    gap: 16px;
    margin-top: 16px;
  }
  .evaluation-dataset-usage {
    display: flex;
    max-width: 760px;
    flex-direction: column;
    gap: 6px;
    margin-top: 16px;
    padding: 12px 14px;
    border: 1px solid var(--grey-darkish);
    border-radius: 6px;
    background: var(--grey-dark);
  }
  .evaluation-dataset-usage > span {
    color: var(--grey-light);
  }
  .evaluation-dataset-usage > div {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .evaluation-value-editor {
    min-width: 150px;
  }
  .evaluation-value-error {
    display: block;
    margin-top: 4px;
    color: var(--error);
    font-size: var(--ui-font-size-sm);
    line-height: 1.3;
  }
  .evaluation-field-type {
    display: block;
    margin-top: 2px;
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
    font-weight: 400;
  }
  .evaluation-editor-list {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 14px;
  }
  .evaluation-editor-card {
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    gap: 14px;
    padding: 16px;
    border: 1px solid var(--grey-darkish);
    border-radius: 6px;
    background: var(--grey-dark);
  }
  .evaluation-editor-card > .field {
    grid-column: span 3;
  }
  .evaluation-editor-card > .field.wide {
    grid-column: span 6;
  }
  .evaluation-editor-card > .field.full {
    grid-column: 1 / -1;
  }
  .evaluation-editor-card-actions {
    display: flex;
    grid-column: 1 / -1;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-top: 2px;
  }
  .evaluation-checkboxes {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .evaluation-checkboxes label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .evaluation-section-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 14px;
  }
  .evaluation-unused-fields {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 14px;
    padding: 12px 14px;
    border: 1px solid color-mix(in srgb, var(--warning) 30%, var(--grey-darkish));
    border-radius: 6px;
    background: color-mix(in srgb, var(--warning) 7%, transparent);
  }
  .evaluation-authoring-issues {
    max-width: 760px;
    margin-top: 14px;
    padding: 12px 14px;
    border: 1px solid color-mix(in srgb, var(--warning) 30%, var(--grey-darkish));
    border-radius: 6px;
    background: color-mix(in srgb, var(--warning) 7%, transparent);
    color: var(--warning);
    line-height: 1.45;
  }
  .evaluation-authoring-issues ul {
    margin: 6px 0 0;
    padding-left: 20px;
  }
  .evaluation-unused-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .evaluation-unused-field-copy {
    min-width: 0;
  }
  .evaluation-unused-field-copy strong,
  .evaluation-unused-field-copy span {
    display: block;
  }
  .evaluation-unused-field-copy span {
    margin-top: 2px;
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
  }
  .evaluation-advanced-path {
    grid-column: 1 / -1;
  }
  .evaluation-advanced-path summary {
    width: fit-content;
    cursor: pointer;
    color: var(--grey-light);
  }
  .evaluation-advanced-path .field {
    max-width: 620px;
    margin-top: 10px;
  }
  @media (max-width: 1100px) {
    .evaluation-editor-card > .field,
    .evaluation-editor-card > .field.wide {
      grid-column: span 6;
    }
    .evaluation-execution-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 760px) {
    .evaluation-editor-card > .field,
    .evaluation-editor-card > .field.wide {
      grid-column: 1 / -1;
    }
    .evaluation-execution-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .evaluation-execution-grid .evaluation-field-description {
      min-height: 0;
    }
  }
  .table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 12px;
  }
  .table th,
  .table td {
    text-align: left;
    border-bottom: 1px solid var(--grey-darkish);
    padding: 9px 8px;
    vertical-align: top;
  }
  .table th {
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
  }
  .status-pass {
    color: var(--success);
  }
  .status-fail {
    color: var(--error);
  }
  .status-not-evaluated {
    color: var(--grey-light);
  }
  .status-unable-to-evaluate {
    color: var(--warning);
  }
  .evaluation-run-summary-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 16px;
  }
  .evaluation-run-summary-item {
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--grey-darkish);
    border-radius: 6px;
    background: var(--grey-dark);
  }
  .evaluation-run-summary-label {
    display: block;
    margin-bottom: 5px;
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
  }
  .evaluation-run-summary-value {
    display: block;
    overflow: hidden;
    color: var(--foreground);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .evaluation-run-explanation,
  .evaluation-run-no-checks {
    max-width: 850px;
    margin: 14px 0 0;
    padding: 12px 14px;
    border-radius: 6px;
    line-height: 1.45;
  }
  .evaluation-run-explanation {
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    color: var(--foreground);
  }
  .evaluation-run-no-checks {
    background: color-mix(in srgb, var(--grey-light) 9%, transparent);
    color: var(--grey-light);
  }
  .evaluation-threshold-results {
    max-width: 950px;
    margin-top: 18px;
  }
  .evaluation-threshold-results h3 {
    margin: 0 0 8px;
  }
  .evaluation-threshold-result-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .evaluation-threshold-result {
    min-width: 0;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--grey-light) 16%, transparent);
    border-radius: 6px;
    background: var(--grey-dark);
  }
  .evaluation-threshold-result-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .evaluation-threshold-result-heading strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .evaluation-threshold-result p {
    margin: 7px 0 0;
    line-height: 1.4;
  }
  .evaluation-trial-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 18px;
  }
  .evaluation-trial-toggle-summary {
    display: grid;
    width: 100%;
    min-width: 0;
    grid-template-columns: minmax(140px, 1fr) auto auto auto;
    align-items: center;
    gap: 14px;
    text-align: left;
  }
  .evaluation-trial-toggle-summary .trial-case {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .evaluation-trial-toggle-summary .trial-duration {
    color: var(--grey-light);
    font-weight: 400;
  }
  .evaluation-trial-content {
    padding: 16px;
  }
  .evaluation-trial-results {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
  }
  .evaluation-result-block,
  .evaluation-observation {
    min-width: 0;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--grey-light) 16%, transparent);
    border-radius: 6px;
    background: var(--grey-dark);
  }
  .evaluation-result-block h4,
  .evaluation-checks h4,
  .evaluation-observation h5 {
    margin: 0 0 8px;
  }
  .evaluation-result-block pre,
  .evaluation-observation pre {
    max-height: 280px;
    margin: 0;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
  }
  .evaluation-checks {
    margin-top: 16px;
  }
  .evaluation-observation-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .evaluation-observation-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .evaluation-observation-heading h5 {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .evaluation-observation p {
    margin: 8px 0 0;
    line-height: 1.45;
  }
  .evaluation-observation-evidence {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 10px;
  }
  .evaluation-observation-evidence > div {
    min-width: 0;
    padding: 10px;
    border: 1px solid color-mix(in srgb, var(--grey-light) 12%, transparent);
    border-radius: 4px;
  }
  .evaluation-observation-evidence h6 {
    margin: 0 0 6px;
    color: var(--grey-light);
  }
  .evaluation-trial-footer {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 16px;
  }
  @media (max-width: 1000px) {
    .evaluation-run-summary-grid,
    .evaluation-trial-results,
    .evaluation-observation-list,
    .evaluation-threshold-result-list {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 700px) {
    .evaluation-run-summary-grid,
    .evaluation-trial-results,
    .evaluation-observation-list,
    .evaluation-threshold-result-list {
      grid-template-columns: minmax(0, 1fr);
    }
    .evaluation-observation-evidence {
      grid-template-columns: minmax(0, 1fr);
    }
    .evaluation-trial-toggle-summary {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .evaluation-trial-toggle-summary .trial-duration {
      display: none;
    }
  }
  .empty {
    margin: 0;
    padding: 32px 0;
    color: var(--grey-light);
  }
  .workspace-empty {
    display: flex;
    min-height: 60vh;
    align-items: center;
    justify-content: center;
    padding: 40px;
    text-align: center;
  }
  .workspace-empty-content {
    max-width: 560px;
  }
  .workspace-empty h1 {
    margin: 0 0 10px;
    font-size: var(--ui-font-size-xl);
    color: var(--foreground);
  }
  .workspace-empty p {
    margin: 0 auto 18px;
    color: var(--grey-light);
  }
  .workspace-empty-actions {
    display: flex;
    justify-content: center;
    gap: 8px;
  }
  .warning {
    color: var(--warning);
  }
  .danger {
    color: var(--error);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--grey-darkish);
    border-radius: 999px;
    padding: 2px 8px;
    font-size: var(--ui-font-size-sm);
  }
`;

function createDataset(projectId: ProjectId, suiteName = 'New evaluation suite'): EvaluationDataset {
  return { id: nanoid(), projectId, name: `${suiteName} dataset`, fields: [], cases: [] };
}

function createStandaloneDataset(projectId: ProjectId): EvaluationDataset {
  return { id: nanoid(), projectId, name: 'New evaluation dataset', fields: [], cases: [] };
}

function createSuite(dataset: EvaluationDataset, graphId: string, name = 'New evaluation suite'): EvaluationSuite {
  return {
    id: nanoid(),
    name,
    targetGraphId: graphId as EvaluationSuite['targetGraphId'],
    datasetId: dataset.id,
    inputBindings: [],
    assertions: [],
    evaluators: [],
    configuration: { trialCount: 1, concurrency: 4, recordingRetention: 'failures-and-baselines' },
    thresholds: [],
  };
}

function safeJson(value: string): PortableJson | undefined {
  try {
    return JSON.parse(value) as PortableJson;
  } catch {
    return undefined;
  }
}

/**
 * JSON cells must retain the author's in-progress text. Updating the project
 * state on every keypress would turn `{` or an unfinished string into an empty
 * value before it can become valid JSON.
 */
const JsonValueEditor: FC<{
  dataType?: string;
  value: PortableJson | undefined;
  placeholder?: string;
  allowEmpty?: boolean;
  onCommit: (value: PortableJson | undefined) => void;
  onValidityChange?: (invalid: boolean) => void;
}> = ({
  dataType = 'any',
  value,
  placeholder = 'JSON value',
  allowEmpty = true,
  onCommit,
  onValidityChange = () => undefined,
}) => {
  const serialized = value === undefined ? '' : JSON.stringify(value);
  const [draft, setDraft] = useState(serialized);
  const onValidityChangeRef = useRef(onValidityChange);
  const parsed = draft === '' ? undefined : safeJson(draft);
  const isInvalid =
    draft !== '' && (parsed === undefined || !isEvaluationValueCompatibleWithDataType(parsed, dataType));

  useEffect(() => {
    onValidityChangeRef.current = onValidityChange;
  }, [onValidityChange]);

  useEffect(() => {
    setDraft(serialized);
    onValidityChangeRef.current(value !== undefined && !isEvaluationValueCompatibleWithDataType(value, dataType));
  }, [dataType, serialized, value]);

  const updateDraft = (nextDraft: string) => {
    setDraft(nextDraft);
    if (nextDraft === '') {
      onValidityChangeRef.current(false);
      if (allowEmpty) onCommit(undefined);
      return;
    }
    const nextValue = safeJson(nextDraft);
    const invalid = nextValue === undefined || !isEvaluationValueCompatibleWithDataType(nextValue, dataType);
    onValidityChangeRef.current(invalid);
    if (!invalid) onCommit(nextValue);
  };

  return (
    <div className="evaluation-value-editor">
      <Textfield
        value={draft}
        placeholder={placeholder}
        aria-invalid={isInvalid || undefined}
        onChange={(event) => updateDraft(event.currentTarget.value)}
      />
      {isInvalid ? <span className="evaluation-value-error">Enter valid {dataType} JSON.</span> : null}
    </div>
  );
};

const DatasetValueEditor: FC<{
  dataType: string;
  value: PortableJson | undefined;
  onCommit: (value: PortableJson | undefined) => void;
  onValidityChange: (invalid: boolean) => void;
}> = ({ dataType, value, onCommit, onValidityChange }) => {
  const onValidityChangeRef = useRef(onValidityChange);

  useEffect(() => {
    onValidityChangeRef.current = onValidityChange;
  }, [onValidityChange]);

  useEffect(() => {
    if (dataType !== 'string' && dataType !== 'boolean') return;
    onValidityChangeRef.current(value !== undefined && !isEvaluationValueCompatibleWithDataType(value, dataType));
  }, [dataType, value]);

  if (dataType === 'string') {
    return (
      <Textfield
        value={typeof value === 'string' ? value : ''}
        placeholder="Text value"
        aria-invalid={value !== undefined && typeof value !== 'string' ? true : undefined}
        onChange={(event) => onCommit(event.currentTarget.value)}
      />
    );
  }

  if (dataType === 'number') {
    return (
      <JsonValueEditor
        dataType={dataType}
        value={value}
        placeholder="Number"
        onCommit={onCommit}
        onValidityChange={onValidityChange}
      />
    );
  }

  if (dataType === 'boolean') {
    const options = [
      { label: 'true', value: true },
      { label: 'false', value: false },
    ];
    return (
      <Select
        isClearable
        options={options}
        value={options.find((option) => option.value === value)}
        placeholder="Choose true or false"
        onChange={(option) => onCommit(option?.value)}
      />
    );
  }

  const placeholder =
    dataType === 'string[]'
      ? '["value"]'
      : dataType === 'object[]'
        ? '[{"key":"value"}]'
        : dataType === 'object'
          ? '{"key":"value"}'
          : 'JSON value';
  return (
    <JsonValueEditor
      dataType={dataType}
      value={value}
      placeholder={placeholder}
      onCommit={onCommit}
      onValidityChange={onValidityChange}
    />
  );
};

function updateDatasetCaseValue(
  dataset: EvaluationDataset,
  caseId: string,
  fieldId: string,
  value: PortableJson | undefined,
): EvaluationDataset {
  return {
    ...dataset,
    cases: dataset.cases.map((testCase) => {
      if (testCase.id !== caseId) return testCase;
      const values = { ...testCase.values };
      if (value === undefined) delete values[fieldId];
      else values[fieldId] = value;
      return { ...testCase, values };
    }),
  };
}

function relativeDelta(current: number | undefined, baseline: number | undefined): string {
  if (current === undefined || baseline === undefined) return '—';
  if (baseline === 0) return current === 0 ? '0%' : 'new';
  const percent = ((current - baseline) / Math.abs(baseline)) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

function humanizeEvaluationMetric(metric: string): string {
  const name = metric.startsWith('custom:') ? metric.slice('custom:'.length) : metric;
  return name.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatEvaluationMetricValue(metric: string, value: number | undefined): string {
  if (value === undefined) return 'Unavailable';
  if (['pass-rate', 'mean-score', 'target-error-rate', 'evaluator-error-rate', 'tool-failure-rate'].includes(metric)) {
    return `${(value * 100).toFixed(value * 100 === Math.round(value * 100) ? 0 : 1)}%`;
  }
  if (metric === 'average-cost' || metric === 'total-cost') return `$${value.toFixed(4)}`;
  if (metric === 'average-latency-ms' || metric === 'p95-latency-ms') return `${Math.round(value)} ms`;
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function describeEvaluationThreshold(metric: string, operator: EvaluationThreshold['operator'], value: number): string {
  if (operator === 'at-least') return `At least ${formatEvaluationMetricValue(metric, value)}`;
  if (operator === 'at-most') return `At most ${formatEvaluationMetricValue(metric, value)}`;
  return `Regression no greater than ${formatEvaluationMetricValue('pass-rate', value)}`;
}

function formatEvaluationComparisonMetric(label: string, value: number | undefined): string {
  if (value === undefined) return label === 'Total cost' ? 'Unavailable' : '—';
  if (label === 'Pass rate') return `${Math.round(value * 100)}%`;
  if (label === 'P95 latency') return `${Math.round(value)} ms`;
  if (label === 'Total cost') return `$${value.toFixed(4)}`;
  return value.toFixed(4);
}

export const EvaluationsRenderer: FC<{ tryRunEvaluation: TryRunEvaluation; abortEvaluation: AbortEvaluation }> = ({
  tryRunEvaluation,
  abortEvaluation,
}) => {
  const openOverlay = useAtomValue(overlayOpenState);
  if (openOverlay !== 'evaluations') return null;
  return <EvaluationsContainer tryRunEvaluation={tryRunEvaluation} abortEvaluation={abortEvaluation} />;
};

const EvaluationsContainer: FC<{ tryRunEvaluation: TryRunEvaluation; abortEvaluation: AbortEvaluation }> = ({
  tryRunEvaluation,
  abortEvaluation,
}) => {
  const [state, setState] = useAtom(evaluationsState);
  const project = useAtomValue(projectState);
  const runStore = useEvaluationRunStore();
  const { loadSerializedRecording } = useLoadRecording();
  const graph = useAtomValue(graphState);
  const setOpenOverlay = useSetAtom(overlayOpenState);
  const view = state.activeView ?? 'definition';
  const setView = useCallback(
    (nextView: EvaluationWorkspaceView) =>
      setState((current) => (current.activeView === nextView ? current : { ...current, activeView: nextView })),
    [setState],
  );
  const [createSuiteOpen, setCreateSuiteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<EvaluationConfirmation>();
  const [hasInvalidDatasetDraft, setHasInvalidDatasetDraft] = useState(false);
  const [runsStatus, setRunsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [runsError, setRunsError] = useState<string>();
  const selectedSuite = resolveSelectedEvaluationSuite(state.data.suites, state.data.selectedSuiteId);
  const selectedSuiteId = selectedSuite?.id;
  const projectDatasets = state.datasets.filter((dataset) => dataset.projectId === project.metadata.id);
  const selectedDataset = resolveProjectEvaluationDataset(
    state.datasets,
    project.metadata.id,
    state.data.selectedDatasetId,
  );
  const selectedDatasetSuites = selectedDataset
    ? state.data.suites.filter((suite) => suite.datasetId === selectedDataset.id)
    : [];
  // A project saved by an older editor can retain both selections. The active
  // view still disambiguates it; new navigation always selects exactly one
  // peer resource.
  const showingDataset = selectedDataset != null && (view === 'dataset' || selectedSuite == null);
  const suiteDataset = resolveProjectEvaluationDataset(state.datasets, project.metadata.id, selectedSuite?.datasetId);
  const graphOptions = useMemo(
    () =>
      Object.values(project.graphs)
        .map((candidate) => ({
          label: candidate.metadata?.name ?? candidate.metadata?.id ?? 'Unnamed graph',
          value: candidate.metadata?.id ?? '',
        }))
        .filter((option) => option.value !== ''),
    [project.graphs],
  );
  const referenceStatus = selectedSuite
    ? getEvaluationSuiteReferenceStatus(selectedSuite, project, state.datasets)
    : undefined;
  const suiteRuns = selectedSuite ? state.runs.filter((run) => run.suiteId === selectedSuite.id) : [];
  const suiteCurrentRun = state.currentRun?.suiteId === selectedSuite?.id ? state.currentRun : undefined;
  const suiteBaseline = selectedSuite
    ? state.data.baselines.find((candidate) => candidate.suiteId === selectedSuite.id)
    : undefined;
  const compareAvailable = selectedSuite
    ? canCompareEvaluationSuite(selectedSuite.id, suiteRuns, state.data.baselines)
    : false;
  const comparableRun = selectedSuite
    ? resolveComparableEvaluationRun(selectedSuite.id, suiteRuns, state.selectedRunId, suiteCurrentRun)
    : undefined;

  const updateSuite = (update: (suite: EvaluationSuite) => EvaluationSuite) =>
    setState((current) => ({
      ...current,
      data: {
        ...current.data,
        suites: current.data.suites.map((suite) => (suite.id === selectedSuite?.id ? update(suite) : suite)),
      },
    }));

  const addSuite = ({ datasetId, graphId, name }: CreateEvaluationSuiteValue) =>
    setState((current) => {
      const existingDataset =
        datasetId == null
          ? undefined
          : current.datasets.find((dataset) => dataset.id === datasetId && dataset.projectId === project.metadata.id);
      const dataset = existingDataset ?? createDataset(project.metadata.id, name);
      const suite = createSuite(dataset, graphId, name);
      return {
        ...current,
        datasets: existingDataset == null ? [...current.datasets, dataset] : current.datasets,
        data: {
          ...current.data,
          suites: [...current.data.suites, suite],
          selectedSuiteId: suite.id,
          selectedDatasetId: undefined,
        },
        runs: [],
        selectedRunId: undefined,
      };
    });

  const createSuiteFromDialog = (value: CreateEvaluationSuiteValue) => {
    addSuite(value);
    setCreateSuiteOpen(false);
    setView('definition');
  };

  const selectSuite = (suiteId: string) => {
    setView('definition');
    setState((current) => ({
      ...current,
      data: {
        ...current.data,
        selectedSuiteId: suiteId,
        selectedDatasetId: undefined,
      },
      runs: [],
      selectedRunId: undefined,
    }));
  };

  const selectDataset = (datasetId: string) => {
    setView('dataset');
    setState((current) => ({
      ...current,
      data: {
        ...current.data,
        selectedSuiteId: undefined,
        selectedDatasetId: datasetId,
      },
      runs: [],
      selectedRunId: undefined,
    }));
  };

  const createDatasetResource = () => {
    const dataset = createStandaloneDataset(project.metadata.id);
    setState((current) => ({
      ...current,
      datasets: [...current.datasets, dataset],
      data: {
        ...current.data,
        selectedSuiteId: undefined,
        selectedDatasetId: dataset.id,
      },
      runs: [],
      selectedRunId: undefined,
    }));
    setView('dataset');
  };

  const addCase = (sourceDataset: EvaluationDataset) => {
    const testCase = {
      id: nanoid(),
      name: `Case ${sourceDataset.cases.length + 1}`,
      enabled: true,
      values: {} as Record<string, PortableJson>,
    };
    setState((current) => ({
      ...current,
      datasets: current.datasets.map((dataset) =>
        dataset.id === sourceDataset.id && dataset.projectId === sourceDataset.projectId
          ? { ...dataset, cases: [...dataset.cases, testCase] }
          : dataset,
      ),
    }));
  };

  const assignSuiteDataset = (datasetId: string) => {
    if (!selectedSuite || datasetId === selectedSuite.datasetId) return;
    if (resolveProjectEvaluationDataset(state.datasets, project.metadata.id, datasetId) == null) {
      toast.error('Choose an evaluation dataset from the active project.');
      return;
    }
    const hasDatasetContracts =
      selectedSuite.inputBindings.length > 0 ||
      selectedSuite.assertions.some((assertion) => assertion.expected.kind === 'dataset-field');
    if (hasDatasetContracts) {
      setConfirmation({
        title: 'Change evaluation dataset?',
        description:
          'Changing the dataset clears this suite’s input bindings and replaces expected values used by deterministic checks with null literals.',
        confirmLabel: 'Change dataset',
        onConfirm: () => commitSuiteDatasetAssignment(selectedSuite.id, datasetId),
      });
      return;
    }
    commitSuiteDatasetAssignment(selectedSuite.id, datasetId);
  };

  const commitSuiteDatasetAssignment = (suiteId: string, datasetId: string) => {
    setState((current) => ({
      ...current,
      data: {
        ...current.data,
        suites: current.data.suites.map((suite) =>
          suite.id === suiteId
            ? {
                ...suite,
                datasetId,
                inputBindings: [],
                assertions: suite.assertions.map((assertion) =>
                  assertion.expected.kind === 'dataset-field'
                    ? { ...assertion, expected: { kind: 'literal' as const, value: null } }
                    : assertion,
                ),
              }
            : suite,
        ),
      },
    }));
  };

  const assignTargetGraph = (graphId: string) => {
    if (!selectedSuite || graphId === selectedSuite.targetGraphId) return;
    if (selectedSuite.inputBindings.length > 0) {
      setConfirmation({
        title: 'Change target graph?',
        description: 'Changing the target graph clears this suite’s existing Graph Input bindings.',
        confirmLabel: 'Change graph',
        onConfirm: () => commitTargetGraphAssignment(selectedSuite.id, graphId),
      });
      return;
    }
    commitTargetGraphAssignment(selectedSuite.id, graphId);
  };

  const commitTargetGraphAssignment = (suiteId: string, graphId: string) => {
    setState((current) => ({
      ...current,
      data: {
        ...current.data,
        suites: current.data.suites.map((suite) =>
          suite.id === suiteId
            ? { ...suite, targetGraphId: graphId as EvaluationSuite['targetGraphId'], inputBindings: [] }
            : suite,
        ),
      },
    }));
  };

  const targetInputs =
    selectedSuite && referenceStatus?.targetGraphExists
      ? (project.graphs[selectedSuite.targetGraphId]?.nodes.filter((node) => node.type === 'graphInput') as
          | GraphInputNode[]
          | undefined) ?? []
      : [];
  const targetOutputs =
    selectedSuite && referenceStatus?.targetGraphExists
      ? getEvaluationTargetOutputs(project.graphs[selectedSuite.targetGraphId]?.nodes ?? [])
      : [];
  const hasQualityCriteria = selectedSuite ? hasAuthoritativeEvaluationCriteria(selectedSuite) : false;
  const hasInvalidQualityChecks =
    selectedSuite?.assertions.some((assertion) =>
      Boolean(
        getEvaluationAssertionAuthoringIssue(
          assertion,
          targetOutputs,
          suiteDataset?.fields.filter((field) => field.role === 'expected') ?? [],
        ),
      ),
    ) ?? false;
  const expectedValueIssues =
    selectedSuite && suiteDataset ? getEvaluationExpectedValueAuthoringIssues(selectedSuite, suiteDataset) : [];
  const hasInvalidExpectedValues = expectedValueIssues.length > 0;
  const hasInvalidEvaluationConfiguration =
    (selectedSuite?.evaluators.some((evaluator) => getEvaluationEvaluatorAuthoringIssue(evaluator, project)) ??
      false) ||
    (selectedSuite?.thresholds?.some((threshold) => getEvaluationThresholdAuthoringIssue(threshold, selectedSuite)) ??
      false);
  const inputBindingIssues =
    selectedSuite && suiteDataset
      ? getEvaluationInputBindingAuthoringIssues(selectedSuite, suiteDataset, targetInputs)
      : [];
  const executionConfigurationIssues = selectedSuite
    ? getEvaluationExecutionConfigurationAuthoringIssues(selectedSuite, targetInputs)
    : [];
  const hasInvalidExecutionSetup = inputBindingIssues.length > 0 || executionConfigurationIssues.length > 0;
  const executionCount =
    (suiteDataset?.cases.filter((testCase) => testCase.enabled !== false).length ?? 0) *
    (selectedSuite?.configuration?.trialCount ?? 1);
  const targetExecutionLabel = `${executionCount} target execution${executionCount === 1 ? '' : 's'}`;
  const projectedGraphExecutions = executionCount * (1 + (selectedSuite?.evaluators.length ?? 0));

  useEffect(() => {
    if (!selectedSuiteId) {
      setRunsStatus('idle');
      setRunsError(undefined);
      setState((current) =>
        current.runs.length === 0 && current.selectedRunId == null && current.currentRun == null
          ? current
          : { ...current, runs: [], selectedRunId: undefined, currentRun: undefined },
      );
      return;
    }

    let active = true;
    setRunsStatus('loading');
    setRunsError(undefined);
    void runStore
      .list({ projectId: project.metadata.id, suiteId: selectedSuiteId })
      .then((runs) => {
        if (!active) return;
        setRunsStatus('ready');
        setState((current) => ({
          ...current,
          runs: [...runs],
          selectedRunId:
            current.selectedRunId && runs.some((run) => run.id === current.selectedRunId)
              ? current.selectedRunId
              : runs[0]?.id,
        }));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRunsStatus('error');
        setRunsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [project.metadata.id, runStore, selectedSuiteId, setState, state.runningSuiteId]);

  useEffect(() => {
    if (view === 'dataset' && !selectedDataset) setView('definition');
    if (view === 'compare' && !compareAvailable) setView('runs');
  }, [compareAvailable, selectedDataset, setView, view]);

  useEffect(() => {
    setConfirmation(undefined);
  }, [project.metadata.id, selectedSuiteId]);

  useEffect(() => {
    if (!state.requestedView) return;
    const requestedView = state.requestedView;
    const allowed =
      (requestedView === 'dataset' && selectedDataset != null) ||
      (requestedView !== 'dataset' && selectedSuite != null && (requestedView !== 'compare' || compareAvailable));
    setView(allowed ? requestedView : 'definition');
    setState((current) => ({ ...current, requestedView: undefined }));
  }, [compareAvailable, selectedDataset, selectedSuite, setState, setView, state.requestedView]);

  const runSelectedEvaluation = (purpose: EvaluationRunPurpose) => {
    if (!selectedSuite) return;
    const promptDesignerCandidate = resolvePromptDesignerEvaluationProject(
      state.promptDesignerProjectOverride,
      project.metadata.id,
      selectedSuite.targetGraphId,
    );
    void tryRunEvaluation({ suiteId: selectedSuite.id, purpose, projectOverride: promptDesignerCandidate });
  };

  const startEvaluation = (purpose: EvaluationRunPurpose) => {
    if (
      !selectedSuite ||
      hasInvalidDatasetDraft ||
      hasInvalidExecutionSetup ||
      (purpose === 'evaluation' &&
        (hasInvalidQualityChecks ||
          hasInvalidExpectedValues ||
          hasInvalidEvaluationConfiguration ||
          !referenceStatus?.evaluatorGraphsExist)) ||
      !referenceStatus?.datasetExists ||
      !referenceStatus.targetGraphExists
    ) {
      return;
    }
    if (state.runningSuiteId !== undefined) return;
    const projectedExecutionsForPurpose =
      executionCount * (1 + (purpose === 'evaluation' ? selectedSuite.evaluators.length : 0));
    if (projectedExecutionsForPurpose >= 100) {
      setConfirmation({
        title: 'Run a large evaluation?',
        description: `This ${purpose === 'evaluation' ? 'evaluation' : 'execution benchmark'} can start up to ${projectedExecutionsForPurpose} graph executions. ${purpose === 'evaluation' ? 'Target and evaluator graph costs' : 'Target graph costs'} depend on their configured providers.`,
        confirmLabel: purpose === 'evaluation' ? 'Run evaluation' : 'Run execution benchmark',
        onConfirm: () => runSelectedEvaluation(purpose),
      });
      return;
    }
    runSelectedEvaluation(purpose);
  };

  const openRecording = async (recordingId: string) => {
    try {
      const artifact = await runStore.getRecording({ projectId: project.metadata.id, recordingId });
      if (!artifact) {
        toast.info(
          'This evaluation recording is no longer retained. Run the suite again to create a new replay artifact.',
        );
        return;
      }
      if (
        loadSerializedRecording({
          serialized: artifact.serialized,
          path: `Evaluation recording · ${artifact.reference.id}`,
          projectId: artifact.projectId,
        })
      ) {
        setOpenOverlay(undefined);
      }
    } catch (error) {
      toast.error(
        `Could not retrieve the evaluation recording: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const promoteBaseline = async () => {
    const run = comparableRun;
    if (!run || !selectedSuite) return;
    const recordingCount = run.trials.reduce(
      (count, trial) =>
        count +
        Number(trial.recording != null) +
        trial.observations.filter((observation) => observation.recording != null).length,
      0,
    );
    if (recordingCount === 0) {
      toast.warn('Only a run with retained replay artifacts can become an evaluation baseline.');
      return;
    }

    // Validate before pinning artifacts in the run store. In particular, a
    // canceled run must not leave permanently retained recordings behind.
    let baseline: EvaluationBaselineSnapshot;
    try {
      baseline = createEvaluationBaselineSnapshot(run);
    } catch (error) {
      toast.warn(error instanceof Error ? error.message : String(error));
      return;
    }

    try {
      await runStore.promoteBaseline({ projectId: project.metadata.id, runId: run.id });
      const retained = (reference: { id: string }) => ({ id: reference.id, retention: 'baseline' as const });
      const promoteRun = (candidate: EvaluationRun): EvaluationRun =>
        candidate.id !== run.id
          ? candidate
          : {
              ...candidate,
              trials: candidate.trials.map((trial) => ({
                ...trial,
                ...(trial.recording == null ? {} : { recording: retained(trial.recording) }),
                observations: trial.observations.map((observation) =>
                  observation.recording == null
                    ? observation
                    : { ...observation, recording: retained(observation.recording) },
                ),
              })),
            };
      setState((current) => ({
        ...current,
        currentRun: current.currentRun ? promoteRun(current.currentRun) : undefined,
        runs: current.runs.map(promoteRun),
        data: {
          ...current.data,
          baselines: [
            ...current.data.baselines.filter((candidate) => candidate.suiteId !== selectedSuite.id),
            baseline,
          ],
        },
      }));
    } catch (error) {
      toast.error(
        `Could not promote the evaluation baseline: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return (
    <div css={styles}>
      <EvaluationSuiteSidebar
        canCreateDataset
        canCreateSuite={graphOptions.length > 0}
        datasets={projectDatasets}
        getDatasetUsage={(dataset) => {
          const usage = state.data.suites.filter((suite) => suite.datasetId === dataset.id).length;
          return `${usage} evaluation suite${usage === 1 ? '' : 's'}`;
        }}
        selectedSuiteId={showingDataset ? undefined : selectedSuite?.id}
        selectedDatasetId={showingDataset ? selectedDataset?.id : undefined}
        suites={state.data.suites}
        getGraphName={(suite) => project.graphs[suite.targetGraphId]?.metadata?.name ?? 'Missing target graph'}
        getReferenceStatus={(suite) => getEvaluationSuiteReferenceStatus(suite, project, state.datasets)}
        onCreateDataset={createDatasetResource}
        onCreateSuite={() => setCreateSuiteOpen(true)}
        onSelectDataset={selectDataset}
        onSelectSuite={selectSuite}
      />
      <main className="evaluation-main">
        {showingDataset ? (
          <>
            <header className="evaluation-suite-header evaluation-dataset-header">
              <h1>{selectedDataset.name || 'Untitled evaluation dataset'}</h1>
              <p className="evaluation-suite-subtitle">
                Evaluation dataset · Used by {selectedDatasetSuites.length} evaluation suite
                {selectedDatasetSuites.length === 1 ? '' : 's'}
              </p>
            </header>
            <div className="evaluation-panel">
              <Dataset
                dataset={selectedDataset}
                suites={selectedDatasetSuites}
                onAddCase={() => addCase(selectedDataset)}
                onInvalidDraftChange={setHasInvalidDatasetDraft}
                onOpenSuite={selectSuite}
                onUpdate={(dataset) =>
                  setState((current) => ({
                    ...current,
                    datasets: current.datasets.map((item) =>
                      item.id === dataset.id && item.projectId === dataset.projectId ? dataset : item,
                    ),
                  }))
                }
              />
            </div>
          </>
        ) : !selectedSuite ? (
          <div className="workspace-empty">
            <div className="workspace-empty-content">
              <h1>
                {state.data.suites.length === 0 && projectDatasets.length === 0
                  ? 'Create an evaluation suite or dataset'
                  : 'Select an evaluation suite or dataset'}
              </h1>
              <p>
                {state.data.suites.length === 0 && projectDatasets.length === 0
                  ? graphOptions.length === 0
                    ? 'Create an evaluation dataset now, then create a graph before adding a suite that runs it.'
                    : 'Create a suite for a graph, or create a reusable dataset first.'
                  : 'Suites run graphs against datasets. Select either resource from the left to edit it.'}
              </p>
              <div className="workspace-empty-actions">
                {graphOptions.length > 0 ? (
                  <Button appearance="primary" onClick={() => setCreateSuiteOpen(true)}>
                    Create evaluation suite
                  </Button>
                ) : null}
                <Button onClick={createDatasetResource}>Create evaluation dataset</Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <header className="evaluation-suite-header">
              <div className="evaluation-suite-title-row">
                <h1>{selectedSuite.name || 'Untitled evaluation suite'}</h1>
                <div className="spacer" />
                {state.runningSuiteId === selectedSuite.id ? (
                  <Button appearance="danger" onClick={abortEvaluation}>
                    Cancel evaluation
                  </Button>
                ) : (
                  <div className="evaluation-run-actions">
                    {!hasQualityCriteria ? (
                      <Button
                        className="evaluation-run-button secondary"
                        isDisabled={
                          executionCount === 0 ||
                          hasInvalidDatasetDraft ||
                          hasInvalidExecutionSetup ||
                          !referenceStatus?.datasetExists ||
                          !referenceStatus.targetGraphExists ||
                          state.runningSuiteId !== undefined
                        }
                        title={`Runs ${targetExecutionLabel} and measures execution without producing a quality result.`}
                        onClick={() => startEvaluation('execution-benchmark')}
                      >
                        Run execution benchmark · {targetExecutionLabel}
                      </Button>
                    ) : null}
                    <Button
                      appearance="primary"
                      className="evaluation-run-button"
                      isDisabled={
                        !hasQualityCriteria ||
                        hasInvalidQualityChecks ||
                        hasInvalidExpectedValues ||
                        hasInvalidEvaluationConfiguration ||
                        executionCount === 0 ||
                        hasInvalidDatasetDraft ||
                        hasInvalidExecutionSetup ||
                        !referenceStatus?.datasetExists ||
                        !referenceStatus.targetGraphExists ||
                        !referenceStatus.evaluatorGraphsExist ||
                        state.runningSuiteId !== undefined
                      }
                      title={
                        !hasQualityCriteria
                          ? 'Add a required quality check, evaluator graph, or threshold before running an evaluation.'
                          : hasInvalidQualityChecks
                            ? 'Fix the highlighted deterministic quality checks before running this evaluation.'
                            : hasInvalidExpectedValues
                              ? 'Add the required expected values and fix values that do not match their quality checks.'
                              : hasInvalidEvaluationConfiguration
                                ? 'Fix the highlighted evaluator graph and threshold settings before running this evaluation.'
                                : hasInvalidExecutionSetup
                                  ? 'Fix target input bindings and missing case input values before running this evaluation.'
                                  : state.runningSuiteId !== undefined
                                    ? 'Another evaluation is already running for this project.'
                                    : hasInvalidDatasetDraft
                                      ? 'Fix invalid dataset values before running this evaluation.'
                                      : !referenceStatus?.evaluatorGraphsExist
                                        ? 'Repair or remove missing evaluator graphs before running this suite.'
                                        : undefined
                      }
                      onClick={() => startEvaluation('evaluation')}
                    >
                      Run evaluation · {targetExecutionLabel}
                    </Button>
                  </div>
                )}
              </div>
              <p className="evaluation-suite-subtitle">
                {referenceStatus?.targetGraphExists
                  ? project.graphs[selectedSuite.targetGraphId]?.metadata?.name ?? selectedSuite.targetGraphId
                  : 'Missing target graph'}
                {' · '}
                {referenceStatus?.datasetExists ? suiteDataset?.name : 'Missing evaluation dataset'}
                {!referenceStatus?.evaluatorGraphsExist ? ' · Missing evaluator graph' : ''}
              </p>
              <EvaluationSectionTabs
                activeView={view === 'dataset' ? 'definition' : view}
                compareAvailable={compareAvailable}
                onSelect={setView}
              />
            </header>
            <div
              className="evaluation-panel"
              role="tabpanel"
              id={`evaluation-panel-${view}`}
              aria-labelledby={`evaluation-tab-${view}`}
            >
              {view === 'definition' && (
                <Definition
                  suite={selectedSuite}
                  project={project}
                  dataset={suiteDataset}
                  datasets={projectDatasets}
                  graphOptions={graphOptions}
                  targetInputs={targetInputs}
                  targetOutputs={targetOutputs}
                  targetGraphExists={referenceStatus?.targetGraphExists === true}
                  usesPromptDesignerDraft={
                    resolvePromptDesignerEvaluationProject(
                      state.promptDesignerProjectOverride,
                      project.metadata.id,
                      selectedSuite.targetGraphId,
                    ) !== undefined
                  }
                  onUpdate={updateSuite}
                  onAssignDataset={assignSuiteDataset}
                  onAssignTargetGraph={assignTargetGraph}
                />
              )}
              {view === 'runs' && (
                <Runs
                  dataset={suiteDataset}
                  runs={suiteRuns}
                  currentRun={suiteCurrentRun}
                  selectedRunId={state.selectedRunId}
                  status={runsStatus}
                  error={runsError}
                  onSelect={(runId) => setState((current) => ({ ...current, selectedRunId: runId }))}
                  onOpenRecording={(recordingId) => void openRecording(recordingId)}
                />
              )}
              {view === 'compare' && (
                <Compare
                  suite={selectedSuite}
                  runs={suiteRuns}
                  run={comparableRun}
                  baseline={suiteBaseline}
                  onPromote={() => void promoteBaseline()}
                />
              )}
            </div>
          </>
        )}
      </main>
      <CreateEvaluationSuiteModal
        datasets={projectDatasets}
        graphOptions={graphOptions}
        initialGraphId={graph.metadata?.id}
        open={createSuiteOpen}
        onClose={() => setCreateSuiteOpen(false)}
        onCreate={createSuiteFromDialog}
      />
      <EvaluationConfirmModal confirmation={confirmation} onClose={() => setConfirmation(undefined)} />
    </div>
  );
};

const Definition: FC<{
  suite: EvaluationSuite;
  project: Project;
  dataset?: EvaluationDataset;
  datasets: readonly EvaluationDataset[];
  graphOptions: { label: string; value: string }[];
  targetInputs: GraphInputNode[];
  targetOutputs: EvaluationTargetOutput[];
  targetGraphExists: boolean;
  usesPromptDesignerDraft: boolean;
  onUpdate: (update: (suite: EvaluationSuite) => EvaluationSuite) => void;
  onAssignDataset: (datasetId: string) => void;
  onAssignTargetGraph: (graphId: string) => void;
}> = ({
  suite,
  project,
  dataset,
  datasets,
  graphOptions,
  targetInputs,
  targetOutputs,
  targetGraphExists,
  usesPromptDesignerDraft,
  onUpdate,
  onAssignDataset,
  onAssignTargetGraph,
}) => {
  const expectedDatasetFields = dataset?.fields.filter((field) => field.role === 'expected') ?? [];
  const unusedExpectedFields = getUnusedExpectedFields(expectedDatasetFields, suite.assertions);
  const inputBindingIssues = dataset ? getEvaluationInputBindingAuthoringIssues(suite, dataset, targetInputs) : [];
  const expectedValueIssues = dataset ? getEvaluationExpectedValueAuthoringIssues(suite, dataset) : [];
  const executionConfigurationIssues = getEvaluationExecutionConfigurationAuthoringIssues(suite, targetInputs);
  const outputOptions = targetOutputs.map((output) => ({
    label: `${output.id} (${output.dataType})`,
    value: output.outputPath,
  }));
  const addAssertion = (field?: EvaluationDatasetField, requestedOutput?: EvaluationTargetOutput) => {
    const matchingOutput = requestedOutput ?? (field ? undefined : targetOutputs[0]);
    onUpdate((current) => ({
      ...current,
      assertions: [
        ...current.assertions,
        {
          id: nanoid(),
          name: field ? `Check ${field.name}` : `Quality check ${current.assertions.length + 1}`,
          outputPath: matchingOutput?.outputPath ?? '$',
          operator:
            field && matchingOutput
              ? suggestEvaluationAssertionOperator(matchingOutput.dataType, field.dataType)
              : ('equals' as EvaluationAssertionOperator),
          expected: field
            ? { kind: 'dataset-field' as const, fieldId: field.id }
            : { kind: 'literal' as const, value: null },
        },
      ],
    }));
  };
  return (
    <>
      <section className="section">
        <h2>Definition</h2>
        <p className="muted">
          An evaluation runs a complete graph over named dataset cases. Deterministic checks and evaluator graphs judge
          the outputs; its run history and recordings live outside the project file.
        </p>
        {usesPromptDesignerDraft && (
          <p className="warning">
            This suite will run the current unsaved Prompt Designer configuration. That candidate is not written to the
            project.
          </p>
        )}
        <div className="evaluation-form-grid">
          <EvaluationFormField label="Suite name">
            <Textfield
              value={suite.name}
              onChange={(event) => onUpdate((current) => ({ ...current, name: event.currentTarget.value }))}
            />
          </EvaluationFormField>
          <EvaluationFormField label="Target graph">
            <Select
              options={graphOptions}
              value={graphOptions.find((option) => option.value === suite.targetGraphId)}
              placeholder="Select target graph"
              onChange={(value) => value && onAssignTargetGraph(value.value)}
            />
          </EvaluationFormField>
          <EvaluationFormField label="Evaluation dataset">
            <Select
              options={datasets.map((item) => ({ label: item.name, value: item.id }))}
              value={datasets
                .map((item) => ({ label: item.name, value: item.id }))
                .find((option) => option.value === suite.datasetId)}
              placeholder="Select evaluation dataset"
              onChange={(value) => value && onAssignDataset(value.value)}
            />
          </EvaluationFormField>
        </div>
        {!targetGraphExists ? (
          <p className="warning">The target graph no longer exists. Select another graph before running this suite.</p>
        ) : null}
        {!dataset ? (
          <p className="warning">
            The assigned evaluation dataset no longer exists. Select another dataset before editing cases or running
            this suite.
          </p>
        ) : null}
      </section>
      {!dataset || !targetGraphExists ? null : (
        <>
          <section className="section">
            <h3>Input bindings</h3>
            <p className="muted">Bind each target graph input to an input field in the evaluation dataset.</p>
            {targetInputs.length === 0 ? (
              <p className="empty">The target graph has no graph inputs.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Graph input</th>
                    <th>Dataset field</th>
                  </tr>
                </thead>
                <tbody>
                  {targetInputs.map((input) => {
                    const graphInputId = input.data.id;
                    const current = suite.inputBindings.find(
                      (binding) => binding.graphInputId === graphInputId,
                    )?.datasetFieldId;
                    const options = dataset.fields
                      .filter((field) => field.role === 'input')
                      .map((field) => ({ label: field.name, value: field.id }));
                    return (
                      <tr key={input.id}>
                        <td>{graphInputId}</td>
                        <td>
                          <Select
                            options={options}
                            value={options.find((option) => option.value === current)}
                            onChange={(value) =>
                              onUpdate((existing) => ({
                                ...existing,
                                inputBindings: [
                                  ...existing.inputBindings.filter((binding) => binding.graphInputId !== graphInputId),
                                  ...(value ? [{ graphInputId, datasetFieldId: value.value }] : []),
                                ],
                              }))
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {inputBindingIssues.length > 0 ? (
              <div className="evaluation-authoring-issues" role="alert">
                <strong>Target inputs need attention</strong>
                <ul>
                  {inputBindingIssues.map((issue, index) => (
                    <li key={`${index}:${issue}`}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
          <section className="section">
            <h2>Quality checks</h2>
            <p className="muted">
              Quality checks decide whether completed graph outputs meet your requirements. Deterministic check
              reference fields do not judge a run until a check uses them. Evaluator graphs receive the complete
              expected-values object and may judge those fields in custom ways.
            </p>
            {targetOutputs.length === 0 ? (
              <p className="warning">
                The target graph has no Graph Output nodes to inspect with a deterministic check.
              </p>
            ) : null}
            {expectedValueIssues.length > 0 ? (
              <div className="evaluation-authoring-issues" role="alert">
                <strong>Dataset cases need attention</strong>
                <ul>
                  {expectedValueIssues.map((issue, index) => (
                    <li key={`${index}:${issue}`}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {unusedExpectedFields.length > 0 ? (
              <div className="evaluation-unused-fields">
                <strong>Deterministic check reference fields not used by a quality check</strong>
                {unusedExpectedFields.map((field) => {
                  const suggestedOutput =
                    targetOutputs.find((output) => output.id === field.name) ??
                    (targetOutputs.length === 1 ? targetOutputs[0] : undefined);
                  const suggestedOperator = suggestedOutput
                    ? suggestEvaluationAssertionOperator(suggestedOutput.dataType, field.dataType)
                    : undefined;
                  const suggestedOperatorLabel = evaluationAssertionOperatorOptions.find(
                    (option) => option.value === suggestedOperator,
                  )?.label;
                  return (
                    <div className="evaluation-unused-field" key={field.id}>
                      <div className="evaluation-unused-field-copy">
                        <strong>{field.name}</strong>
                        <span>
                          {suggestedOutput
                            ? `Suggested target: ${suggestedOutput.id} · ${suggestedOperatorLabel ?? suggestedOperator}`
                            : 'Create a check, then choose which target output it should inspect.'}
                        </span>
                      </div>
                      <Button
                        isDisabled={suggestedOutput === undefined}
                        title={
                          suggestedOutput
                            ? undefined
                            : 'This field does not unambiguously match a target output. Add a quality check below and choose the output explicitly.'
                        }
                        onClick={() => addAssertion(field, suggestedOutput)}
                      >
                        Create deterministic quality check
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : null}
            <h3>Deterministic checks</h3>
            <p className="muted">
              Compare a target output with a fixed JSON value or a different expected value from each dataset case.
            </p>
            <div className="evaluation-editor-list">
              {suite.assertions.map((assertion) => {
                const expectedFields = expectedDatasetFields.map((field) => ({ label: field.name, value: field.id }));
                const sourceOptions = [
                  { label: 'Literal JSON', value: 'literal' },
                  ...(expectedFields.length > 0
                    ? [{ label: 'Deterministic check reference field', value: 'dataset-field' }]
                    : []),
                ];
                const expected = assertion.expected;
                const selectedOutput = resolveEvaluationTargetOutput(assertion.outputPath, targetOutputs);
                const selectedOperator = evaluationAssertionOperatorOptions.find(
                  (option) => option.value === assertion.operator,
                );
                const authoringIssue = getEvaluationAssertionAuthoringIssue(
                  assertion,
                  targetOutputs,
                  expectedDatasetFields,
                );
                return (
                  <div className="evaluation-editor-card" key={assertion.id}>
                    <EvaluationFormField className="field" label="Check name">
                      <Textfield
                        value={assertion.name}
                        placeholder="Rule name"
                        onChange={(event) =>
                          onUpdate((current) => ({
                            ...current,
                            assertions: current.assertions.map((item) =>
                              item.id === assertion.id ? { ...item, name: event.currentTarget.value } : item,
                            ),
                          }))
                        }
                      />
                    </EvaluationFormField>
                    <EvaluationFormField className="field" label="Target graph output">
                      <Select
                        options={[...outputOptions, { label: 'Advanced path…', value: '__advanced__' }]}
                        value={
                          selectedOutput
                            ? outputOptions.find((option) => option.value === selectedOutput.outputPath)
                            : { label: 'Advanced path…', value: '__advanced__' }
                        }
                        onChange={(value) => {
                          if (!value) return;
                          onUpdate((current) => ({
                            ...current,
                            assertions: current.assertions.map((item) =>
                              item.id === assertion.id
                                ? { ...item, outputPath: value.value === '__advanced__' ? '$' : value.value }
                                : item,
                            ),
                          }));
                        }}
                      />
                    </EvaluationFormField>
                    <EvaluationFormField className="field" label="Comparison">
                      <Select
                        options={evaluationAssertionOperatorOptions}
                        value={selectedOperator}
                        onChange={(value) =>
                          onUpdate((current) => ({
                            ...current,
                            assertions: current.assertions.map((item) =>
                              item.id === assertion.id
                                ? { ...item, operator: value!.value as typeof item.operator }
                                : item,
                            ),
                          }))
                        }
                      />
                    </EvaluationFormField>
                    <EvaluationFormField className="field" label="Expected value source">
                      <Select
                        options={sourceOptions}
                        value={sourceOptions.find((option) => option.value === expected.kind)}
                        onChange={(value) =>
                          onUpdate((current) => ({
                            ...current,
                            assertions: current.assertions.map((item) =>
                              item.id !== assertion.id
                                ? item
                                : {
                                    ...item,
                                    expected:
                                      value!.value === 'dataset-field'
                                        ? { kind: 'dataset-field', fieldId: expectedFields[0]?.value ?? '' }
                                        : { kind: 'literal', value: null },
                                  },
                            ),
                          }))
                        }
                      />
                    </EvaluationFormField>
                    {expected.kind === 'literal' ? (
                      <EvaluationFormField className="field wide" label="Expected JSON">
                        <JsonValueEditor
                          value={expected.value}
                          placeholder="Expected JSON"
                          allowEmpty={false}
                          onCommit={(value) => {
                            if (value !== undefined)
                              onUpdate((current) => ({
                                ...current,
                                assertions: current.assertions.map((item) =>
                                  item.id === assertion.id ? { ...item, expected: { kind: 'literal', value } } : item,
                                ),
                              }));
                          }}
                        />
                      </EvaluationFormField>
                    ) : (
                      <EvaluationFormField className="field wide" label="Deterministic check reference field">
                        <Select
                          options={expectedFields}
                          value={expectedFields.find((option) => option.value === expected.fieldId)}
                          onChange={(value) =>
                            onUpdate((current) => ({
                              ...current,
                              assertions: current.assertions.map((item) =>
                                item.id === assertion.id
                                  ? { ...item, expected: { kind: 'dataset-field', fieldId: value?.value ?? '' } }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </EvaluationFormField>
                    )}
                    <details className="evaluation-advanced-path" open={selectedOutput === undefined}>
                      <summary>Advanced: inspect a nested output value</summary>
                      <EvaluationFormField
                        className="field"
                        label="Output JSON path"
                        description="Use JSONPath, for example $['output'].items[0].name."
                      >
                        <Textfield
                          value={assertion.outputPath}
                          placeholder="$['output']"
                          onChange={(event) =>
                            onUpdate((current) => ({
                              ...current,
                              assertions: current.assertions.map((item) =>
                                item.id === assertion.id ? { ...item, outputPath: event.currentTarget.value } : item,
                              ),
                            }))
                          }
                        />
                      </EvaluationFormField>
                    </details>
                    {authoringIssue ? (
                      <p className="warning field full" role="alert">
                        {authoringIssue.message}
                      </p>
                    ) : null}
                    <div className="evaluation-editor-card-actions">
                      <div className="evaluation-checkboxes">
                        <label>
                          <input
                            type="checkbox"
                            checked={assertion.required !== false}
                            onChange={(event) =>
                              onUpdate((current) => ({
                                ...current,
                                assertions: current.assertions.map((item) =>
                                  item.id === assertion.id ? { ...item, required: event.currentTarget.checked } : item,
                                ),
                              }))
                            }
                          />
                          Required
                        </label>
                      </div>
                      <Button
                        appearance="subtle"
                        onClick={() =>
                          onUpdate((current) => ({
                            ...current,
                            assertions: current.assertions.filter((item) => item.id !== assertion.id),
                          }))
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="evaluation-section-actions">
              <Button appearance="primary" isDisabled={targetOutputs.length === 0} onClick={() => addAssertion()}>
                Add quality check
              </Button>
            </div>
          </section>
          <section className="section">
            <h3>Evaluator graphs</h3>
            <p className="muted">
              Ordinary Rivet graphs return a <code>result</code> object for custom checks and LLM judges. Required
              evaluator errors make the run unable to evaluate; they never become a false quality pass.
            </p>
            <div className="evaluation-editor-list">
              {suite.evaluators.map((evaluator) => {
                const evaluatorIssue = getEvaluationEvaluatorAuthoringIssue(evaluator, project);
                return (
                  <div className="evaluation-editor-card" key={evaluator.id}>
                    <EvaluationFormField className="field wide" label="Evaluator name">
                      <Textfield
                        value={evaluator.name}
                        onChange={(event) =>
                          onUpdate((current) => ({
                            ...current,
                            evaluators: current.evaluators.map((item) =>
                              item.id === evaluator.id ? { ...item, name: event.currentTarget.value } : item,
                            ),
                          }))
                        }
                      />
                    </EvaluationFormField>
                    <EvaluationFormField className="field wide" label="Evaluator graph">
                      <Select
                        options={graphOptions}
                        value={graphOptions.find((item) => item.value === evaluator.graphId)}
                        onChange={(value) =>
                          onUpdate((current) => ({
                            ...current,
                            evaluators: current.evaluators.map((item) =>
                              item.id === evaluator.id
                                ? { ...item, graphId: value!.value as typeof item.graphId }
                                : item,
                            ),
                          }))
                        }
                      />
                    </EvaluationFormField>
                    {evaluatorIssue ? (
                      <p className="warning field full" role="alert">
                        {evaluatorIssue}
                      </p>
                    ) : null}
                    <EvaluationFormField className="field" label="Score weight" description="Optional. Defaults to 1.">
                      <Textfield
                        type="number"
                        value={evaluator.scoreWeight == null ? '' : String(evaluator.scoreWeight)}
                        placeholder="1"
                        onChange={(event) =>
                          onUpdate((current) => ({
                            ...current,
                            evaluators: current.evaluators.map((item) =>
                              item.id === evaluator.id
                                ? {
                                    ...item,
                                    ...(event.currentTarget.value === ''
                                      ? { scoreWeight: undefined }
                                      : { scoreWeight: Number(event.currentTarget.value) }),
                                  }
                                : item,
                            ),
                          }))
                        }
                      />
                    </EvaluationFormField>
                    <div className="evaluation-editor-card-actions">
                      <div className="evaluation-checkboxes">
                        <label>
                          <input
                            type="checkbox"
                            checked={evaluator.required !== false}
                            onChange={(event) =>
                              onUpdate((current) => ({
                                ...current,
                                evaluators: current.evaluators.map((item) =>
                                  item.id === evaluator.id ? { ...item, required: event.currentTarget.checked } : item,
                                ),
                              }))
                            }
                          />
                          Required
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={evaluator.runOnTargetError === true}
                            onChange={(event) =>
                              onUpdate((current) => ({
                                ...current,
                                evaluators: current.evaluators.map((item) =>
                                  item.id === evaluator.id
                                    ? { ...item, runOnTargetError: event.currentTarget.checked }
                                    : item,
                                ),
                              }))
                            }
                          />
                          Run after target error
                        </label>
                      </div>
                      <Button
                        appearance="subtle"
                        onClick={() =>
                          onUpdate((current) => ({
                            ...current,
                            evaluators: current.evaluators.filter((item) => item.id !== evaluator.id),
                          }))
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="evaluation-section-actions">
              <Button
                appearance="primary"
                onClick={() =>
                  onUpdate((current) => ({
                    ...current,
                    evaluators: [
                      ...current.evaluators,
                      {
                        id: nanoid(),
                        name: `Evaluator ${current.evaluators.length + 1}`,
                        graphId: suite.targetGraphId,
                        required: true,
                      },
                    ],
                  }))
                }
              >
                Add evaluator graph
              </Button>
            </div>
            {!hasAuthoritativeEvaluationCriteria(suite) ? (
              <p className="warning">
                This suite has no required quality criteria. Add a required check, evaluator graph, or threshold to run
                an evaluation. You can still run it as an execution benchmark to inspect outputs, latency, and
                accounting without declaring the result passed or failed.
              </p>
            ) : null}
          </section>
          <Thresholds
            suite={suite}
            thresholds={suite.thresholds ?? []}
            onUpdate={(thresholds) => onUpdate((current) => ({ ...current, thresholds }))}
          />
          <section className="section">
            <h3>Execution settings</h3>
            <div className="evaluation-execution-grid">
              <EvaluationFormField label="Trials" description="Runs per enabled dataset case.">
                <Textfield
                  type="number"
                  value={String(suite.configuration?.trialCount ?? 1)}
                  placeholder="1"
                  onChange={(event) =>
                    onUpdate((current) => ({
                      ...current,
                      configuration: {
                        ...current.configuration,
                        trialCount: Math.max(1, Number(event.currentTarget.value) || 1),
                      },
                    }))
                  }
                />
              </EvaluationFormField>
              <EvaluationFormField label="Concurrency" description="Maximum simultaneous graph runs (1–32).">
                <Textfield
                  type="number"
                  value={String(suite.configuration?.concurrency ?? 4)}
                  placeholder="4"
                  onChange={(event) =>
                    onUpdate((current) => ({
                      ...current,
                      configuration: {
                        ...current.configuration,
                        concurrency: Math.min(32, Math.max(1, Number(event.currentTarget.value) || 1)),
                      },
                    }))
                  }
                />
              </EvaluationFormField>
              <EvaluationFormField
                label="Per-graph timeout"
                description="Seconds allowed for each target or evaluator graph."
              >
                <Textfield
                  type="number"
                  value={suite.configuration?.timeoutMs == null ? '' : String(suite.configuration.timeoutMs / 1000)}
                  placeholder="No timeout"
                  onChange={(event) =>
                    onUpdate((current) => ({
                      ...current,
                      configuration: {
                        ...current.configuration,
                        ...(event.currentTarget.value === ''
                          ? { timeoutMs: undefined }
                          : { timeoutMs: Math.max(1, Number(event.currentTarget.value) || 0) * 1000 }),
                      },
                    }))
                  }
                />
              </EvaluationFormField>
              <EvaluationFormField label="Recording retention" description="Which replay artifacts stay available.">
                <Select
                  options={[
                    { label: 'Keep failed and baseline recordings', value: 'failures-and-baselines' },
                    { label: 'Keep every recording', value: 'all' },
                  ]}
                  value={[
                    { label: 'Keep failed and baseline recordings', value: 'failures-and-baselines' },
                    { label: 'Keep every recording', value: 'all' },
                  ].find(
                    (option) => option.value === (suite.configuration?.recordingRetention ?? 'failures-and-baselines'),
                  )}
                  onChange={(value) =>
                    onUpdate((current) => ({
                      ...current,
                      configuration: {
                        ...current.configuration,
                        recordingRetention: value?.value as 'failures-and-baselines' | 'all',
                      },
                    }))
                  }
                />
              </EvaluationFormField>
              <EvaluationFormField label="Suite seed" description="Optional base value used to derive trial seeds.">
                <Textfield
                  type="number"
                  value={suite.configuration?.seed == null ? '' : String(suite.configuration.seed)}
                  placeholder="Optional seed"
                  onChange={(event) =>
                    onUpdate((current) => ({
                      ...current,
                      configuration: {
                        ...current.configuration,
                        ...(event.currentTarget.value === ''
                          ? { seed: undefined, seedGraphInputId: undefined }
                          : { seed: Number(event.currentTarget.value) }),
                      },
                    }))
                  }
                />
              </EvaluationFormField>
              <EvaluationFormField
                label="Seed target input"
                description="Numeric Graph Input that receives each derived seed."
              >
                <Select
                  placeholder="Choose numeric input"
                  isDisabled={suite.configuration?.seed === undefined}
                  options={targetInputs
                    .filter(
                      (input) =>
                        (input.data.dataType === 'number' || input.data.dataType === 'any') &&
                        !suite.inputBindings.some((binding) => binding.graphInputId === input.data.id),
                    )
                    .map((input) => ({ label: input.data.id, value: input.data.id }))}
                  value={targetInputs
                    .filter((input) => input.data.dataType === 'number' || input.data.dataType === 'any')
                    .map((input) => ({ label: input.data.id, value: input.data.id }))
                    .find((option) => option.value === suite.configuration?.seedGraphInputId)}
                  onChange={(value) =>
                    onUpdate((current) => ({
                      ...current,
                      configuration: { ...current.configuration, seedGraphInputId: value?.value },
                    }))
                  }
                />
              </EvaluationFormField>
            </div>
            <p className="muted">
              Each run executes cases × trials. Concurrency is bounded to 32. Graph and LLM retries remain
              authoritative. Successful recordings are temporary for 24 hours unless you choose to keep every recording;
              failed and baseline recordings are retained. A suite seed is sent only to the selected numeric graph
              input, which cannot also be bound to a dataset value.
            </p>
            {executionConfigurationIssues.length > 0 ? (
              <div className="evaluation-authoring-issues" role="alert">
                <strong>Execution settings need attention</strong>
                <ul>
                  {executionConfigurationIssues.map((issue, index) => (
                    <li key={`${index}:${issue}`}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </>
      )}
    </>
  );
};

const Thresholds: FC<{
  suite: EvaluationSuite;
  thresholds: EvaluationThreshold[];
  onUpdate: (thresholds: EvaluationThreshold[]) => void;
}> = ({ suite, thresholds, onUpdate }) => {
  const metrics = [
    'pass-rate',
    'mean-score',
    'target-error-rate',
    'evaluator-error-rate',
    'tool-failure-rate',
    'average-cost',
    'total-cost',
    'average-latency-ms',
    'p95-latency-ms',
  ];
  const metricOptions = [
    ...metrics.map((metric) => ({ label: humanizeEvaluationMetric(metric), value: metric })),
    { label: 'Custom evaluator metric', value: '__custom__' },
  ];
  const updateThreshold = (id: string, update: (threshold: EvaluationThreshold) => EvaluationThreshold) => {
    onUpdate(thresholds.map((threshold) => (threshold.id === id ? update(threshold) : threshold)));
  };
  const hasRequiredPerTrialCheck =
    suite.assertions.some((assertion) => assertion.required !== false) ||
    suite.evaluators.some((evaluator) => evaluator.required !== false);

  return (
    <section className="section">
      <h3>Thresholds</h3>
      <p className="muted">
        Thresholds judge aggregate run metrics and affect the quality result and CLI exit code. If a required metric is
        unavailable or a regression threshold has no compatible baseline, Rivet reports that it is unable to evaluate
        the requirement instead of showing a false pass. Custom evaluator metrics are the numeric keys returned in an
        evaluator result’s <code>metrics</code> object.
      </p>
      <div className="evaluation-editor-list">
        {thresholds.map((threshold) => {
          const customMetric = threshold.metric.startsWith('custom:');
          const thresholdIssue = getEvaluationThresholdAuthoringIssue(threshold, suite);
          return (
            <div className="evaluation-editor-card" key={threshold.id}>
              <EvaluationFormField className="field" label="Metric">
                <Select
                  options={metricOptions}
                  value={
                    customMetric
                      ? metricOptions[metricOptions.length - 1]
                      : metricOptions.find((option) => option.value === threshold.metric)
                  }
                  onChange={(value) =>
                    updateThreshold(threshold.id, (current) => {
                      const metric = value?.value === '__custom__' ? 'custom:' : value?.value ?? current.metric;
                      return {
                        ...current,
                        metric,
                        operator:
                          metric === 'pass-rate' || metric === 'mean-score' || metric.startsWith('custom:')
                            ? 'at-least'
                            : 'at-most',
                      } as EvaluationThreshold;
                    })
                  }
                />
              </EvaluationFormField>
              {customMetric && (
                <EvaluationFormField className="field" label="Evaluator metric name">
                  <Textfield
                    value={threshold.metric.slice('custom:'.length)}
                    onChange={(event) =>
                      updateThreshold(
                        threshold.id,
                        (current) =>
                          ({ ...current, metric: `custom:${event.currentTarget.value}` }) as EvaluationThreshold,
                      )
                    }
                  />
                </EvaluationFormField>
              )}
              <EvaluationFormField className="field" label="Comparison">
                <Select
                  options={[
                    { label: 'At least', value: 'at-least' },
                    { label: 'At most', value: 'at-most' },
                    { label: 'Maximum regression', value: 'max-regression' },
                  ]}
                  value={[
                    { label: 'At least', value: 'at-least' },
                    { label: 'At most', value: 'at-most' },
                    { label: 'Maximum regression', value: 'max-regression' },
                  ].find((option) => option.value === threshold.operator)}
                  onChange={(value) =>
                    updateThreshold(
                      threshold.id,
                      (current) =>
                        ({
                          ...current,
                          operator: value!.value as EvaluationThreshold['operator'],
                        }) as EvaluationThreshold,
                    )
                  }
                />
              </EvaluationFormField>
              <EvaluationFormField
                className="field"
                label="Threshold value"
                description={
                  threshold.operator === 'max-regression'
                    ? 'Use a fraction: 0.1 allows a 10% regression.'
                    : [
                          'pass-rate',
                          'mean-score',
                          'target-error-rate',
                          'evaluator-error-rate',
                          'tool-failure-rate',
                        ].includes(threshold.metric)
                      ? 'Use a fraction: 0.95 means 95%.'
                      : threshold.metric === 'average-cost' || threshold.metric === 'total-cost'
                        ? 'US dollars.'
                        : threshold.metric === 'average-latency-ms' || threshold.metric === 'p95-latency-ms'
                          ? 'Milliseconds.'
                          : undefined
                }
              >
                <Textfield
                  type="number"
                  value={String(threshold.value)}
                  onChange={(event) =>
                    updateThreshold(
                      threshold.id,
                      (current) =>
                        ({ ...current, value: Number(event.currentTarget.value) || 0 }) as EvaluationThreshold,
                    )
                  }
                />
              </EvaluationFormField>
              {thresholdIssue ? (
                <p className="warning field full" role="alert">
                  {thresholdIssue}
                </p>
              ) : null}
              <div className="evaluation-editor-card-actions">
                <span />
                <Button
                  appearance="subtle"
                  onClick={() => onUpdate(thresholds.filter((item) => item.id !== threshold.id))}
                >
                  Remove
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="evaluation-section-actions">
        <Button
          appearance="primary"
          onClick={() =>
            onUpdate([
              ...thresholds,
              hasRequiredPerTrialCheck
                ? { id: nanoid(), metric: 'pass-rate', operator: 'at-least', value: 1 }
                : { id: nanoid(), metric: 'target-error-rate', operator: 'at-most', value: 0 },
            ])
          }
        >
          Add threshold
        </Button>
      </div>
    </section>
  );
};

const Dataset: FC<{
  dataset?: EvaluationDataset;
  suites: readonly EvaluationSuite[];
  onAddCase: () => void;
  onInvalidDraftChange: (invalid: boolean) => void;
  onOpenSuite: (suiteId: string) => void;
  onUpdate: (dataset: EvaluationDataset) => void;
}> = ({ dataset, suites, onAddCase, onInvalidDraftChange, onOpenSuite, onUpdate }) => {
  const io = useIOProvider();
  const [invalidCellIds, setInvalidCellIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setInvalidCellIds(new Set());
  }, [dataset?.id]);

  useEffect(() => {
    if (!dataset) return;
    const existingCellIds = new Set(
      dataset.cases.flatMap((testCase) => dataset.fields.map((field) => `${testCase.id}:${field.id}`)),
    );
    setInvalidCellIds((current) => {
      const next = new Set([...current].filter((cellId) => existingCellIds.has(cellId)));
      return next.size === current.size ? current : next;
    });
  }, [dataset]);

  useEffect(() => {
    onInvalidDraftChange(invalidCellIds.size > 0);
  }, [invalidCellIds, onInvalidDraftChange]);

  useEffect(
    () => () => {
      onInvalidDraftChange(false);
    },
    [onInvalidDraftChange],
  );

  if (!dataset) return <div className="empty">Select or create an evaluation dataset first.</div>;

  const setCellInvalid = (cellId: string, invalid: boolean) => {
    setInvalidCellIds((current) => {
      if (current.has(cellId) === invalid) return current;
      const next = new Set(current);
      if (invalid) next.add(cellId);
      else next.delete(cellId);
      return next;
    });
  };
  const updateField = (fieldId: string, update: Partial<EvaluationDatasetField>) =>
    onUpdate({
      ...dataset,
      fields: dataset.fields.map((field) => (field.id === fieldId ? { ...field, ...update } : field)),
    });
  const removeField = (fieldId: string) =>
    onUpdate({
      ...dataset,
      fields: dataset.fields.filter((field) => field.id !== fieldId),
      cases: dataset.cases.map((testCase) => {
        const values = { ...testCase.values };
        delete values[fieldId];
        return { ...testCase, values };
      }),
    });
  const addField = () =>
    onUpdate({
      ...dataset,
      fields: [
        ...dataset.fields,
        {
          id: nanoid(),
          name: `Field ${dataset.fields.length + 1}`,
          dataType: 'string',
          role: 'input',
          required: false,
        },
      ],
    });
  const exportJson = () => {
    void io
      .saveString(serializeEvaluationDatasetJson(dataset), `${dataset.name || 'evaluation-dataset'}.evaluation.json`)
      .catch((error) =>
        toast.error(
          `Could not export the evaluation dataset: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  };
  const exportCsv = () => {
    const columns = [
      '__case_id',
      '__case_name',
      '__enabled',
      '__tags',
      '__note',
      ...dataset.fields.map((field) => `field:${field.id}`),
    ];
    const rows = dataset.cases.map((testCase) => [
      testCase.id,
      testCase.name,
      testCase.enabled === false ? 'false' : 'true',
      JSON.stringify(testCase.tags ?? []),
      testCase.note ?? '',
      ...dataset.fields.map((field) =>
        testCase.values[field.id] === undefined ? '' : JSON.stringify(testCase.values[field.id]),
      ),
    ]);
    void io
      .saveString(stringifyCsv([columns, ...rows]), `${dataset.name || 'evaluation-dataset'}.csv`)
      .catch((error) =>
        toast.error(`Could not export the evaluation cases: ${error instanceof Error ? error.message : String(error)}`),
      );
  };
  const importCsv = (source: string) => {
    const rows = parseCsv(source, { skip_empty_lines: true }) as string[][];
    const [headers, ...caseRows] = rows;
    if (!headers) throw new Error('Evaluation CSV must contain a header row.');
    const fixed = ['__case_id', '__case_name', '__enabled', '__tags', '__note'];
    if (!fixed.every((column, index) => headers[index] === column)) {
      throw new Error(`Evaluation CSV must begin with ${fixed.join(', ')}.`);
    }
    const fieldColumns = headers.slice(fixed.length);
    const expectedColumns = dataset.fields.map((field) => `field:${field.id}`);
    if (
      fieldColumns.length !== expectedColumns.length ||
      fieldColumns.some((column, index) => column !== expectedColumns[index])
    ) {
      throw new Error(
        'Evaluation CSV fields must exactly match the current dataset. Export this dataset first to get the correct columns.',
      );
    }
    const ids = new Set<string>();
    const cases = caseRows.map((row, rowIndex) => {
      const id = row[0]?.trim();
      const name = row[1]?.trim();
      if (!id || !name) throw new Error(`CSV row ${rowIndex + 2} needs both a case id and case name.`);
      if (ids.has(id)) throw new Error(`CSV row ${rowIndex + 2} repeats case id "${id}".`);
      ids.add(id);
      const enabled = row[2] !== 'false';
      let tags: string[];
      try {
        const parsedTags = JSON.parse(row[3] ?? '[]') as unknown;
        if (!Array.isArray(parsedTags) || parsedTags.some((tag) => typeof tag !== 'string')) throw new Error();
        tags = parsedTags;
      } catch {
        throw new Error(`CSV row ${rowIndex + 2} has invalid JSON tags.`);
      }
      const values: Record<string, PortableJson> = {};
      dataset.fields.forEach((field, fieldIndex) => {
        const sourceValue = row[fixed.length + fieldIndex] ?? '';
        if (sourceValue === '') return;
        const value = safeJson(sourceValue);
        if (value === undefined) throw new Error(`CSV row ${rowIndex + 2} has invalid JSON for "${field.name}".`);
        values[field.id] = value;
      });
      return { id, name, enabled, tags, ...(row[4] ? { note: row[4] } : {}), values };
    });
    onUpdate({ ...dataset, cases });
  };
  const importDataset = () => {
    void io
      .readFileAsString((source, fileName) => {
        try {
          if (/\.csv$/iu.test(fileName)) importCsv(source);
          else onUpdate(deserializeEvaluationDatasetJson(source, { id: dataset.id, projectId: dataset.projectId }));
          toast.success(`Imported evaluation dataset from ${fileName}.`);
        } catch (error) {
          toast.error(
            `Could not import the evaluation dataset: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })
      .catch((error) =>
        toast.error(
          `Could not open an evaluation dataset file: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  };
  return (
    <>
      <section className="section">
        <p className="muted">
          Evaluation datasets are reusable .rivet-data resources. Graph input fields feed a suite’s target graph.
          Deterministic check reference fields provide values for visible quality checks; they do not judge a run on
          their own. Metadata travels only to evaluator graphs. JSON is lossless; CSV imports and exports typed JSON
          cell values against the current field definitions.
        </p>
        <div className="evaluation-dataset-metadata">
          <EvaluationFormField label="Dataset name">
            <Textfield
              value={dataset.name}
              onChange={(event) => onUpdate({ ...dataset, name: event.currentTarget.value })}
            />
          </EvaluationFormField>
          <EvaluationFormField label="Description" description="Optional context for other evaluation authors.">
            <Textfield
              value={dataset.description ?? ''}
              onChange={(event) => onUpdate({ ...dataset, description: event.currentTarget.value || undefined })}
            />
          </EvaluationFormField>
        </div>
        <div className="evaluation-dataset-usage">
          <strong>Used by evaluation suites</strong>
          {suites.length === 0 ? (
            <span>This dataset is not assigned to a suite yet.</span>
          ) : (
            <div>
              {suites.map((suite) => (
                <Button appearance="subtle" key={suite.id} onClick={() => onOpenSuite(suite.id)}>
                  {suite.name || 'Untitled evaluation suite'}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="evaluation-section-actions">
          <Button appearance="subtle" onClick={exportJson}>
            Export JSON
          </Button>
          <Button appearance="subtle" onClick={exportCsv}>
            Export CSV
          </Button>
          <Button appearance="subtle" onClick={importDataset}>
            Import (replace)
          </Button>
        </div>
      </section>
      <section className="section">
        <h3>Fields</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Rivet type</th>
              <th>Required</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {dataset.fields.map((field) => (
              <tr key={field.id}>
                <td>
                  <Textfield
                    value={field.name}
                    onChange={(event) => updateField(field.id, { name: event.currentTarget.value })}
                  />
                </td>
                <td>
                  <Select
                    options={[
                      { label: 'Graph input', value: 'input' },
                      { label: 'Deterministic check reference', value: 'expected' },
                      { label: 'Evaluator metadata', value: 'metadata' },
                    ]}
                    value={[
                      { label: 'Graph input', value: 'input' },
                      { label: 'Deterministic check reference', value: 'expected' },
                      { label: 'Evaluator metadata', value: 'metadata' },
                    ].find((option) => option.value === field.role)}
                    onChange={(value) =>
                      updateField(field.id, { role: value!.value as EvaluationDatasetField['role'] })
                    }
                  />
                </td>
                <td>
                  <Select
                    options={['string', 'number', 'boolean', 'object', 'string[]', 'object[]', 'any'].map(
                      (dataType) => ({ label: dataType, value: dataType }),
                    )}
                    value={{ label: field.dataType, value: field.dataType }}
                    onChange={(value) => updateField(field.id, { dataType: value!.value })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`${field.name} required`}
                    type="checkbox"
                    checked={field.required === true}
                    onChange={(event) => updateField(field.id, { required: event.currentTarget.checked })}
                  />
                </td>
                <td>
                  <Button appearance="subtle" onClick={() => removeField(field.id)}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="evaluation-section-actions">
          <Button appearance="primary" onClick={addField}>
            Add field
          </Button>
        </div>
      </section>
      <section className="section">
        <h3>Cases</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Enabled</th>
              <th>Case</th>
              <th>Tags</th>
              <th>Notes</th>
              {dataset.fields.map((field) => (
                <th key={field.id}>
                  {field.name}
                  <span className="evaluation-field-type">{field.dataType}</span>
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {dataset.cases.map((testCase) => (
              <tr key={testCase.id}>
                <td>
                  <input
                    aria-label={`${testCase.name} enabled`}
                    type="checkbox"
                    checked={testCase.enabled !== false}
                    onChange={(event) =>
                      onUpdate({
                        ...dataset,
                        cases: dataset.cases.map((candidate) =>
                          candidate.id === testCase.id
                            ? { ...candidate, enabled: event.currentTarget.checked }
                            : candidate,
                        ),
                      })
                    }
                  />
                </td>
                <td>
                  <Textfield
                    value={testCase.name}
                    onChange={(event) =>
                      onUpdate({
                        ...dataset,
                        cases: dataset.cases.map((candidate) =>
                          candidate.id === testCase.id ? { ...candidate, name: event.currentTarget.value } : candidate,
                        ),
                      })
                    }
                  />
                </td>
                <td>
                  <Textfield
                    value={(testCase.tags ?? []).join(', ')}
                    placeholder="tag, regression"
                    onChange={(event) =>
                      onUpdate({
                        ...dataset,
                        cases: dataset.cases.map((candidate) =>
                          candidate.id === testCase.id
                            ? {
                                ...candidate,
                                tags: event.currentTarget.value
                                  .split(',')
                                  .map((tag) => tag.trim())
                                  .filter(Boolean),
                              }
                            : candidate,
                        ),
                      })
                    }
                  />
                </td>
                <td>
                  <Textfield
                    value={testCase.note ?? ''}
                    placeholder="Optional note"
                    onChange={(event) =>
                      onUpdate({
                        ...dataset,
                        cases: dataset.cases.map((candidate) =>
                          candidate.id === testCase.id
                            ? { ...candidate, note: event.currentTarget.value || undefined }
                            : candidate,
                        ),
                      })
                    }
                  />
                </td>
                {dataset.fields.map((field) => (
                  <td key={field.id}>
                    <DatasetValueEditor
                      dataType={field.dataType}
                      value={testCase.values[field.id]}
                      onCommit={(value) => onUpdate(updateDatasetCaseValue(dataset, testCase.id, field.id, value))}
                      onValidityChange={(invalid) => setCellInvalid(`${testCase.id}:${field.id}`, invalid)}
                    />
                  </td>
                ))}
                <td>
                  <Button
                    appearance="subtle"
                    onClick={() =>
                      onUpdate({ ...dataset, cases: dataset.cases.filter((candidate) => candidate.id !== testCase.id) })
                    }
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {dataset.cases.length === 0 && (
          <p className="empty">No cases yet. Add a case and give every bound input a portable JSON value.</p>
        )}
        <div className="evaluation-section-actions">
          <Button appearance="primary" onClick={onAddCase}>
            Add case
          </Button>
        </div>
      </section>
    </>
  );
};

const Runs: FC<{
  dataset?: EvaluationDataset;
  runs: EvaluationRun[];
  currentRun?: EvaluationRun;
  selectedRunId?: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  onSelect: (runId: string) => void;
  onOpenRecording: (recordingId: string) => void;
}> = ({ dataset, runs, currentRun, selectedRunId, status, error, onSelect, onOpenRecording }) => {
  const liveRun =
    currentRun?.executionStatus === 'queued' || currentRun?.executionStatus === 'running' ? currentRun : undefined;
  const rawRun = liveRun ?? runs.find((candidate) => candidate.id === selectedRunId) ?? currentRun ?? runs[0];
  const run = rawRun ? normalizeEvaluationRun(rawRun) : undefined;
  const [expandedTrialIds, setExpandedTrialIds] = useState<Set<string>>(new Set());
  const firstTrialId = run?.trials[0]?.id;

  useEffect(() => {
    setExpandedTrialIds(firstTrialId ? new Set([firstTrialId]) : new Set());
  }, [firstTrialId, run?.id]);

  if (status === 'loading') return <div className="empty">Loading evaluation runs…</div>;
  if (status === 'error') return <div className="empty danger">Could not load evaluation runs: {error}</div>;
  if (!run) return <div className="empty">Run a suite to inspect trials, metrics, and retained recordings here.</div>;

  const quality = getEvaluationRunQualityPresentation(run);
  const visibleWarnings = run.warnings;
  const aggregate = run.aggregate;
  const executionLabel = `${run.executionStatus.charAt(0).toUpperCase()}${run.executionStatus.slice(1)}`;
  const accountingLabel = run.accountingStatus === 'complete' ? 'Complete' : 'Partial';
  const runOptionLabel = (candidate: EvaluationRun) => {
    const normalized = normalizeEvaluationRun(candidate);
    const result =
      normalized.purpose === 'execution-benchmark'
        ? `Execution benchmark · ${normalized.executionStatus}`
        : `Evaluation · ${getEvaluationRunQualityPresentation(normalized).label}`;
    return `${normalized.suiteName} · ${new Date(normalized.startedAt).toLocaleString()} · ${result}`;
  };
  const formatValue = (value: unknown) => JSON.stringify(value, null, 2) ?? String(value);
  const expectedFieldNameCounts = new Map<string, number>();
  for (const field of dataset?.fields ?? []) {
    expectedFieldNameCounts.set(field.name, (expectedFieldNameCounts.get(field.name) ?? 0) + 1);
  }
  const expectedFieldLabels = new Map(
    (dataset?.fields ?? []).map((field) => [
      field.id,
      expectedFieldNameCounts.get(field.name) === 1 ? field.name : `${field.name} (${field.id})`,
    ]),
  );

  return (
    <section className="section">
      <h2>Runs</h2>
      {runs.length > 1 && (
        <div className="row">
          <Select
            className="field"
            options={runs.map((candidate) => ({
              label: runOptionLabel(candidate),
              value: candidate.id,
            }))}
            value={{
              label: runOptionLabel(run),
              value: run.id,
            }}
            onChange={(value) => onSelect(value!.value)}
          />
        </div>
      )}
      <div className="evaluation-run-summary-grid">
        <div className="evaluation-run-summary-item">
          <span className="evaluation-run-summary-label">Quality</span>
          <span className={`evaluation-run-summary-value status-${run.qualityStatus}`}>{quality.label}</span>
        </div>
        <div className="evaluation-run-summary-item">
          <span className="evaluation-run-summary-label">Execution</span>
          <span className="evaluation-run-summary-value">{executionLabel}</span>
        </div>
        <div className="evaluation-run-summary-item">
          <span className="evaluation-run-summary-label">Accounting</span>
          <span className="evaluation-run-summary-value">{accountingLabel}</span>
        </div>
        <div className="evaluation-run-summary-item">
          <span className="evaluation-run-summary-label">Quality trials</span>
          <span className="evaluation-run-summary-value">
            {aggregate
              ? aggregate.evaluatedTrialCount > 0
                ? `${aggregate.passedTrialCount} of ${aggregate.evaluatedTrialCount} passed`
                : aggregate.unableToEvaluateTrialCount > 0
                  ? `${aggregate.unableToEvaluateTrialCount} unable to evaluate`
                  : 'Not evaluated'
              : `${run.trials.length} recorded`}
          </span>
        </div>
        <div className="evaluation-run-summary-item">
          <span className="evaluation-run-summary-label">P95 latency</span>
          <span className="evaluation-run-summary-value">
            {aggregate ? `${Math.round(aggregate.p95LatencyMs)} ms` : 'Calculating'}
          </span>
        </div>
        <div className="evaluation-run-summary-item">
          <span className="evaluation-run-summary-label">Pass rate</span>
          <span className="evaluation-run-summary-value">
            {aggregate
              ? aggregate.evaluatedTrialCount > 0
                ? `${Math.round(aggregate.passRate * 100)}%`
                : 'Not evaluated'
              : 'Calculating'}
          </span>
        </div>
        <div className="evaluation-run-summary-item">
          <span className="evaluation-run-summary-label">Total cost</span>
          <span className="evaluation-run-summary-value">
            {run.accountingStatus === 'partial' || aggregate?.totalCostUsd === undefined
              ? 'Unavailable'
              : `$${aggregate.totalCostUsd.toFixed(4)}`}
          </span>
        </div>
      </div>

      <p className="evaluation-run-explanation">{quality.explanation}</p>
      {run.thresholdResults.length > 0 && aggregate?.evaluatedTrialCount === 0 ? (
        <p className="evaluation-run-no-checks">
          Individual trials were not judged. This suite judges the aggregate run metrics, so the overall quality result
          comes from the requirements below.
        </p>
      ) : null}
      {run.accountingStatus === 'partial' ? (
        <p className="evaluation-run-no-checks">
          Some provider pricing was unavailable. Execution and quality results remain valid unless a configured cost
          threshold requires the missing amount.
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

      <div className="evaluation-trial-list">
        {run.trials.map((trial) => {
          const recordings: Array<{ label: string; reference: EvaluationRecordingReference }> = [];
          if (trial.recording) recordings.push({ label: 'Target', reference: trial.recording });
          for (const observation of trial.observations) {
            if (observation.recording) recordings.push({ label: observation.name, reference: observation.recording });
          }
          const isOpen = expandedTrialIds.has(trial.id);
          const expectedValues = Object.fromEntries(
            Object.entries(trial.expected).map(([fieldId, value]) => [
              expectedFieldLabels.get(fieldId) ?? fieldId,
              value,
            ]),
          );
          const trialQualityLabel =
            trial.qualityStatus === 'passed'
              ? 'Quality passed'
              : trial.qualityStatus === 'failed'
                ? 'Quality failed'
                : trial.qualityStatus === 'not-evaluated'
                  ? 'Quality not evaluated'
                  : 'Unable to evaluate quality';
          const trialStatusClass =
            trial.executionStatus !== 'completed'
              ? 'fail'
              : trial.qualityStatus === 'passed'
                ? 'pass'
                : trial.qualityStatus;
          const toggleTrial = () =>
            setExpandedTrialIds((current) => {
              const next = new Set(current);
              if (next.has(trial.id)) next.delete(trial.id);
              else next.add(trial.id);
              return next;
            });
          return (
            <CollapsiblePanel
              key={trial.id}
              className="evaluation-trial"
              open={isOpen}
              onToggle={toggleTrial}
              ariaControls={`evaluation-trial-${trial.id}`}
              label={
                <span className="evaluation-trial-toggle-summary">
                  <span className="trial-case">
                    {trial.caseName} · Trial {trial.trialIndex + 1}
                  </span>
                  <span className={`status-${trial.executionStatus === 'completed' ? 'pass' : 'fail'}`}>
                    Execution {trial.executionStatus}
                  </span>
                  <span className={`status-${trialStatusClass}`} title={trial.qualityReason.message}>
                    {trialQualityLabel}
                  </span>
                  <span className="trial-duration">{Math.round(trial.totalMetrics.durationMs)} ms</span>
                </span>
              }
            >
              <div className="evaluation-trial-content" id={`evaluation-trial-${trial.id}`}>
                <div className="evaluation-trial-results">
                  <div className="evaluation-result-block">
                    <h4>Inputs</h4>
                    <pre>{formatValue(trial.inputs)}</pre>
                  </div>
                  <div className="evaluation-result-block">
                    <h4>Target outputs</h4>
                    <pre>{formatValue(trial.outputs)}</pre>
                  </div>
                  <div className="evaluation-result-block">
                    <h4>Expected values</h4>
                    <pre>{formatValue(expectedValues)}</pre>
                  </div>
                  <div className="evaluation-result-block">
                    <h4>Metrics</h4>
                    <pre>{formatValue(trial.totalMetrics)}</pre>
                  </div>
                </div>

                <div className="evaluation-checks">
                  <h4>Checks</h4>
                  {trial.observations.length === 0 ? (
                    <p className="muted">
                      {run.purpose === 'execution-benchmark'
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
                            ? evaluationAssertionOperatorOptions.find(
                                (option) => option.value === evidenceRecord.operator,
                              )?.label
                            : undefined;
                        const assertionOutputPath =
                          observation.kind === 'assertion' && typeof evidenceRecord?.outputPath === 'string'
                            ? evidenceRecord.outputPath
                            : undefined;
                        const rawExpectedSource = evidenceRecord?.expectedSource;
                        const structuredExpectedSource =
                          rawExpectedSource !== null &&
                          typeof rawExpectedSource === 'object' &&
                          !Array.isArray(rawExpectedSource)
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
                                className={`status-${observation.status === 'passed' ? 'pass' : observation.status === 'failed' || observation.status === 'error' ? 'fail' : 'not-evaluated'}`}
                              >
                                {observation.status.charAt(0).toUpperCase() + observation.status.slice(1)}
                              </span>
                            </div>
                            <span className="muted">
                              {observation.kind === 'graph' ? 'Evaluator graph' : 'Deterministic check'} ·{' '}
                              {observation.required ? 'required' : 'informational'}
                              {observation.score === undefined ? '' : ` · score ${observation.score}`}
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
                                    {actualFound === false
                                      ? 'Output path was not found.'
                                      : formatValue(evidenceRecord.actual)}
                                  </pre>
                                </div>
                                <div>
                                  <h6>Expected value</h6>
                                  <pre>{formatValue(evidenceRecord.expected)}</pre>
                                </div>
                              </div>
                            ) : (
                              <>
                                <p className="muted">Evidence</p>
                                <pre>{formatValue(observation.evidence)}</pre>
                              </>
                            )}
                            {observation.metrics === undefined ? null : (
                              <>
                                <p className="muted">Custom metrics</p>
                                <pre>{formatValue(observation.metrics)}</pre>
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
                    <pre>{formatValue(trial.targetProviderAttempts)}</pre>
                  </div>
                )}
                <div className="evaluation-trial-footer">
                  {recordings.length === 0 ? (
                    <span className="muted">No replay recording is retained for this trial.</span>
                  ) : (
                    recordings.map((recording) => (
                      <span key={recording.reference.id}>
                        <span className="pill">{recording.reference.retention}</span>{' '}
                        <Button appearance="subtle" onClick={() => onOpenRecording(recording.reference.id)}>
                          Open {recording.label}
                        </Button>
                      </span>
                    ))
                  )}
                </div>
              </div>
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
    </section>
  );
};

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

const Compare: FC<{
  suite?: EvaluationSuite;
  runs: EvaluationRun[];
  run?: EvaluationRun;
  baseline?: EvaluationBaselineSnapshot;
  onPromote: () => void;
}> = ({ suite, runs, run, baseline, onPromote }) => {
  const [referenceId, setReferenceId] = useState('baseline');
  const normalizedRun = run ? normalizeEvaluationRun(run) : undefined;
  const normalizedBaseline = baseline ? normalizeEvaluationBaselineSnapshot(baseline) : undefined;
  const comparisonRuns = runs
    .map(normalizeEvaluationRun)
    .filter(
      (candidate): candidate is EvaluationRun & { aggregate: NonNullable<EvaluationRun['aggregate']> } =>
        candidate.id !== normalizedRun?.id &&
        candidate.executionStatus === 'completed' &&
        candidate.aggregate !== undefined,
    );
  const effectiveReferenceId =
    (referenceId === 'baseline' && normalizedBaseline) ||
    comparisonRuns.some((candidate) => candidate.id === referenceId)
      ? referenceId
      : normalizedBaseline
        ? 'baseline'
        : comparisonRuns[0]?.id ?? 'baseline';
  const referenceRun = comparisonRuns.find((candidate) => candidate.id === effectiveReferenceId);
  const reference = effectiveReferenceId === 'baseline' ? normalizedBaseline : referenceRun;
  const referenceAggregate = reference?.aggregate;
  const compatible = normalizedRun && reference && compatibleProvenance(normalizedRun.provenance, reference.provenance);
  const hasReplayArtifact =
    normalizedRun?.trials.some(
      (trial) => trial.recording != null || trial.observations.some((observation) => observation.recording != null),
    ) ?? false;
  const referenceLabel = effectiveReferenceId === 'baseline' ? 'Baseline' : 'Selected run';
  const runLabel = (candidate: EvaluationRun) =>
    candidate.purpose === 'execution-benchmark'
      ? 'Execution benchmark · no quality result'
      : getEvaluationRunQualityPresentation(candidate).label;
  const baselinePurpose = normalizedBaseline?.purpose ?? 'evaluation';
  const baselineQualityLabel =
    baselinePurpose === 'execution-benchmark'
      ? 'Not evaluated'
      : normalizedBaseline?.qualityStatus === 'passed'
        ? 'Passed'
        : normalizedBaseline?.qualityStatus === 'failed'
          ? 'Failed'
          : normalizedBaseline?.qualityStatus === 'unable-to-evaluate'
            ? 'Unable to evaluate'
            : normalizedBaseline?.qualityStatus === 'not-evaluated'
              ? 'Not evaluated'
              : 'Legacy result';
  const baselineAccountingLabel = normalizedBaseline?.accountingStatus === 'partial' ? 'Partial' : 'Complete';
  const currentAggregate = normalizedRun?.aggregate;
  const currentCost = normalizedRun?.accountingStatus === 'partial' ? undefined : currentAggregate?.totalCostUsd;
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
      {normalizedRun ? (
        <div className="row">
          <Select
            className="field"
            options={[
              ...(normalizedBaseline ? [{ label: 'Suite baseline', value: 'baseline' }] : []),
              ...comparisonRuns.map((candidate) => ({
                label: `${candidate.suiteName} · ${new Date(candidate.startedAt).toLocaleString()} · ${runLabel(candidate)}`,
                value: candidate.id,
              })),
            ]}
            value={
              effectiveReferenceId === 'baseline'
                ? normalizedBaseline
                  ? { label: 'Suite baseline', value: 'baseline' }
                  : undefined
                : comparisonRuns
                    .map((candidate) => ({
                      label: `${candidate.suiteName} · ${new Date(candidate.startedAt).toLocaleString()} · ${runLabel(candidate)}`,
                      value: candidate.id,
                    }))
                    .find((option) => option.value === effectiveReferenceId)
            }
            placeholder="Choose a run or baseline"
            onChange={(value) => setReferenceId(value?.value ?? 'baseline')}
          />
        </div>
      ) : null}
      {normalizedBaseline ? (
        <p>
          {`Baseline recorded ${new Date(normalizedBaseline.createdAt).toLocaleString()} · ${
            baselinePurpose === 'execution-benchmark' ? 'Execution benchmark' : 'Evaluation'
          } · Quality: ${baselineQualityLabel} · Accounting: ${baselineAccountingLabel}`}
          {(normalizedBaseline.aggregate.evaluatedTrialCount ?? 0) > 0
            ? ` · Pass rate ${Math.round(normalizedBaseline.aggregate.passRate * 100)}%`
            : ''}
        </p>
      ) : (
        <p>
          {suite
            ? 'No baseline has been promoted yet. You can still compare two stored runs.'
            : 'Choose an evaluation suite first.'}
        </p>
      )}
      {normalizedRun && reference && referenceAggregate && (
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
      {normalizedRun && normalizedRun.executionStatus === 'completed' && (
        <>
          <Button isDisabled={!hasReplayArtifact} onClick={onPromote}>
            Use this run as baseline
          </Button>
          {!hasReplayArtifact && <p className="muted">A baseline needs at least one retained replay artifact.</p>}
        </>
      )}
    </section>
  );
};

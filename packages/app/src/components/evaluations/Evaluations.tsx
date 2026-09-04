import { css } from '@emotion/react';
import Button from '@atlaskit/button';
import Checkbox from '@atlaskit/checkbox';
import Textfield from '@atlaskit/textfield';
import TextArea from '@atlaskit/textarea';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import DeleteIcon from 'majesticons/line/delete-bin-line.svg?react';
import EditIcon from 'majesticons/line/edit-pen-2-line.svg?react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import { nanoid } from 'nanoid/non-secure';
import { type FC, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  createEvaluationBaselineSnapshot,
  canonicalStringify,
  deserializeEvaluationDatasetJson,
  deserializeEvaluationSuiteBundleJson,
  areEvaluationDataTypesCompatible,
  isEvaluationValueCompatibleWithDataType,
  reconcileEvaluationRunSnapshots,
  hasAuthoritativeEvaluationCriteria,
  getEvaluationSuiteMode,
  LEGACY_EVALUATOR_INPUT_IDS,
  summarizeEvaluationRun,
  serializeEvaluationDatasetJson,
  serializeEvaluationSuiteBundleJson,
  usesLegacyEvaluatorInputEnvelope,
  type EvaluationBaselineSnapshot,
  type EvaluationDataset,
  type EvaluationDatasetField,
  type EvaluationEvaluatorInputSource,
  type EvaluationAssertionOperator,
  type EvaluationRun,
  type EvaluationRunPurpose,
  type EvaluationRecordingReference,
  type EvaluationSuite,
  type EvaluationThreshold,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';
import type { GraphInputNode, Project } from '@valerypopoff/rivet2-core';
import { graphState } from '../../state/graph.js';
import { projectsState, projectState } from '../../state/savedGraphs.js';
import {
  discardEvaluationSuiteWorkspaceState,
  evaluationsState,
  getEvaluationSuitePresentation,
  getEvaluationRunHistoryScopeKey,
  isEvaluationRunHistoryCached,
  selectEvaluationDatasetResource,
  selectEvaluationSuiteResource,
  updateEvaluationSuitePresentation,
  type EvaluationRunHistoryScope,
  type EvaluationRunTrialExpansion,
  type EvaluationSuitePresentation,
} from '../../state/evaluations.js';
import { overlayOpenState } from '../../state/ui.js';
import {
  useEvaluationRunStore,
  useHostedEvaluationCoordinator,
  useIOProvider,
  type HostedEvaluationRunState,
} from '../../providers/ProvidersContext.js';
import { useLoadRecording } from '../../hooks/useLoadRecording.js';
import { CollapsiblePanel } from '../CollapsiblePanel.js';
import { LabeledToggle } from '../LabeledToggle.js';
import { ScalableToggle } from '../ScalableToggle.js';
import { SegmentedEditor } from '../editors/SegmentedEditor.js';
import type { AbortEvaluation, TryRetryInterruptedEvaluation, TryRunEvaluation } from './api.js';
import { CreateEvaluationSuiteModal, type CreateEvaluationSuiteValue } from './CreateEvaluationSuiteModal.js';
import { EvaluationConfirmModal, type EvaluationConfirmation } from './EvaluationConfirmModal.js';
import {
  EvaluationDefinitionTabs,
  type EvaluationDefinitionTab,
  type EvaluationDefinitionTabId,
} from './EvaluationDefinitionTabs.js';
import { EvaluationFormField } from './EvaluationFormField.js';
import { EvaluationSectionTabs } from './EvaluationSectionTabs.js';
import { EvaluationSelect as Select } from './EvaluationSelect.js';
import { EvaluationSuiteSidebar } from './EvaluationSuiteSidebar.js';
import { EvaluationSuiteRunStatus, getEvaluationSuiteWarnings } from './EvaluationSuiteRunStatus.js';
import { EvaluationTrialDetails } from './EvaluationTrialDetails.js';
import { replaceEvaluationDatasetCasesFromCsv, serializeEvaluationDatasetCsv } from './evaluationDatasetCsv.js';
import {
  canCompareEvaluationSuite,
  evaluationAssertionOperatorOptions,
  getEvaluationTargetOutputs,
  getEvaluationRunQualityPresentation,
  getEvaluationSuiteReferenceStatus,
  getEvaluationTargetOutputPath,
  getEvaluationAssertionAuthoringIssue,
  getEvaluationInputBindingAuthoringIssues,
  getEvaluationDatasetValueTypeAuthoringIssues,
  getEvaluationExpectedValueAuthoringIssues,
  getEvaluationEvaluatorAuthoringIssue,
  getEvaluationExecutionConfigurationAuthoringIssues,
  getEvaluationThresholdAuthoringIssue,
  getUnusedExpectedFields,
  formatEvaluationDurationSeconds,
  formatEvaluationScore,
  formatEvaluationRunOptionLabel,
  getEvaluationRunHistoryPresentation,
  mergeEvaluationRunHistory,
  meanEvaluationTrialScore,
  resolveComparableEvaluationRun,
  resolveEvaluationTargetOutput,
  resolveEvaluationDataset,
  resolvePromptDesignerEvaluationProject,
  resolveSelectedEvaluationSuite,
  reassignEvaluationSuiteDataset,
  reassignEvaluationSuiteTarget,
  removeEvaluationDatasetField,
  removeEvaluationDatasetFieldReferences,
  suggestEvaluationAssertionOperator,
  sortEvaluationTrialsByScore,
  type EvaluationScoreSort,
  type EvaluationRunHistoryLoadStatus,
  type EvaluationTargetOutput,
  type EvaluationWorkspaceView,
} from './evaluationWorkspaceModel.js';

const evaluationScoreSortOptions: Array<{ label: string; value: EvaluationScoreSort }> = [
  { label: 'Default order', value: 'default' },
  { label: 'Score: highest first', value: 'score-desc' },
  { label: 'Score: lowest first', value: 'score-asc' },
];

type EvaluationRunSummary = NonNullable<ReturnType<typeof summarizeEvaluationRun>>;

// Completed run snapshots are immutable after they cross the store/runner
// boundary. Keep the score-by-case derivation by snapshot identity so a Runs
// tab remount does not repeat its observation walk. The summary intentionally
// re-derives newer factoids for legacy persisted aggregates that predate them.
const evaluationRunSummaryCache = new WeakMap<EvaluationRun, EvaluationRunSummary>();

function getCachedEvaluationRunSummary(run: EvaluationRun): EvaluationRunSummary | undefined {
  if (!run.aggregate) return undefined;
  const cached = evaluationRunSummaryCache.get(run);
  if (cached) return cached;
  const summary = summarizeEvaluationRun(run);
  if (summary) evaluationRunSummaryCache.set(run, summary);
  return summary;
}

function getEvaluationRunRecordingReferences(run: EvaluationRun): EvaluationRecordingReference[] {
  return run.trials.flatMap((trial) => [
    ...(trial.recording === undefined ? [] : [trial.recording]),
    ...trial.observations.flatMap((observation) =>
      observation.recording === undefined ? [] : [observation.recording],
    ),
  ]);
}

function withEvaluationRunRecordingRetention(
  run: EvaluationRun,
  recordingIds: ReadonlySet<string>,
  retention: EvaluationRecordingReference['retention'],
  expiresAt?: string,
): EvaluationRun {
  const update = (reference: EvaluationRecordingReference): EvaluationRecordingReference =>
    !recordingIds.has(reference.id)
      ? reference
      : {
          id: reference.id,
          retention,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        };
  return {
    ...run,
    trials: run.trials.map((trial) => ({
      ...trial,
      ...(trial.recording === undefined ? {} : { recording: update(trial.recording) }),
      observations: trial.observations.map((observation) =>
        observation.recording === undefined
          ? observation
          : { ...observation, recording: update(observation.recording) },
      ),
    })),
  };
}

const styles = css`
  position: fixed;
  inset: var(--project-selector-height) 0 0;
  z-index: 150;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  background: var(--grey-darker);
  color: var(--foreground);

  .evaluation-main {
    --evaluation-suite-status-width: clamp(350px, 20vw, 520px);

    min-width: 0;
    overflow: auto;
  }
  .evaluation-suite-header {
    padding: 18px 32px 0;
    background: var(--grey-darker);
  }
  .evaluation-dataset-header h1 {
    margin: 0;
    font-size: var(--ui-font-size-xl);
  }
  .evaluation-resource-title {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 4px;
    margin-bottom: 5px;
  }
  .evaluation-resource-title h1,
  .evaluation-resource-title h4 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .evaluation-resource-title h1 {
    font-size: var(--ui-font-size-xl);
  }
  .evaluation-resource-title h4 {
    font-size: var(--ui-font-size-lg);
  }
  .evaluation-resource-title-input {
    width: min(520px, 100%);
  }
  button.evaluation-title-edit-button {
    display: inline-flex;
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--grey-light);
    cursor: pointer;
    padding: 5px;
  }
  button.evaluation-title-edit-button:hover,
  button.evaluation-title-edit-button:focus-visible {
    background: var(--grey-darkish);
    color: var(--foreground);
  }
  button.evaluation-title-edit-button:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }
  button.evaluation-title-edit-button svg {
    width: 17px;
    height: 17px;
  }
  .evaluation-suite-title-row {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 0;
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
  .evaluation-suite-header-with-sticky-status .evaluation-suite-title-row {
    padding-right: calc(var(--evaluation-suite-status-width) + 16px);
  }
  .evaluation-run-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  button.evaluation-secondary-action:hover:not(:disabled),
  button.evaluation-secondary-action:focus-visible {
    background: var(--grey-darkish);
    color: var(--foreground);
  }
  button.evaluation-additional-settings-button:hover:not(:disabled),
  button.evaluation-additional-settings-button:focus-visible {
    background: var(--grey-darkish);
    color: var(--foreground);
  }
  .evaluation-suite-subtitle {
    margin: 0 0 8px;
    color: var(--grey-light);
  }
  @media (max-width: 1260px) {
    .evaluation-suite-header-with-sticky-status .evaluation-suite-title-row {
      padding-right: 0;
    }
    .evaluation-suite-header-export {
      display: none;
    }
  }
  button.evaluation-dataset-usage-toggle {
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0 2px;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 3px;
  }
  button.evaluation-dataset-usage-toggle:hover,
  button.evaluation-dataset-usage-toggle:focus-visible {
    color: var(--foreground);
  }
  button.evaluation-dataset-usage-toggle:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  .evaluation-dataset-usage-disclosure {
    display: flex;
    max-width: 760px;
    flex-direction: column;
    gap: 6px;
    margin: 0 0 8px;
    padding: 12px 14px;
    border: 1px solid var(--grey-darkish);
    border-radius: 6px;
    background: var(--grey-dark);
  }
  .evaluation-dataset-usage-disclosure > span {
    color: var(--grey-light);
  }
  .evaluation-dataset-usage-disclosure > div {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .evaluation-panel {
    padding: 24px 32px 44px;
  }
  .section {
    max-width: 950px;
    margin-bottom: 52px;
  }
  .section.evaluation-dataset-table-section {
    max-width: none;
  }
  .section.evaluation-mode-section {
    margin-bottom: 24px;
  }
  .section h2 {
    margin: 0 0 8px;
  }
  .section h3 {
    margin: 18px 0 8px;
  }
  .section > h3 {
    margin-top: 0;
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
  .evaluation-target-graph {
    max-width: 420px;
    grid-template-columns: minmax(0, 1fr);
  }
  .evaluation-execution-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 36px 16px;
    margin-top: 16px;
  }
  .evaluation-execution-primary-grid {
    display: grid;
    max-width: 660px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    margin-top: 16px;
  }
  .evaluation-additional-execution-settings {
    display: flex;
    max-width: 660px;
    flex-direction: column;
    gap: 14px;
    margin-top: 0;
    padding: 14px 16px 16px;
    border: 1px solid var(--grey-darkish);
    border-radius: 6px;
    background: color-mix(in srgb, var(--grey-dark) 84%, var(--grey-darker));
  }
  .evaluation-additional-execution-settings-header {
    display: flex;
    min-height: 28px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .evaluation-additional-execution-settings-header h3 {
    margin: 0;
    font-size: var(--ui-font-size-base);
  }
  button.evaluation-additional-settings-close {
    display: inline-flex;
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--grey-light);
    cursor: pointer;
    padding: 5px;
  }
  button.evaluation-additional-settings-close:hover,
  button.evaluation-additional-settings-close:focus-visible {
    background: var(--grey-darkish);
    color: var(--foreground);
  }
  button.evaluation-additional-settings-close:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }
  button.evaluation-additional-settings-close svg {
    width: 17px;
    height: 17px;
  }
  .evaluation-additional-execution-settings-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
  }
  .evaluation-execution-explanation {
    display: flex;
    max-width: 660px;
    flex-direction: column;
    gap: 8px;
    margin: 12px 0 18px;
  }
  .evaluation-execution-explanation p {
    margin: 0;
  }
  .evaluation-execution-grid .evaluation-field-description {
    min-height: 2.7em;
  }
  .evaluation-dataset-intro {
    max-width: 760px;
    padding: 12px 14px;
    border: 1px solid var(--grey-darkish);
    border-radius: 6px;
    background: var(--grey-dark);
    color: var(--grey-light);
    line-height: 1.5;
  }
  .evaluation-value-editor {
    min-width: 150px;
  }
  .evaluation-value-editor.is-structured {
    width: 100%;
    min-width: 0;
  }
  .evaluation-value-editor.is-structured textarea {
    line-height: 1.4;
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
    position: relative;
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
  .evaluation-editor-card > .field.full h4 {
    margin: 0 0 8px;
  }
  .evaluation-editor-card > .field.evaluation-evaluator-graph {
    grid-column: 1 / span 6;
  }
  .evaluation-evaluator-title {
    grid-column: 1 / span 6;
    margin: 0;
  }
  .evaluation-assertion-title {
    grid-column: 1 / -1;
    margin: 0;
  }
  .evaluation-assertion-title .evaluation-resource-title-input {
    width: 100%;
  }
  .evaluation-assertion-title {
    padding-right: 32px;
  }
  .evaluation-evaluator-title .evaluation-resource-title-input {
    width: 100%;
  }
  .evaluation-evaluator-required {
    display: flex;
    grid-column: 7 / span 3;
    min-height: 28px;
    align-items: center;
  }
  .evaluation-evaluator-required .labeled-toggle-field {
    align-items: center;
  }
  .evaluation-evaluator-run-on-error {
    display: flex;
    grid-column: 1 / span 6;
    align-items: center;
  }
  button.evaluation-editor-card-remove {
    position: absolute;
    top: 12px;
    right: 12px;
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
  .evaluation-checkboxes .labeled-toggle-field {
    align-items: center;
  }
  .evaluation-section-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 14px;
  }
  .evaluation-dataset-transfer-actions {
    flex: 0 0 auto;
  }
  .section.evaluation-quality-section {
    margin-bottom: 72px;
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
    .evaluation-editor-card > .field.evaluation-evaluator-graph {
      grid-column: 1 / -1;
    }
    .evaluation-evaluator-title,
    .evaluation-evaluator-required,
    .evaluation-evaluator-run-on-error {
      grid-column: 1 / -1;
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
    .evaluation-execution-primary-grid {
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
  .table.evaluation-binding-table {
    table-layout: fixed;
  }
  .table.evaluation-target-binding-table {
    width: min(100%, 540px);
  }
  .table.evaluation-evaluator-binding-table {
    width: min(100%, 760px);
  }
  .evaluation-target-binding-table th:first-child,
  .evaluation-target-binding-table td:first-child {
    width: 170px;
  }
  .evaluation-evaluator-binding-table th:first-child,
  .evaluation-evaluator-binding-table td:first-child {
    width: 205px;
  }
  .evaluation-binding-table tbody td:first-child {
    vertical-align: middle;
    white-space: nowrap;
  }
  /* Atlaskit's base table styles add a border to tbody itself. These authoring
     tables use a single divider below their column headings instead. */
  .table.evaluation-binding-table tbody,
  .table.evaluation-fields-table tbody,
  .table.evaluation-binding-table tbody td,
  .table.evaluation-fields-table tbody td {
    border-bottom: 0;
  }
  @media (max-width: 700px) {
    .evaluation-binding-table tbody td:first-child {
      white-space: normal;
    }
  }
  .table td.evaluation-toggle-cell {
    vertical-align: top;
  }
  .table td.evaluation-toggle-cell .scalable-toggle {
    margin-top: 10px;
  }
  .evaluation-cases {
    margin-top: 12px;
  }
  .evaluation-case-header-row,
  .evaluation-case-row {
    display: grid;
    gap: 12px;
  }
  .evaluation-case-header-row {
    border-bottom: 1px solid var(--grey-darkish);
    padding: 9px 8px;
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
    font-weight: 600;
  }
  .evaluation-case-row {
    align-items: start;
    padding: 10px 8px 14px;
  }
  .evaluation-case-enabled-control,
  .evaluation-case-actions {
    display: flex;
    height: 40px;
    align-items: center;
    align-self: start;
  }
  .evaluation-case-value-field {
    min-width: 0;
  }
  .evaluation-case-field-heading {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .evaluation-case-field-type {
    color: var(--grey-light);
    font-weight: 400;
  }
  .evaluation-case-name-control,
  .evaluation-case-tags-control,
  .evaluation-case-notes-control {
    min-width: 0;
  }
  .evaluation-case-value-field .evaluation-value-editor {
    width: 100%;
    min-width: 0;
  }
  button.evaluation-remove-button {
    display: inline-flex;
    width: 28px;
    height: 34px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--foreground-muted);
    cursor: pointer;
    padding: 5px;
  }
  button.evaluation-remove-button:hover,
  button.evaluation-remove-button:focus-visible {
    background-color: var(--grey-darkish);
    color: var(--error);
  }
  button.evaluation-remove-button:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }
  button.evaluation-remove-button svg {
    width: 18px;
    height: 18px;
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
  .status-scored {
    color: var(--primary);
  }
  .status-not-evaluated {
    color: var(--grey-light);
  }
  .status-unable-to-evaluate {
    color: var(--warning);
  }
  .evaluation-run-summary {
    display: grid;
    gap: 10px;
    margin-top: 16px;
  }
  .evaluation-run-name {
    margin-top: 16px;
    margin-bottom: 0;
  }
  .evaluation-run-name + .evaluation-run-summary {
    margin-top: 10px;
  }
  .evaluation-run-summary-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .evaluation-run-summary-statistics-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .evaluation-run-summary-item {
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--grey-darkish);
    border-radius: 6px;
    background: var(--grey-dark);
  }
  .evaluation-run-summary-item-warning {
    background: color-mix(in srgb, var(--warning) 12%, var(--grey-dark));
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
  .evaluation-run-summary-statistics-card-full {
    grid-column: 1 / -1;
  }
  .evaluation-run-summary-statistics-values {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .evaluation-run-summary-statistic-label {
    display: block;
    margin-bottom: 4px;
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
  }
  .evaluation-run-summary-statistic-value {
    display: block;
    overflow: hidden;
    color: var(--foreground);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .evaluation-run-summary-cost-warning {
    display: block;
    margin-top: 6px;
    color: var(--warning);
    font-size: var(--ui-font-size-sm);
    line-height: 1.4;
  }
  .evaluation-run-explanation,
  .evaluation-run-no-checks {
    margin: 24px 0 0;
    padding: 12px 14px;
    border-radius: 6px;
    line-height: 1.45;
  }
  .evaluation-run-summary-notice {
    padding-top: 24px;
  }
  .evaluation-run-summary-notice .evaluation-run-explanation {
    margin-top: 0;
  }
  .evaluation-run-explanation {
    width: 100%;
    max-width: none;
    background: color-mix(in srgb, var(--foreground) 7%, transparent);
    color: var(--foreground);
  }
  .evaluation-run-explanation-warning {
    background: color-mix(in srgb, var(--warning) 12%, transparent);
  }
  .evaluation-run-history-refresh-warning {
    margin: 0 0 16px;
    color: var(--warning);
    font-size: var(--ui-font-size-sm);
  }
  .evaluation-run-no-checks {
    max-width: 850px;
    background: color-mix(in srgb, var(--grey-light) 9%, transparent);
    color: var(--grey-light);
  }
  .evaluation-hosted-retry {
    display: grid;
    gap: 14px;
    max-width: 950px;
    margin-top: 18px;
    padding: 14px;
    border: 1px solid color-mix(in srgb, var(--warning) 48%, var(--grey-darkish));
    border-radius: 6px;
    background: color-mix(in srgb, var(--warning) 10%, var(--grey-dark));
  }
  .evaluation-hosted-retry h3,
  .evaluation-hosted-retry p {
    margin: 0;
  }
  .evaluation-hosted-retry h3 {
    margin-bottom: 6px;
  }
  .evaluation-hosted-retry p {
    max-width: 800px;
    color: var(--foreground);
    line-height: 1.45;
  }
  .evaluation-hosted-retry-selection {
    display: grid;
    gap: 8px;
  }
  .evaluation-hosted-retry-job-list {
    display: grid;
    gap: 6px;
    padding: 10px 12px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--grey-darkest) 38%, transparent);
  }
  .evaluation-hosted-retry-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
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
  .evaluation-runs-score-sort {
    width: min(240px, 100%);
    margin: 0;
  }
  .evaluation-trial-sort {
    margin-top: 18px;
  }
  .evaluation-trial-sort + .evaluation-trial-list {
    margin-top: 12px;
  }
  .evaluation-run-recording-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
    flex-wrap: wrap;
  }
  .evaluation-run-delete-action {
    position: fixed;
    right: 32px;
    bottom: 24px;
    z-index: 55;
  }
  @media (max-width: 720px) {
    .evaluation-run-delete-action {
      right: 16px;
      bottom: 16px;
    }
  }
  .evaluation-trial-toggle-summary {
    display: grid;
    width: 100%;
    min-width: 0;
    grid-template-columns: minmax(220px, 1fr) minmax(104px, 128px) minmax(120px, 140px) minmax(72px, 88px);
    align-items: center;
    gap: 14px;
    text-align: left;
  }
  .evaluation-trial .collapsible-panel-toggle .label {
    flex: 1 1 auto;
    min-width: 0;
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
  .evaluation-trial-toggle-summary .trial-execution,
  .evaluation-trial-toggle-summary .trial-quality,
  .evaluation-trial-toggle-summary .trial-duration {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    .evaluation-run-summary-row,
    .evaluation-trial-results,
    .evaluation-observation-list,
    .evaluation-threshold-result-list {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 700px) {
    .evaluation-run-summary-row,
    .evaluation-run-summary-statistics-row,
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
    .evaluation-trial-toggle-summary .trial-execution {
      display: none;
    }
    .evaluation-runs-score-sort {
      width: 100%;
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

function createDataset(suiteName = 'New evaluation suite'): EvaluationDataset {
  return { id: nanoid(), name: `${suiteName} dataset`, fields: [], cases: [] };
}

function createStandaloneDataset(): EvaluationDataset {
  return { id: nanoid(), name: 'New evaluation dataset', fields: [], cases: [] };
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

function withEvaluationRunName(run: EvaluationRun, value: string): EvaluationRun {
  const name = value.trim();
  if (name.length > 0) return { ...run, name };
  const { name: _name, ...unnamed } = run;
  return unnamed;
}

const ResourceTitle: FC<{
  className?: string;
  editing: boolean;
  fallback: string;
  headingLevel?: 'h1' | 'h4';
  label: string;
  onCommit: (value: string) => void;
  onFinishEditing: () => void;
  onStartEditing: () => void;
  value: string;
}> = ({
  className,
  editing,
  fallback,
  headingLevel = 'h1',
  label,
  onCommit,
  onFinishEditing,
  onStartEditing,
  value,
}) => {
  const [draft, setDraft] = useState(value);
  const didFinishEditing = useRef(false);
  const Heading = headingLevel;

  useEffect(() => {
    if (editing) {
      didFinishEditing.current = false;
      setDraft(value);
    }
  }, [editing, value]);

  const commit = () => {
    if (didFinishEditing.current) return;
    didFinishEditing.current = true;
    onCommit(draft);
    onFinishEditing();
  };

  const cancel = () => {
    if (didFinishEditing.current) return;
    didFinishEditing.current = true;
    setDraft(value);
    onFinishEditing();
  };

  return (
    <div className={`evaluation-resource-title${className ? ` ${className}` : ''}`}>
      {editing ? (
        <div className="evaluation-resource-title-input">
          <Textfield
            autoFocus
            aria-label={`Rename ${label}`}
            value={draft}
            onBlur={commit}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
              }
            }}
          />
        </div>
      ) : (
        <Heading>{value || fallback}</Heading>
      )}
      {!editing ? (
        <button
          className="evaluation-title-edit-button"
          type="button"
          aria-label={`Rename ${label}`}
          title={`Rename ${label}`}
          onClick={onStartEditing}
        >
          <EditIcon aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
};

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
  multiline?: boolean;
  onCommit: (value: PortableJson | undefined) => void;
  onValidityChange?: (invalid: boolean) => void;
}> = ({
  dataType = 'any',
  value,
  placeholder = 'JSON value',
  allowEmpty = true,
  multiline = false,
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
    <div className={`evaluation-value-editor${multiline ? ' is-structured' : ''}`}>
      {multiline ? (
        <TextArea
          value={draft}
          isMonospaced
          maxHeight="180px"
          minimumRows={3}
          placeholder={placeholder}
          resize="vertical"
          aria-invalid={isInvalid || undefined}
          onChange={(event) => updateDraft(event.currentTarget.value)}
        />
      ) : (
        <Textfield
          value={draft}
          placeholder={placeholder}
          aria-invalid={isInvalid || undefined}
          onChange={(event) => updateDraft(event.currentTarget.value)}
        />
      )}
      {isInvalid ? <span className="evaluation-value-error">Enter valid {dataType} JSON.</span> : null}
    </div>
  );
};

function isStructuredEvaluationDataType(dataType: string): boolean {
  return dataType !== 'string' && dataType !== 'number' && dataType !== 'boolean';
}

function hasStaticGraphInputDefault(input: GraphInputNode): boolean {
  return input.data.defaultValue !== undefined && !input.data.useDefaultValueInput;
}

function getEvaluationCaseGridTemplate(fields: EvaluationDatasetField[]): string {
  return [
    '56px',
    'minmax(0, 0.8fr)',
    'minmax(0, 0.9fr)',
    'minmax(0, 1fr)',
    ...fields.map((field) => (isStructuredEvaluationDataType(field.dataType) ? 'minmax(0, 2fr)' : 'minmax(0, 1fr)')),
    '28px',
  ].join(' ');
}

const RemoveButton: FC<{ className?: string; label: string; onClick: () => void }> = ({
  className,
  label,
  onClick,
}) => (
  <button
    className={`evaluation-remove-button${className ? ` ${className}` : ''}`}
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
  >
    <DeleteIcon aria-hidden="true" />
  </button>
);

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
      multiline={isStructuredEvaluationDataType(dataType)}
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
  if (metric === 'average-latency-ms') return 'Average latency';
  if (metric === 'p95-latency-ms') return 'P95 latency';
  const name = metric.startsWith('custom:') ? metric.slice('custom:'.length) : metric;
  return name.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

const percentageThresholdMetrics = new Set([
  'pass-rate',
  'mean-score',
  'target-error-rate',
  'evaluator-error-rate',
  'tool-failure-rate',
]);

function thresholdUsesPercentageValue(metric: string, operator: EvaluationThreshold['operator']): boolean {
  return operator === 'max-regression' || percentageThresholdMetrics.has(metric);
}

function isLatencyThresholdMetric(metric: string): boolean {
  return metric === 'average-latency-ms' || metric === 'p95-latency-ms';
}

function formatPercentageThresholdValue(value: number): string {
  return String(Number((value * 100).toFixed(4)));
}

function formatEvaluationMetricValue(metric: string, value: number | undefined): string {
  if (value === undefined) return 'Unavailable';
  if (percentageThresholdMetrics.has(metric)) {
    return `${(value * 100).toFixed(value * 100 === Math.round(value * 100) ? 0 : 1)}%`;
  }
  if (metric === 'average-cost' || metric === 'total-cost') return `$${value.toFixed(4)}`;
  if (isLatencyThresholdMetric(metric)) return formatEvaluationDurationSeconds(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function evaluatorInputSourceKey(source: EvaluationEvaluatorInputSource): string {
  if (source.kind === 'dataset-field') return `dataset-field:${source.fieldId}`;
  if (source.kind === 'target-output') return `target-output:${source.outputId}`;
  return `context:${source.context}`;
}

const evaluatorContextLabels = {
  case: 'Case metadata and all field values',
  inputs: 'All supplied target inputs',
  expected: 'All expected dataset fields',
  outputs: 'All target outputs',
  run: 'Trial metadata',
} as const;

function describeEvaluationThreshold(metric: string, operator: EvaluationThreshold['operator'], value: number): string {
  if (operator === 'at-least') return `At least ${formatEvaluationMetricValue(metric, value)}`;
  if (operator === 'at-most') return `At most ${formatEvaluationMetricValue(metric, value)}`;
  return `Regression no greater than ${formatEvaluationMetricValue('pass-rate', value)}`;
}

function formatEvaluationComparisonMetric(label: string, value: number | undefined): string {
  if (value === undefined) return label === 'Total cost' ? 'Unavailable' : '—';
  if (label === 'Overall score') return formatEvaluationScore(value);
  if (label === 'Pass rate') return `${Math.round(value * 100)}%`;
  if (label === 'P95 latency') return formatEvaluationDurationSeconds(value);
  if (label === 'Total cost') return `$${value.toFixed(4)}`;
  return value.toFixed(4);
}

export const EvaluationsRenderer: FC<{
  tryRunEvaluation: TryRunEvaluation;
  retryInterruptedEvaluation: TryRetryInterruptedEvaluation;
  abortEvaluation: AbortEvaluation;
}> = ({ tryRunEvaluation, abortEvaluation, retryInterruptedEvaluation }) => {
  const openOverlay = useAtomValue(overlayOpenState);
  if (openOverlay !== 'evaluations') return null;
  return (
    <EvaluationsContainer
      tryRunEvaluation={tryRunEvaluation}
      retryInterruptedEvaluation={retryInterruptedEvaluation}
      abortEvaluation={abortEvaluation}
    />
  );
};

const EvaluationsContainer: FC<{
  tryRunEvaluation: TryRunEvaluation;
  retryInterruptedEvaluation: TryRetryInterruptedEvaluation;
  abortEvaluation: AbortEvaluation;
}> = ({ tryRunEvaluation, abortEvaluation, retryInterruptedEvaluation }) => {
  const [state, setState] = useAtom(evaluationsState);
  const storedProject = useAtomValue(projectState);
  const openedProjects = useAtomValue(projectsState);
  const projectAvailable = openedProjects.openedProjects[storedProject.metadata.id] !== undefined;
  // The persisted project atom intentionally outlives an open tab. Never use
  // its stale graphs when Evaluations is opened from Rivet's welcome screen.
  const project = projectAvailable ? storedProject : ({ ...storedProject, graphs: {} } as Project);
  const runStore = useEvaluationRunStore();
  const io = useIOProvider();
  const { loadSerializedRecording } = useLoadRecording();
  const graph = useAtomValue(graphState);
  const setOpenOverlay = useSetAtom(overlayOpenState);
  const view = state.activeView ?? 'definition';
  const setView = useCallback(
    (nextView: EvaluationWorkspaceView) =>
      setState((current) => {
        let next = current.activeView === nextView ? current : { ...current, activeView: nextView };
        if (nextView !== 'dataset' && current.selectedSuiteId) {
          next = updateEvaluationSuitePresentation(
            next,
            { projectId: project.metadata.id, suiteId: current.selectedSuiteId },
            { activeView: nextView },
          );
        }
        return next;
      }),
    [project.metadata.id, setState],
  );
  const [createSuiteOpen, setCreateSuiteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<EvaluationConfirmation>();
  const [hasInvalidDatasetDraft, setHasInvalidDatasetDraft] = useState(false);
  const [renamingDatasetId, setRenamingDatasetId] = useState<string>();
  const [renamingSuiteId, setRenamingSuiteId] = useState<string>();
  const [datasetUsageExpanded, setDatasetUsageExpanded] = useState(false);
  const [runsStatus, setRunsStatus] = useState<EvaluationRunHistoryLoadStatus>('idle');
  const [runsError, setRunsError] = useState<string>();
  const [retryingHostedRunId, setRetryingHostedRunId] = useState<string>();
  // Reading history is asynchronous, while deleting a run updates the store
  // and local selection immediately. A request generation prevents an older
  // read from putting the deleted record back into the Runs view afterward.
  const runHistoryReadGeneration = useRef(0);
  const evaluationMainRef = useRef<HTMLElement>(null);
  const runScrollTopRef = useRef(0);
  const restoredRunScrollScopeRef = useRef<string>();
  // The overlay unmounts while Canvas is active. Keep the latest cache marker
  // in a ref so returning to the same suite does not replay every retained run
  // payload from durable storage merely because this effect starts again.
  const runHistoryScopeRef = useRef(state.runHistoryScope);
  runHistoryScopeRef.current = state.runHistoryScope;
  const selectedSuite = resolveSelectedEvaluationSuite(state.data.suites, state.selectedSuiteId);
  const selectedSuiteId = selectedSuite?.id;
  const suitePresentationScope = useMemo<EvaluationRunHistoryScope | undefined>(
    () => (selectedSuiteId ? { projectId: project.metadata.id, suiteId: selectedSuiteId } : undefined),
    [project.metadata.id, selectedSuiteId],
  );
  const runHistoryScope = useMemo<EvaluationRunHistoryScope | undefined>(
    () =>
      selectedSuiteId && projectAvailable ? { projectId: project.metadata.id, suiteId: selectedSuiteId } : undefined,
    [project.metadata.id, projectAvailable, selectedSuiteId],
  );
  const runHistoryProjectId = runHistoryScope?.projectId;
  const runHistorySuiteId = runHistoryScope?.suiteId;
  const runHistoryScopeKey = runHistoryScope ? getEvaluationRunHistoryScopeKey(runHistoryScope) : undefined;
  const suitePresentation = getEvaluationSuitePresentation(state, suitePresentationScope);
  const hasCachedRunHistory = isEvaluationRunHistoryCached(state, runHistoryScope);
  const visibleRunTrialExpansion =
    state.runTrialExpansion?.scope.projectId === runHistoryProjectId &&
    state.runTrialExpansion?.scope.suiteId === runHistorySuiteId
      ? state.runTrialExpansion
      : undefined;
  const runScoreSort: EvaluationScoreSort = runHistoryScopeKey
    ? state.runScoreSortByScope[runHistoryScopeKey] ?? 'default'
    : 'default';
  const localDatasets = state.datasets;
  const selectedDataset = resolveEvaluationDataset(state.datasets, state.selectedDatasetId);
  const selectedDatasetSuites = selectedDataset
    ? state.data.suites.filter((suite) => suite.datasetId === selectedDataset.id)
    : [];
  // A project saved by an older editor can retain both selections. The active
  // view still disambiguates it; new navigation always selects exactly one
  // peer resource.
  const showingDataset = selectedDataset != null && (view === 'dataset' || selectedSuite == null);
  const suiteDataset = resolveEvaluationDataset(state.datasets, selectedSuite?.datasetId);
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
  const suiteRuns = useMemo(
    () => (selectedSuiteId ? state.runs.filter((run) => run.suiteId === selectedSuiteId) : []),
    [selectedSuiteId, state.runs],
  );
  const suiteCurrentRun = state.currentRun?.suiteId === selectedSuite?.id ? state.currentRun : undefined;
  const suiteBaseline = useMemo(
    () =>
      selectedSuiteId ? state.data.baselines.find((candidate) => candidate.suiteId === selectedSuiteId) : undefined,
    [selectedSuiteId, state.data.baselines],
  );
  const compareAvailable = useMemo(
    () => (selectedSuiteId ? canCompareEvaluationSuite(selectedSuiteId, suiteRuns, state.data.baselines) : false),
    [selectedSuiteId, state.data.baselines, suiteRuns],
  );
  const comparableRun = useMemo(
    () =>
      selectedSuiteId
        ? resolveComparableEvaluationRun(selectedSuiteId, suiteRuns, state.selectedRunId, suiteCurrentRun)
        : undefined,
    [selectedSuiteId, state.selectedRunId, suiteCurrentRun, suiteRuns],
  );

  useEffect(() => {
    setRenamingSuiteId(undefined);
  }, [selectedSuiteId]);

  useEffect(() => {
    setRenamingDatasetId(undefined);
    setDatasetUsageExpanded(false);
  }, [selectedDataset?.id]);

  const updateSuite = (update: (suite: EvaluationSuite) => EvaluationSuite) =>
    setState((current) => ({
      ...current,
      data: {
        ...current.data,
        suites: current.data.suites.map((suite) => (suite.id === selectedSuite?.id ? update(suite) : suite)),
      },
    }));

  const updateSelectedSuitePresentation = useCallback(
    (update: Partial<EvaluationSuitePresentation>) => {
      if (!suitePresentationScope) return;
      setState((current) => updateEvaluationSuitePresentation(current, suitePresentationScope, update));
    },
    [setState, suitePresentationScope],
  );

  const addSuite = ({ datasetId, graphId, name }: CreateEvaluationSuiteValue) =>
    setState((current) => {
      const existingDataset =
        datasetId == null ? undefined : current.datasets.find((dataset) => dataset.id === datasetId);
      const dataset = existingDataset ?? createDataset(name);
      const suite = createSuite(dataset, graphId, name);
      return {
        ...current,
        datasets: existingDataset == null ? [...current.datasets, dataset] : current.datasets,
        data: {
          ...current.data,
          suites: [...current.data.suites, suite],
        },
        selectedSuiteId: suite.id,
        selectedDatasetId: undefined,
        runs: [],
        runHistoryScope: undefined,
        runTrialExpansion: undefined,
        selectedRunId: undefined,
      };
    });

  const createSuiteFromDialog = (value: CreateEvaluationSuiteValue) => {
    addSuite(value);
    setCreateSuiteOpen(false);
    setView('definition');
  };

  const deleteEvaluationResources = ({ suiteIds, datasetId }: { suiteIds: readonly string[]; datasetId?: string }) => {
    const removedSuiteIds = new Set(suiteIds);
    let deletionWasBlocked = false;

    setState((current) => {
      if (current.runningSuiteId && removedSuiteIds.has(current.runningSuiteId)) {
        deletionWasBlocked = true;
        return current;
      }
      const workspace = discardEvaluationSuiteWorkspaceState(current, removedSuiteIds);
      return {
        ...workspace,
        datasets:
          datasetId == null ? workspace.datasets : workspace.datasets.filter((dataset) => dataset.id !== datasetId),
        data: {
          ...workspace.data,
          suites: workspace.data.suites.filter((suite) => !removedSuiteIds.has(suite.id)),
          baselines: workspace.data.baselines.filter((baseline) => !removedSuiteIds.has(baseline.suiteId)),
        },
        selectedSuiteId: removedSuiteIds.has(workspace.selectedSuiteId ?? '') ? undefined : workspace.selectedSuiteId,
        selectedDatasetId: datasetId === workspace.selectedDatasetId ? undefined : workspace.selectedDatasetId,
      };
    });
    if (deletionWasBlocked) {
      toast.warn('Stop the running evaluation before deleting its suite or dataset.');
      return;
    }
  };

  const requestDeleteSuite = (suiteId: string) => {
    const suite = state.data.suites.find((candidate) => candidate.id === suiteId);
    if (!suite) return;
    if (state.runningSuiteId === suiteId) {
      toast.warn('Stop the running evaluation before deleting its suite.');
      return;
    }
    setConfirmation({
      appearance: 'danger',
      title: 'Delete evaluation suite?',
      description: `Delete "${suite.name || 'Untitled evaluation suite'}"? Its baselines will be removed. Run history belongs to each project and is retained.`,
      confirmLabel: 'Delete suite',
      onConfirm: () => deleteEvaluationResources({ suiteIds: [suiteId] }),
    });
  };

  const requestDeleteDataset = (datasetId: string) => {
    const dataset = state.datasets.find((candidate) => candidate.id === datasetId);
    if (!dataset) return;
    const dependentSuites = state.data.suites.filter((suite) => suite.datasetId === datasetId);
    if (dependentSuites.some((suite) => suite.id === state.runningSuiteId)) {
      toast.warn('Stop the running evaluation before deleting its dataset.');
      return;
    }
    const dependentSuiteIds = dependentSuites.map((suite) => suite.id);
    const dependentDescription =
      dependentSuiteIds.length === 0
        ? ''
        : ` It is used by ${dependentSuiteIds.length} evaluation suite${dependentSuiteIds.length === 1 ? '' : 's'}, which will also be deleted with their baselines. Run history remains with each project.`;
    setConfirmation({
      appearance: 'danger',
      title: dependentSuiteIds.length > 0 ? 'Delete dataset and dependent suites?' : 'Delete evaluation dataset?',
      description: `Delete "${dataset.name || 'Untitled evaluation dataset'}"?${dependentDescription}`,
      confirmLabel: dependentSuiteIds.length > 0 ? 'Delete dataset and suites' : 'Delete dataset',
      onConfirm: () => deleteEvaluationResources({ suiteIds: dependentSuiteIds, datasetId }),
    });
  };

  const selectSuite = (suiteId: string) => {
    const scope: EvaluationRunHistoryScope = { projectId: project.metadata.id, suiteId };
    setState((current) => {
      const cachedSuiteRuns = isEvaluationRunHistoryCached(current, scope)
        ? current.runs.filter((run) => run.suiteId === suiteId)
        : [];
      return selectEvaluationSuiteResource(
        current,
        scope,
        canCompareEvaluationSuite(suiteId, cachedSuiteRuns, current.data.baselines),
      );
    });
  };

  const selectDataset = (datasetId: string) => {
    setState((current) => selectEvaluationDatasetResource(current, datasetId));
  };

  const createDatasetResource = () => {
    const dataset = createStandaloneDataset();
    setState((current) =>
      selectEvaluationDatasetResource({ ...current, datasets: [...current.datasets, dataset] }, dataset.id),
    );
  };

  const importDatasetResource = () => {
    void io
      .readFileAsString((source, fileName) => {
        try {
          const dataset = deserializeEvaluationDatasetJson(source, { id: nanoid() });
          setState((current) =>
            selectEvaluationDatasetResource({ ...current, datasets: [...current.datasets, dataset] }, dataset.id),
          );
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

  const importSuiteResource = () => {
    void io
      .readFileAsString((source, fileName) => {
        try {
          const imported = deserializeEvaluationSuiteBundleJson(source, { suiteId: nanoid(), datasetId: nanoid() });
          setState((current) => ({
            ...current,
            datasets: [...current.datasets, imported.dataset],
            data: {
              ...current.data,
              suites: [...current.data.suites, imported.suite],
            },
            selectedSuiteId: imported.suite.id,
            selectedDatasetId: undefined,
            runs: [],
            runHistoryScope: undefined,
            runTrialExpansion: undefined,
            selectedRunId: undefined,
            currentRun: undefined,
          }));
          setView('definition');
          toast.success(`Imported evaluation suite and dataset from ${fileName}. Repair graph references if needed.`);
        } catch (error) {
          toast.error(
            `Could not import the evaluation suite: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })
      .catch((error) =>
        toast.error(
          `Could not open an evaluation suite file: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
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
        dataset.id === sourceDataset.id ? { ...dataset, cases: [...dataset.cases, testCase] } : dataset,
      ),
    }));
  };

  const commitRemoveDatasetField = (datasetId: string, fieldId: string) => {
    setState((current) => {
      const dataset = resolveEvaluationDataset(current.datasets, datasetId);
      if (!dataset || !dataset.fields.some((field) => field.id === fieldId)) return current;
      return {
        ...current,
        datasets: current.datasets.map((candidate) =>
          candidate.id === dataset.id ? removeEvaluationDatasetField(candidate, fieldId) : candidate,
        ),
        data: {
          ...current.data,
          suites: current.data.suites.map((suite) =>
            suite.datasetId === dataset.id ? removeEvaluationDatasetFieldReferences(suite, fieldId) : suite,
          ),
        },
      };
    });
  };

  const requestRemoveDatasetField = (datasetId: string, fieldId: string) => {
    const dataset = resolveEvaluationDataset(state.datasets, datasetId);
    const field = dataset?.fields.find((candidate) => candidate.id === fieldId);
    if (!dataset || !field) return;
    const affectedSuites = state.data.suites.filter(
      (suite) =>
        suite.datasetId === dataset.id &&
        (suite.inputBindings.some((binding) => binding.datasetFieldId === fieldId) ||
          suite.assertions.some(
            (assertion) => assertion.expected.kind === 'dataset-field' && assertion.expected.fieldId === fieldId,
          ) ||
          suite.evaluators.some((evaluator) =>
            evaluator.inputBindings?.some(
              (binding) => binding.source.kind === 'dataset-field' && binding.source.fieldId === fieldId,
            ),
          )),
    );
    if (affectedSuites.some((suite) => suite.id === state.runningSuiteId)) {
      toast.warn('Stop the evaluation using this field before removing it.');
      return;
    }
    const remove = () => commitRemoveDatasetField(dataset.id, fieldId);
    if (affectedSuites.length === 0) {
      remove();
      return;
    }
    setConfirmation({
      appearance: 'danger',
      title: 'Remove dataset field and suite bindings?',
      description: `Removing "${field.name || 'Untitled field'}" also clears its target-input, deterministic-check, and evaluator bindings from ${affectedSuites.length} evaluation suite${affectedSuites.length === 1 ? '' : 's'}.`,
      confirmLabel: 'Remove field',
      onConfirm: remove,
    });
  };

  const assignSuiteDataset = (datasetId: string) => {
    if (!selectedSuite || datasetId === selectedSuite.datasetId) return;
    if (resolveEvaluationDataset(state.datasets, datasetId) == null) {
      toast.error('Choose an evaluation dataset from the local evaluation library.');
      return;
    }
    const hasDatasetContracts =
      selectedSuite.inputBindings.length > 0 ||
      selectedSuite.assertions.some((assertion) => assertion.expected.kind === 'dataset-field') ||
      selectedSuite.evaluators.some((evaluator) =>
        evaluator.inputBindings?.some((binding) => binding.source.kind === 'dataset-field'),
      );
    if (hasDatasetContracts) {
      setConfirmation({
        title: 'Change evaluation dataset?',
        description:
          'Changing the dataset clears target and evaluator bindings that use dataset fields, and replaces deterministic-check references with null literals.',
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
          suite.id === suiteId ? reassignEvaluationSuiteDataset(suite, datasetId) : suite,
        ),
      },
    }));
  };

  const assignTargetGraph = (graphId: string) => {
    if (!selectedSuite || graphId === selectedSuite.targetGraphId) return;
    const hasTargetContracts =
      selectedSuite.inputBindings.length > 0 ||
      selectedSuite.assertions.length > 0 ||
      selectedSuite.evaluators.some((evaluator) =>
        evaluator.inputBindings?.some((binding) => binding.source.kind === 'target-output'),
      );
    if (hasTargetContracts) {
      setConfirmation({
        title: 'Change target graph?',
        description:
          'Changing the target graph clears target-input bindings, deterministic-check output selections, and evaluator bindings to target outputs.',
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
            ? reassignEvaluationSuiteTarget(suite, graphId as EvaluationSuite['targetGraphId'])
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
  const isScoringSuite = selectedSuite ? getEvaluationSuiteMode(selectedSuite) === 'scoring' : false;
  const hasInvalidQualityChecks =
    !isScoringSuite &&
    (selectedSuite?.assertions.some((assertion) =>
      Boolean(
        getEvaluationAssertionAuthoringIssue(
          assertion,
          targetOutputs,
          suiteDataset?.fields.filter((field) => field.role === 'expected') ?? [],
        ),
      ),
    ) ??
      false);
  const expectedValueIssues =
    selectedSuite && suiteDataset ? getEvaluationExpectedValueAuthoringIssues(selectedSuite, suiteDataset) : [];
  const datasetValueTypeIssues = suiteDataset ? getEvaluationDatasetValueTypeAuthoringIssues(suiteDataset) : [];
  const datasetValueTypeIssueSet = new Set(datasetValueTypeIssues);
  const hasInvalidDatasetValues = datasetValueTypeIssues.length > 0;
  const hasInvalidExpectedValues = expectedValueIssues.some((issue) => !datasetValueTypeIssueSet.has(issue));
  const hasInvalidEvaluatorConfiguration =
    selectedSuite?.evaluators.some((evaluator) =>
      getEvaluationEvaluatorAuthoringIssue(evaluator, project, selectedSuite, suiteDataset),
    ) ?? false;
  const hasInvalidThresholdConfiguration =
    !isScoringSuite &&
    (selectedSuite?.thresholds?.some((threshold) => getEvaluationThresholdAuthoringIssue(threshold, selectedSuite)) ??
      false);
  const hasInvalidEvaluationConfiguration = hasInvalidEvaluatorConfiguration || hasInvalidThresholdConfiguration;
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
  const usesPromptDesignerDraft =
    selectedSuite !== undefined &&
    referenceStatus?.targetGraphExists === true &&
    resolvePromptDesignerEvaluationProject(
      state.promptDesignerProjectOverride,
      project.metadata.id,
      selectedSuite.targetGraphId,
    ) !== undefined;
  const suiteWideWarnings = selectedSuite
    ? getEvaluationSuiteWarnings({
        mode: isScoringSuite ? 'scoring' : 'pass-fail',
        hasQualityCriteria,
        projectAvailable,
        datasetExists: referenceStatus?.datasetExists === true,
        targetGraphExists: referenceStatus?.targetGraphExists === true,
        evaluatorGraphsExist: referenceStatus?.evaluatorGraphsExist === true,
        executionCount,
        hasInvalidDatasetDraft,
        hasInvalidDatasetValues,
        hasInvalidExecutionSetup,
        hasInvalidQualityChecks,
        hasInvalidExpectedValues,
        hasInvalidEvaluatorConfiguration,
        hasInvalidThresholdConfiguration,
        usesPromptDesignerDraft,
        hasDormantPassFailConfiguration:
          isScoringSuite && (selectedSuite.assertions.length > 0 || (selectedSuite.thresholds?.length ?? 0) > 0),
        anotherEvaluationRunning: state.runningSuiteId !== undefined && state.runningSuiteId !== selectedSuite.id,
      })
    : [];

  const benchmarkDisabled =
    !projectAvailable ||
    executionCount === 0 ||
    hasInvalidDatasetDraft ||
    hasInvalidDatasetValues ||
    hasInvalidExecutionSetup ||
    !referenceStatus?.datasetExists ||
    !referenceStatus?.targetGraphExists ||
    state.runningSuiteId !== undefined;
  const evaluationDisabled =
    benchmarkDisabled ||
    !hasQualityCriteria ||
    hasInvalidQualityChecks ||
    hasInvalidExpectedValues ||
    hasInvalidEvaluationConfiguration ||
    !referenceStatus?.evaluatorGraphsExist;
  const evaluationDisabledTitle = !projectAvailable
    ? "Open a project containing this suite's target graph and any evaluator graphs before running it."
    : !referenceStatus?.datasetExists
      ? 'Select an available evaluation dataset before running this suite.'
      : !referenceStatus?.targetGraphExists
        ? 'Select a target graph that exists in the open project before running this suite.'
        : executionCount === 0
          ? 'Enable or add at least one dataset case before running this suite.'
          : !hasQualityCriteria
            ? isScoringSuite
              ? 'Add an evaluator graph that returns result.score before running a scoring evaluation.'
              : 'Add a required quality check, evaluator graph, or threshold before running an evaluation.'
            : hasInvalidDatasetDraft
              ? 'Fix invalid dataset values before running this evaluation.'
              : hasInvalidDatasetValues
                ? 'Fix dataset values that do not match their declared field types before running.'
                : hasInvalidExecutionSetup
                  ? 'Fix target input bindings, missing case input values, and execution settings before running.'
                  : hasInvalidQualityChecks
                    ? 'Fix the highlighted deterministic quality checks before running this evaluation.'
                    : hasInvalidExpectedValues
                      ? isScoringSuite
                        ? 'Add missing required dataset values and fix values that do not match their declared field types.'
                        : 'Add the required expected values and fix values that do not match their quality checks.'
                      : !referenceStatus?.evaluatorGraphsExist
                        ? 'Repair or remove missing evaluator graphs before running this suite.'
                        : hasInvalidEvaluationConfiguration
                          ? hasInvalidEvaluatorConfiguration && hasInvalidThresholdConfiguration
                            ? 'Fix the highlighted evaluator graph and aggregate threshold settings before running this evaluation.'
                            : hasInvalidEvaluatorConfiguration
                              ? 'Fix the highlighted evaluator graph settings before running this evaluation.'
                              : 'Fix the highlighted aggregate threshold settings before running this evaluation.'
                          : state.runningSuiteId !== undefined
                            ? 'Another evaluation is already running for this project.'
                            : undefined;

  useEffect(() => {
    const readGeneration = ++runHistoryReadGeneration.current;
    if (!projectAvailable) {
      setRunsStatus('idle');
      setRunsError(undefined);
      setState((current) =>
        current.runs.length === 0 &&
        current.selectedRunId == null &&
        current.currentRun == null &&
        current.runHistoryScope == null &&
        current.runTrialExpansion == null
          ? current
          : {
              ...current,
              runs: [],
              runHistoryScope: undefined,
              runTrialExpansion: undefined,
              selectedRunId: undefined,
              currentRun: undefined,
            },
      );
      return;
    }
    if (!selectedSuiteId) {
      // A dataset is a peer editor, not a new run-history scope. Keep the
      // last suite's fully hydrated history and presentation warm so a quick
      // resource switch does not reread and rebuild the Runs pane.
      setRunsStatus('idle');
      setRunsError(undefined);
      return;
    }

    const scope: EvaluationRunHistoryScope = { projectId: project.metadata.id, suiteId: selectedSuiteId };
    const hadCachedHistory = isEvaluationRunHistoryCached({ runHistoryScope: runHistoryScopeRef.current }, scope);
    // A successfully listed exact scope is complete for this session. Reuse it
    // on an overlay remount instead of doing a synchronous-heavy durable read
    // before Definition, Runs, or Compare can respond to a tab click.
    setRunsStatus(hadCachedHistory ? 'ready' : 'loading');
    setRunsError(undefined);
    if (hadCachedHistory) return;

    let active = true;
    void runStore
      .list({ projectId: project.metadata.id, suiteId: selectedSuiteId })
      .then((runs) => {
        if (!active || readGeneration !== runHistoryReadGeneration.current) return;
        setRunsStatus('ready');
        setState((current) => {
          // The store contract accepts a suite filter, but retain the client
          // boundary as well. A stale or buggy host store must not leak a
          // different suite's history into the selected suite or its Compare
          // view.
          const persistedSuiteRuns = runs.filter((run) => run.suiteId === selectedSuiteId);
          const mergedRuns = mergeEvaluationRunHistory(
            persistedSuiteRuns,
            current.currentRun?.suiteId === selectedSuiteId ? current.currentRun : undefined,
          );
          const selectedRunId =
            current.selectedRunId && mergedRuns.some((run) => run.id === current.selectedRunId)
              ? current.selectedRunId
              : mergedRuns[0]?.id;
          return {
            ...current,
            runs: mergedRuns,
            // Only a successful list proves the full stored history is warm.
            // Progress and terminal snapshots intentionally do not set this.
            runHistoryScope: scope,
            runTrialExpansion:
              current.runTrialExpansion?.scope.projectId === scope.projectId &&
              current.runTrialExpansion.scope.suiteId === scope.suiteId &&
              current.runTrialExpansion.runId === selectedRunId
                ? current.runTrialExpansion
                : undefined,
            selectedRunId,
          };
        });
      })
      .catch((error: unknown) => {
        if (!active || readGeneration !== runHistoryReadGeneration.current) return;
        setRunsStatus('error');
        setRunsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
    // Run lifecycle changes are delivered directly by the executor. In
    // particular, a terminal update atomically installs and selects the final
    // in-memory run before recording retention and persistence. Reloading
    // history when `runningSuiteId` changes would briefly replace that selection
    // with whichever old run the store returned first.
  }, [project.metadata.id, projectAvailable, runStore, selectedSuiteId, setState]);

  // An in-memory snapshot is authoritative while the runner is active and
  // remains useful for the terminal hand-off to durable history. Keep it
  // visible rather than replacing it with a loader (or a history-read error);
  // the failed read is still surfaced as a non-blocking warning.
  const runsHistoryPresentation = getEvaluationRunHistoryPresentation(
    runsStatus,
    runHistoryScope !== undefined,
    hasCachedRunHistory,
    suiteCurrentRun !== undefined,
  );
  const visibleRunsStatus = runsHistoryPresentation.status;
  const runHistoryRefreshError = runsHistoryPresentation.hasEvidence ? runsError : undefined;

  const updateRunScoreSort = useCallback(
    (scoreSort: EvaluationScoreSort) => {
      if (!runHistoryScopeKey) return;
      setState((current) =>
        current.runScoreSortByScope[runHistoryScopeKey] === scoreSort
          ? current
          : {
              ...current,
              runScoreSortByScope: { ...current.runScoreSortByScope, [runHistoryScopeKey]: scoreSort },
            },
      );
    },
    [runHistoryScopeKey, setState],
  );

  const updateExpandedTrials = useCallback(
    (runId: string | undefined, trialIds: readonly string[]) => {
      if (!runHistoryProjectId || !runHistorySuiteId) return;
      const scope: EvaluationRunHistoryScope = {
        projectId: runHistoryProjectId,
        suiteId: runHistorySuiteId,
      };
      const nextTrialIds = [...new Set(trialIds)];
      setState((current) => {
        if (!runId || nextTrialIds.length === 0) {
          return current.runTrialExpansion === undefined ? current : { ...current, runTrialExpansion: undefined };
        }
        const currentExpansion = current.runTrialExpansion;
        if (
          currentExpansion?.scope.projectId === scope.projectId &&
          currentExpansion.scope.suiteId === scope.suiteId &&
          currentExpansion.runId === runId &&
          currentExpansion.trialIds.length === nextTrialIds.length &&
          currentExpansion.trialIds.every((trialId, index) => trialId === nextTrialIds[index])
        ) {
          return current;
        }
        return {
          ...current,
          runTrialExpansion: { scope, runId, trialIds: nextTrialIds },
        };
      });
    },
    [runHistoryProjectId, runHistorySuiteId, setState],
  );

  const selectRun = useCallback(
    (runId: string) =>
      setState((current) => ({
        ...current,
        selectedRunId: runId,
        // A trial card belongs to one run. Match the previous in-component
        // behaviour and never carry it to the newly selected history entry.
        runTrialExpansion: undefined,
      })),
    [setState],
  );

  const persistRunScrollPosition = useCallback(() => {
    if (view !== 'runs' || !runHistoryScopeKey) return;
    const scrollTop = Math.max(0, runScrollTopRef.current);
    setState((current) =>
      current.runScrollTopByScope[runHistoryScopeKey] === scrollTop
        ? current
        : {
            ...current,
            runScrollTopByScope: { ...current.runScrollTopByScope, [runHistoryScopeKey]: scrollTop },
          },
    );
  }, [runHistoryScopeKey, setState, view]);

  useEffect(() => {
    return () => persistRunScrollPosition();
  }, [persistRunScrollPosition]);

  useLayoutEffect(() => {
    if (view !== 'runs' || !runHistoryScopeKey || !hasCachedRunHistory) {
      restoredRunScrollScopeRef.current = undefined;
      return;
    }
    if (restoredRunScrollScopeRef.current === runHistoryScopeKey) return;

    const scrollTop = state.runScrollTopByScope[runHistoryScopeKey] ?? 0;
    if (evaluationMainRef.current) evaluationMainRef.current.scrollTop = scrollTop;
    runScrollTopRef.current = scrollTop;
    restoredRunScrollScopeRef.current = runHistoryScopeKey;
  }, [hasCachedRunHistory, runHistoryScopeKey, state.runScrollTopByScope, view]);

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
    if (!selectedSuite || !projectAvailable) {
      toast.info("Open a project containing this suite's target graph and any evaluator graphs before running it.");
      return;
    }
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
      !projectAvailable ||
      executionCount === 0 ||
      hasInvalidDatasetDraft ||
      hasInvalidDatasetValues ||
      hasInvalidExecutionSetup ||
      (purpose === 'evaluation' &&
        (!hasQualityCriteria ||
          hasInvalidQualityChecks ||
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

  const requestRetryInterruptedTrials = (run: EvaluationRun, jobIds: readonly string[]) => {
    if (!projectAvailable) {
      toast.info('Open this Evaluation project before retrying hosted trials.');
      return;
    }
    const uniqueJobIds = [...new Set(jobIds)];
    if (uniqueJobIds.length === 0 || retryingHostedRunId === run.id) return;
    const trialLabel = `${uniqueJobIds.length} interrupted trial${uniqueJobIds.length === 1 ? '' : 's'}`;
    setConfirmation({
      title: `Retry ${trialLabel}?`,
      description:
        'A worker may have started these trials before it was interrupted. Retrying can repeat model calls, tool calls, external side effects, and cost. Only retry work that is safe to run again.',
      confirmLabel: `Retry ${trialLabel}`,
      onConfirm: () => {
        void (async () => {
          setRetryingHostedRunId(run.id);
          try {
            await retryInterruptedEvaluation({ runId: run.id, jobIds: uniqueJobIds });
          } catch (error) {
            toast.error(
              `Could not retry interrupted trials: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            setRetryingHostedRunId(undefined);
          }
        })();
      },
    });
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

  const renameEvaluationRun = async (runId: string, value: string) => {
    const isLiveRun =
      state.currentRun?.id === runId &&
      (state.currentRun.executionStatus === 'queued' || state.currentRun.executionStatus === 'running');
    const rename = (run: EvaluationRun) => (run.id === runId ? withEvaluationRunName(run, value) : run);

    // A live run has no terminal history record yet. Keep its name in memory
    // until the runner writes the named terminal snapshot. A retained run only
    // updates after its history write succeeds, avoiding an unsaved name that
    // looks durable in the Runs tab.
    if (isLiveRun) {
      setState((current) => ({
        ...current,
        currentRun: current.currentRun ? rename(current.currentRun) : undefined,
        runs: current.runs.map(rename),
      }));
    }

    try {
      const renamed = await runStore.updateRunName({
        projectId: project.metadata.id,
        runId,
        ...(value.trim().length === 0 ? {} : { name: value.trim() }),
      });
      if (renamed === undefined) {
        if (isLiveRun) return;
        throw new Error('This evaluation run is no longer available in local history.');
      }
      if (!isLiveRun) {
        setState((current) => ({
          ...current,
          currentRun: current.currentRun ? rename(current.currentRun) : undefined,
          runs: current.runs.map(rename),
        }));
      }
    } catch (error) {
      toast.error(`Could not save the evaluation run name: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const updateEvaluationRunRecordingRetention = async (run: EvaluationRun, action: 'keep' | 'release') => {
    const now = Date.now();
    const sourceRetention = action === 'keep' ? 'temporary' : 'retained';
    const references = [
      ...new Map(
        getEvaluationRunRecordingReferences(run)
          .filter(
            (reference) =>
              reference.retention === sourceRetention &&
              (action !== 'keep' || reference.expiresAt === undefined || Date.parse(reference.expiresAt) > now),
          )
          .map((reference) => [reference.id, reference]),
      ).values(),
    ];
    if (references.length === 0) {
      toast.info(
        action === 'keep'
          ? 'This run has no unexpired temporary replay recordings to keep.'
          : 'This run has no manually retained replay recordings to release.',
      );
      return;
    }

    const expiresAt = action === 'release' ? new Date(now + 24 * 60 * 60 * 1000).toISOString() : undefined;
    const changedIds = new Set<string>();
    let failure: unknown;
    for (const reference of references) {
      try {
        const updated = await runStore.updateRecordingRetention({
          expiresAt,
          projectId: project.metadata.id,
          recordingId: reference.id,
          retention: action === 'keep' ? 'retained' : 'temporary',
        });
        if (updated) changedIds.add(reference.id);
      } catch (error) {
        failure = error;
        break;
      }
    }

    if (changedIds.size > 0) {
      const update = (candidate: EvaluationRun) =>
        candidate.id === run.id
          ? withEvaluationRunRecordingRetention(
              candidate,
              changedIds,
              action === 'keep' ? 'retained' : 'temporary',
              expiresAt,
            )
          : candidate;
      setState((current) => ({
        ...current,
        currentRun: current.currentRun ? update(current.currentRun) : undefined,
        runs: current.runs.map(update),
      }));
    }
    if (failure !== undefined || changedIds.size !== references.length) {
      const detail =
        failure === undefined
          ? 'One or more recordings expired or were removed before the change could be saved.'
          : failure instanceof Error
            ? failure.message
            : String(failure);
      toast.warn(
        `Only ${changedIds.size} of ${references.length} replay recordings were updated. Refresh Runs before trying again: ${detail}`,
      );
      return;
    }
    toast.success(
      action === 'keep'
        ? `${changedIds.size} replay recording${changedIds.size === 1 ? '' : 's'} will be kept until you release them.`
        : `${changedIds.size} replay recording${changedIds.size === 1 ? '' : 's'} will expire in 24 hours.`,
    );
  };
  const deleteEvaluationRun = async (run: EvaluationRun) => {
    const isLiveRun =
      state.currentRun?.id === run.id &&
      (state.currentRun.executionStatus === 'queued' || state.currentRun.executionStatus === 'running');
    if (isLiveRun) {
      toast.warn('A running evaluation cannot be deleted. Cancel it or wait for it to finish first.');
      return;
    }

    try {
      await runStore.delete({ projectId: project.metadata.id, runId: run.id });
      // A history read started before the delete may still resolve with the
      // removed run. Invalidate it before updating the locally selected list.
      runHistoryReadGeneration.current += 1;
      setRunsStatus('ready');
      setRunsError(undefined);
      setState((current) => {
        const runs = current.runs.filter((candidate) => candidate.id !== run.id);
        const replacement = runs.find((candidate) => candidate.suiteId === run.suiteId);
        return {
          ...current,
          currentRun: current.currentRun?.id === run.id ? undefined : current.currentRun,
          runs,
          selectedRunId: current.selectedRunId === run.id ? replacement?.id : current.selectedRunId,
          runTrialExpansion: current.runTrialExpansion?.runId === run.id ? undefined : current.runTrialExpansion,
        };
      });
    } catch (error) {
      toast.error(`Could not delete the evaluation run: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const requestDeleteEvaluationRun = (run: EvaluationRun) => {
    const isLiveRun =
      state.currentRun?.id === run.id &&
      (state.currentRun.executionStatus === 'queued' || state.currentRun.executionStatus === 'running');
    if (isLiveRun) {
      toast.warn('A running evaluation cannot be deleted. Cancel it or wait for it to finish first.');
      return;
    }
    setConfirmation({
      appearance: 'danger',
      title: 'Delete evaluation run?',
      description: `Delete "${run.name?.trim() || 'Unnamed'}"? This permanently removes its run history and every replay recording for the run, including manually kept and baseline recordings. A compact baseline snapshot remains available for comparison, but its replay recordings will be gone.`,
      confirmLabel: 'Delete run',
      onConfirm: () => void deleteEvaluationRun(run),
    });
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

  const exportSelectedSuite = () => {
    if (!selectedSuite || !suiteDataset) {
      toast.warn('A suite needs an available evaluation dataset before it can be exported.');
      return;
    }
    void io
      .saveString(
        serializeEvaluationSuiteBundleJson(selectedSuite, suiteDataset),
        `${selectedSuite.name || 'evaluation-suite'}.rivet-evaluation-suite.json`,
      )
      .catch((error) =>
        toast.error(`Could not export the evaluation suite: ${error instanceof Error ? error.message : String(error)}`),
      );
  };

  const updateDatasetResource = (dataset: EvaluationDataset) =>
    setState((current) => ({
      ...current,
      datasets: current.datasets.map((item) => (item.id === dataset.id ? dataset : item)),
    }));

  const exportSelectedDatasetJson = () => {
    if (!selectedDataset) return;
    void io
      .saveString(
        serializeEvaluationDatasetJson(selectedDataset),
        `${selectedDataset.name || 'evaluation-dataset'}.evaluation.json`,
      )
      .catch((error) =>
        toast.error(
          `Could not export the evaluation dataset: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  };

  const exportSelectedDatasetCsv = () => {
    if (!selectedDataset) return;
    void io
      .saveString(serializeEvaluationDatasetCsv(selectedDataset), `${selectedDataset.name || 'evaluation-dataset'}.csv`)
      .catch((error) =>
        toast.error(`Could not export the evaluation cases: ${error instanceof Error ? error.message : String(error)}`),
      );
  };

  const importSelectedDataset = () => {
    if (!selectedDataset) return;
    const destination = selectedDataset;
    void io
      .readFileAsString((source, fileName) => {
        try {
          updateDatasetResource(
            /\.csv$/iu.test(fileName)
              ? replaceEvaluationDatasetCasesFromCsv(destination, source)
              : deserializeEvaluationDatasetJson(source, { id: destination.id }),
          );
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
    <div css={styles}>
      <EvaluationSuiteSidebar
        canCreateDataset
        canCreateSuite={projectAvailable && graphOptions.length > 0}
        datasets={localDatasets}
        getDatasetUsage={(dataset) => {
          const usage = state.data.suites.filter((suite) => suite.datasetId === dataset.id).length;
          return `${usage} evaluation suite${usage === 1 ? '' : 's'}`;
        }}
        selectedSuiteId={showingDataset ? undefined : selectedSuite?.id}
        selectedDatasetId={showingDataset ? selectedDataset?.id : undefined}
        suites={state.data.suites}
        getGraphName={(suite) =>
          projectAvailable
            ? project.graphs[suite.targetGraphId]?.metadata?.name ?? 'Missing target graph'
            : 'Open a project to resolve graph'
        }
        getReferenceStatus={(suite) => getEvaluationSuiteReferenceStatus(suite, project, state.datasets)}
        onCreateDataset={createDatasetResource}
        onCreateSuite={() => setCreateSuiteOpen(true)}
        onDeleteDataset={requestDeleteDataset}
        onDeleteSuite={requestDeleteSuite}
        onImportDataset={importDatasetResource}
        onImportSuite={importSuiteResource}
        onSelectDataset={selectDataset}
        onSelectSuite={selectSuite}
        runningSuiteId={state.runningSuiteId}
      />
      <main
        className="evaluation-main"
        ref={evaluationMainRef}
        onScroll={(event) => {
          if (view === 'runs' && runHistoryScopeKey) runScrollTopRef.current = event.currentTarget.scrollTop;
        }}
      >
        {showingDataset ? (
          <>
            <header className="evaluation-suite-header evaluation-dataset-header">
              <div className="evaluation-suite-title-row">
                <ResourceTitle
                  editing={renamingDatasetId === selectedDataset.id}
                  fallback="Untitled evaluation dataset"
                  label="evaluation dataset"
                  value={selectedDataset.name}
                  onStartEditing={() => setRenamingDatasetId(selectedDataset.id)}
                  onFinishEditing={() => setRenamingDatasetId(undefined)}
                  onCommit={(name) => updateDatasetResource({ ...selectedDataset, name })}
                />
                <div className="spacer" />
                <div className="evaluation-run-actions evaluation-dataset-transfer-actions">
                  <Button
                    appearance="subtle"
                    className="evaluation-secondary-action"
                    onClick={exportSelectedDatasetJson}
                  >
                    Export JSON
                  </Button>
                  <Button
                    appearance="subtle"
                    className="evaluation-secondary-action"
                    onClick={exportSelectedDatasetCsv}
                  >
                    Export CSV
                  </Button>
                  <Button appearance="subtle" className="evaluation-secondary-action" onClick={importSelectedDataset}>
                    Import (replace)
                  </Button>
                </div>
              </div>
              <p className="evaluation-suite-subtitle">
                Evaluation dataset ·{' '}
                <button
                  aria-controls="evaluation-dataset-usage-disclosure"
                  aria-expanded={datasetUsageExpanded}
                  className="evaluation-dataset-usage-toggle"
                  type="button"
                  onClick={() => setDatasetUsageExpanded((expanded) => !expanded)}
                >
                  Used by {selectedDatasetSuites.length} evaluation suite
                  {selectedDatasetSuites.length === 1 ? '' : 's'}
                </button>
              </p>
              {datasetUsageExpanded ? (
                <div className="evaluation-dataset-usage-disclosure" id="evaluation-dataset-usage-disclosure">
                  <strong>Used by evaluation suites</strong>
                  {selectedDatasetSuites.length === 0 ? (
                    <span>This dataset is not assigned to a suite yet.</span>
                  ) : (
                    <div>
                      {selectedDatasetSuites.map((suite) => (
                        <Button
                          appearance="subtle"
                          className="evaluation-secondary-action"
                          key={suite.id}
                          onClick={() => selectSuite(suite.id)}
                        >
                          {suite.name || 'Untitled evaluation suite'}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </header>
            <div className="evaluation-panel">
              <Dataset
                dataset={selectedDataset}
                onAddCase={() => addCase(selectedDataset)}
                onInvalidDraftChange={setHasInvalidDatasetDraft}
                onRemoveField={(fieldId) => requestRemoveDatasetField(selectedDataset.id, fieldId)}
                onUpdate={updateDatasetResource}
              />
            </div>
          </>
        ) : !selectedSuite ? (
          <div className="workspace-empty">
            <div className="workspace-empty-content">
              <h1>
                {state.data.suites.length === 0 && localDatasets.length === 0
                  ? 'Create an evaluation suite or dataset'
                  : 'Select an evaluation suite or dataset'}
              </h1>
              <p>
                {state.data.suites.length === 0 && localDatasets.length === 0
                  ? !projectAvailable
                    ? 'Create or import reusable datasets here, or import a suite. Open a project when you are ready to create, bind, and run a suite.'
                    : graphOptions.length === 0
                      ? 'Create an evaluation dataset now, then create a graph before adding a suite that runs it.'
                      : 'Create a suite for a graph, or create a reusable dataset first.'
                  : 'Suites run graphs against datasets. Select either resource from the left to edit it.'}
              </p>
              <div className="workspace-empty-actions">
                {projectAvailable && graphOptions.length > 0 ? (
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
            <EvaluationSuiteRunStatus
              warnings={suiteWideWarnings}
              targetExecutionLabel={targetExecutionLabel}
              isRunning={state.runningSuiteId === selectedSuite.id}
              showBenchmark={!hasQualityCriteria}
              benchmarkDisabled={benchmarkDisabled}
              evaluationDisabled={evaluationDisabled}
              exportDisabled={!suiteDataset}
              benchmarkTitle={`Runs ${targetExecutionLabel} and measures execution without producing a quality result.`}
              evaluationTitle={evaluationDisabledTitle}
              exportTitle={
                suiteDataset ? 'Export this suite and its evaluation dataset' : 'Repair the dataset reference first'
              }
              onExport={exportSelectedSuite}
              onRunBenchmark={() => startEvaluation('execution-benchmark')}
              onRunEvaluation={() => startEvaluation('evaluation')}
              onCancel={abortEvaluation}
            />
            <header className="evaluation-suite-header evaluation-suite-header-with-sticky-status">
              <div className="evaluation-suite-title-row">
                <ResourceTitle
                  editing={renamingSuiteId === selectedSuite.id}
                  fallback="Untitled evaluation suite"
                  label="evaluation suite"
                  value={selectedSuite.name}
                  onStartEditing={() => setRenamingSuiteId(selectedSuite.id)}
                  onFinishEditing={() => setRenamingSuiteId(undefined)}
                  onCommit={(name) => updateSuite((suite) => ({ ...suite, name }))}
                />
                <div className="spacer" />
                <Button
                  appearance="subtle"
                  className="evaluation-secondary-action evaluation-suite-header-export"
                  isDisabled={!suiteDataset}
                  title={
                    suiteDataset ? 'Export this suite and its evaluation dataset' : 'Repair the dataset reference first'
                  }
                  onClick={exportSelectedSuite}
                >
                  Export suite + dataset
                </Button>
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
                  datasets={localDatasets}
                  graphOptions={graphOptions}
                  targetInputs={targetInputs}
                  targetOutputs={targetOutputs}
                  targetGraphExists={referenceStatus?.targetGraphExists === true}
                  selectedDefinitionTab={suitePresentation.definitionView}
                  showAdditionalExecutionSettings={suitePresentation.additionalExecutionSettingsExpanded}
                  onUpdate={updateSuite}
                  onAssignDataset={assignSuiteDataset}
                  onAssignTargetGraph={assignTargetGraph}
                  onSelectedDefinitionTabChange={(definitionView) =>
                    updateSelectedSuitePresentation({ definitionView })
                  }
                  onShowAdditionalExecutionSettingsChange={(additionalExecutionSettingsExpanded) =>
                    updateSelectedSuitePresentation({ additionalExecutionSettingsExpanded })
                  }
                />
              )}
              {view === 'runs' && (
                <Runs
                  dataset={suiteDataset}
                  runs={suiteRuns}
                  currentRun={suiteCurrentRun}
                  selectedRunId={state.selectedRunId}
                  scoreSort={runScoreSort}
                  status={visibleRunsStatus}
                  error={visibleRunsStatus === 'error' ? runsError : undefined}
                  refreshError={runHistoryRefreshError}
                  expandedTrialExpansion={visibleRunTrialExpansion}
                  retryingHostedRunId={retryingHostedRunId}
                  onRetryInterrupted={requestRetryInterruptedTrials}
                  onSelect={selectRun}
                  onScoreSortChange={updateRunScoreSort}
                  onExpandedTrialsChange={updateExpandedTrials}
                  onRename={(runId, name) => void renameEvaluationRun(runId, name)}
                  onDelete={requestDeleteEvaluationRun}
                  onKeepRecordings={(run) => void updateEvaluationRunRecordingRetention(run, 'keep')}
                  onReleaseRecordings={(run) => void updateEvaluationRunRecordingRetention(run, 'release')}
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
        datasets={localDatasets}
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
  selectedDefinitionTab: EvaluationDefinitionTabId;
  showAdditionalExecutionSettings: boolean;
  onUpdate: (update: (suite: EvaluationSuite) => EvaluationSuite) => void;
  onAssignDataset: (datasetId: string) => void;
  onAssignTargetGraph: (graphId: string) => void;
  onSelectedDefinitionTabChange: (tab: EvaluationDefinitionTabId) => void;
  onShowAdditionalExecutionSettingsChange: (expanded: boolean) => void;
}> = ({
  suite,
  project,
  dataset,
  datasets,
  graphOptions,
  targetInputs,
  targetOutputs,
  targetGraphExists,
  selectedDefinitionTab,
  showAdditionalExecutionSettings,
  onUpdate,
  onAssignDataset,
  onAssignTargetGraph,
  onSelectedDefinitionTabChange,
  onShowAdditionalExecutionSettingsChange,
}) => {
  const isScoringSuite = getEvaluationSuiteMode(suite) === 'scoring';
  const [renamingAssertionId, setRenamingAssertionId] = useState<string>();
  const [renamingEvaluatorId, setRenamingEvaluatorId] = useState<string>();
  const definitionTabs: readonly EvaluationDefinitionTab[] = isScoringSuite
    ? [{ id: 'evaluator-graphs', label: 'Custom evaluator graphs', count: suite.evaluators.length }]
    : [
        { id: 'deterministic-checks', label: 'Deterministic checks', count: suite.assertions.length },
        { id: 'thresholds', label: 'Thresholds', count: suite.thresholds?.length ?? 0 },
        { id: 'evaluator-graphs', label: 'Custom evaluator graphs', count: suite.evaluators.length },
      ];
  const activeDefinitionTab = isScoringSuite ? 'evaluator-graphs' : selectedDefinitionTab;
  const expectedDatasetFields = dataset?.fields.filter((field) => field.role === 'expected') ?? [];
  const unusedExpectedFields = getUnusedExpectedFields(expectedDatasetFields, suite.assertions);
  const inputBindingIssues = dataset ? getEvaluationInputBindingAuthoringIssues(suite, dataset, targetInputs) : [];
  const expectedValueIssues = dataset ? getEvaluationExpectedValueAuthoringIssues(suite, dataset) : [];
  const executionConfigurationIssues = getEvaluationExecutionConfigurationAuthoringIssues(suite, targetInputs);
  useEffect(() => {
    if (executionConfigurationIssues.length > 0 && !showAdditionalExecutionSettings) {
      onShowAdditionalExecutionSettingsChange(true);
    }
  }, [executionConfigurationIssues.length, onShowAdditionalExecutionSettingsChange, showAdditionalExecutionSettings]);
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
        <h2>Dataset and target</h2>
        <p className="muted">
          Select the graph being evaluated, then map each of its inputs from the evaluation dataset.
        </p>
        <div className="evaluation-form-grid evaluation-target-graph">
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
          <EvaluationFormField label="Target graph to evaluate">
            <Select
              options={graphOptions}
              value={graphOptions.find((option) => option.value === suite.targetGraphId)}
              placeholder="Select target graph"
              onChange={(value) => value && onAssignTargetGraph(value.value)}
            />
          </EvaluationFormField>
        </div>
        {!targetGraphExists ? null : dataset ? (
          <>
            {targetInputs.length === 0 ? (
              <p className="empty">The target graph has no graph inputs.</p>
            ) : (
              <table className="table evaluation-binding-table evaluation-target-binding-table">
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
                      .filter(
                        (field) =>
                          field.role === 'input' &&
                          areEvaluationDataTypesCompatible(field.dataType, input.data.dataType),
                      )
                      .map((field) => ({ label: `${field.name} (${field.dataType})`, value: field.id }));
                    return (
                      <tr key={input.id}>
                        <td>{`${graphInputId} (${input.data.dataType})`}</td>
                        <td>
                          <Select
                            isClearable
                            options={options}
                            value={options.find((option) => option.value === current)}
                            placeholder={
                              hasStaticGraphInputDefault(input)
                                ? 'Uses graph default'
                                : options.length === 0
                                  ? 'No compatible graph-input fields'
                                  : 'Select dataset field'
                            }
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
          </>
        ) : null}
      </section>
      <section className="section evaluation-mode-section">
        <div className="evaluation-form-grid evaluation-target-graph">
          <h2>Quality check</h2>
          <EvaluationFormField
            label="Check type"
            description="Pass/fail uses assertions. Scoring averages evaluator scores across trials."
          >
            <SegmentedEditor
              ariaLabel="Evaluation type"
              isDisabled={false}
              isReadonly={false}
              label=""
              allowOptionWrap={false}
              options={[
                { label: 'Pass/fail', value: 'pass-fail' },
                { label: 'Scoring', value: 'scoring' },
              ]}
              value={getEvaluationSuiteMode(suite)}
              onChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  evaluationMode: value as 'pass-fail' | 'scoring',
                }))
              }
            />
          </EvaluationFormField>
        </div>
        <EvaluationDefinitionTabs
          activeTab={activeDefinitionTab}
          tabs={definitionTabs}
          onSelect={onSelectedDefinitionTabChange}
        />
      </section>
      {!dataset || !targetGraphExists ? null : (
        <>
          {activeDefinitionTab === 'deterministic-checks' && !isScoringSuite ? (
            <section
              className="section evaluation-quality-section"
              role="tabpanel"
              id="evaluation-definition-panel-deterministic-checks"
              aria-labelledby="evaluation-definition-tab-deterministic-checks"
            >
              <p className="muted">
                Quality checks decide whether completed graph outputs meet your requirements. Deterministic check
                reference fields do not judge a run until a check or evaluator input binding uses them. Evaluator graphs
                can receive individual dataset fields, target outputs, or complete evaluation-context objects.
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
              <p className="muted">
                Compare a target output with a fixed JSON value or a different expected value from each dataset case.
              </p>
              <div className="evaluation-editor-list">
                {suite.assertions.map((assertion) => {
                  const expectedFields = expectedDatasetFields.map((field) => ({
                    label: field.name,
                    value: field.id,
                  }));
                  const sourceOptions = [
                    { label: 'Literal JSON', value: 'literal' },
                    ...(expectedFields.length > 0
                      ? [{ label: 'Dataset field of "Deterministic check reference" type', value: 'dataset-field' }]
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
                  const expectedFieldIssue =
                    expected.kind === 'dataset-field' &&
                    (authoringIssue?.code === 'missing-expected-field' ||
                      authoringIssue?.code === 'incompatible-expected-value')
                      ? authoringIssue
                      : undefined;
                  const remainingAuthoringIssue = expectedFieldIssue === undefined ? authoringIssue : undefined;
                  return (
                    <div className="evaluation-editor-card" key={assertion.id}>
                      <ResourceTitle
                        className="evaluation-assertion-title"
                        editing={renamingAssertionId === assertion.id}
                        fallback="Untitled quality check"
                        headingLevel="h4"
                        label="quality check"
                        value={assertion.name}
                        onStartEditing={() => setRenamingAssertionId(assertion.id)}
                        onFinishEditing={() => setRenamingAssertionId(undefined)}
                        onCommit={(name) =>
                          onUpdate((current) => ({
                            ...current,
                            assertions: current.assertions.map((item) =>
                              item.id === assertion.id ? { ...item, name } : item,
                            ),
                          }))
                        }
                      />
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
                        <EvaluationFormField className="field wide" label="Dataset field">
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
                      {expectedFieldIssue ? (
                        <p className="warning field full" role="alert">
                          {expectedFieldIssue.message}
                        </p>
                      ) : null}
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
                      {remainingAuthoringIssue ? (
                        <p className="warning field full" role="alert">
                          {remainingAuthoringIssue.message}
                        </p>
                      ) : null}
                      <div className="evaluation-editor-card-actions">
                        <div className="evaluation-checkboxes">
                          <LabeledToggle
                            id={`evaluation-assertion-required-${assertion.id}`}
                            isChecked={assertion.required !== false}
                            label="Required"
                            onChange={(required) =>
                              onUpdate((current) => ({
                                ...current,
                                assertions: current.assertions.map((item) =>
                                  item.id === assertion.id ? { ...item, required } : item,
                                ),
                              }))
                            }
                          />
                        </div>
                      </div>
                      <RemoveButton
                        className="evaluation-editor-card-remove"
                        label="Remove quality check"
                        onClick={() =>
                          onUpdate((current) => ({
                            ...current,
                            assertions: current.assertions.filter((item) => item.id !== assertion.id),
                          }))
                        }
                      />
                    </div>
                  );
                })}
              </div>
              <div className="evaluation-section-actions">
                <Button appearance="primary" isDisabled={targetOutputs.length === 0} onClick={() => addAssertion()}>
                  + Add quality check
                </Button>
              </div>
            </section>
          ) : null}
          {activeDefinitionTab === 'evaluator-graphs' ? (
            <section
              className="section"
              role="tabpanel"
              id="evaluation-definition-panel-evaluator-graphs"
              aria-labelledby="evaluation-definition-tab-evaluator-graphs"
            >
              <p className="muted">
                {isScoringSuite ? (
                  <>
                    <p>
                      An evaluator graph is supposed to judge the already-computed target graph output. Map evaluator
                      graph inputs from target outputs, dataset fields, or evaluation context.
                    </p>
                    <p>
                      The graph output must be named <code>result</code> and return{' '}
                      <code>{'{ score: scoreOutOf100, message?, evidence?, metrics? }'}</code>. For example, return{' '}
                      <code>{'{ score: 85 }'}</code> for 85/100.
                    </p>
                    <p>
                      Rivet averages evaluator scores within each trial, averages the N trials for each case, then gives
                      each case equal weight in the overall score.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      Ordinary Rivet graphs return a <code>result</code> object for custom checks and LLM judges.
                      Required evaluator errors make the run unable to evaluate; they never become a false quality pass.
                    </p>
                  </>
                )}
              </p>
              <div className="evaluation-editor-list">
                {suite.evaluators.map((evaluator) => {
                  const evaluatorIssue = getEvaluationEvaluatorAuthoringIssue(evaluator, project, suite, dataset);
                  const evaluatorGraphIssue =
                    evaluatorIssue?.startsWith('Choose an existing evaluator graph.') ||
                    evaluatorIssue?.startsWith('Evaluator graph must declare') ||
                    evaluatorIssue?.startsWith('Evaluator graph output “result”') ||
                    evaluatorIssue?.startsWith('Evaluator graph has duplicate Graph Input ids.')
                      ? evaluatorIssue
                      : undefined;
                  const evaluatorWeightIssue = evaluatorIssue?.startsWith('Score weight must')
                    ? evaluatorIssue
                    : undefined;
                  const evaluatorBindingIssue =
                    evaluatorGraphIssue === undefined && evaluatorWeightIssue === undefined
                      ? evaluatorIssue
                      : undefined;
                  const evaluatorGraphInputs =
                    project.graphs[evaluator.graphId]?.nodes.filter(
                      (node): node is GraphInputNode => node.type === 'graphInput',
                    ) ?? [];
                  const usesLegacyInputs = usesLegacyEvaluatorInputEnvelope(
                    evaluator,
                    evaluatorGraphInputs.map((input) => input.data.id),
                  );
                  return (
                    <div className="evaluation-editor-card" key={evaluator.id}>
                      <ResourceTitle
                        className="evaluation-evaluator-title"
                        editing={renamingEvaluatorId === evaluator.id}
                        fallback="Untitled evaluator"
                        headingLevel="h4"
                        label="evaluator"
                        value={evaluator.name}
                        onStartEditing={() => setRenamingEvaluatorId(evaluator.id)}
                        onFinishEditing={() => setRenamingEvaluatorId(undefined)}
                        onCommit={(name) =>
                          onUpdate((current) => ({
                            ...current,
                            evaluators: current.evaluators.map((item) =>
                              item.id === evaluator.id ? { ...item, name } : item,
                            ),
                          }))
                        }
                      />
                      {!isScoringSuite ? (
                        <div className="evaluation-evaluator-required">
                          <LabeledToggle
                            id={`evaluation-evaluator-required-${evaluator.id}`}
                            isChecked={evaluator.required !== false}
                            label="Required"
                            onChange={(required) =>
                              onUpdate((current) => ({
                                ...current,
                                evaluators: current.evaluators.map((item) =>
                                  item.id === evaluator.id ? { ...item, required } : item,
                                ),
                              }))
                            }
                          />
                        </div>
                      ) : null}
                      <EvaluationFormField className="field evaluation-evaluator-graph" label="Evaluator graph">
                        <Select
                          options={graphOptions}
                          value={graphOptions.find((item) => item.value === evaluator.graphId)}
                          onChange={(value) =>
                            onUpdate((current) => ({
                              ...current,
                              evaluators: current.evaluators.map((item) =>
                                item.id === evaluator.id
                                  ? { ...item, graphId: value!.value as typeof item.graphId, inputBindings: [] }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </EvaluationFormField>
                      {evaluatorGraphIssue ? (
                        <p className="warning field full" role="alert">
                          {evaluatorGraphIssue}
                        </p>
                      ) : null}
                      <div className="field full">
                        {usesLegacyInputs ? (
                          <p className="muted">
                            This existing evaluator uses the legacy automatic context inputs:{' '}
                            <code>{LEGACY_EVALUATOR_INPUT_IDS.join(', ')}</code>. New evaluator graphs can use ordinary
                            Graph Input names and map them directly below.
                          </p>
                        ) : evaluatorGraphInputs.length === 0 ? (
                          <p className="muted">This evaluator graph has no Graph Inputs to bind.</p>
                        ) : (
                          <table className="table evaluation-binding-table evaluation-evaluator-binding-table">
                            <thead>
                              <tr>
                                <th>Evaluator graph input</th>
                                <th>Value source</th>
                              </tr>
                            </thead>
                            <tbody>
                              {evaluatorGraphInputs.map((evaluatorInput) => {
                                const targetOutputSourceOptions: Array<{
                                  label: string;
                                  value: string;
                                  source: EvaluationEvaluatorInputSource;
                                }> = targetOutputs
                                  .filter((output) =>
                                    areEvaluationDataTypesCompatible(output.dataType, evaluatorInput.data.dataType),
                                  )
                                  .map((output) => {
                                    const source = { kind: 'target-output' as const, outputId: output.id };
                                    return {
                                      label: `${output.id} (${output.dataType})`,
                                      value: evaluatorInputSourceKey(source),
                                      source,
                                    };
                                  });
                                const datasetFieldSourceOptions: typeof targetOutputSourceOptions = dataset.fields
                                  .filter((field) =>
                                    areEvaluationDataTypesCompatible(field.dataType, evaluatorInput.data.dataType),
                                  )
                                  .map((field) => {
                                    const source = { kind: 'dataset-field' as const, fieldId: field.id };
                                    return {
                                      label: `${field.name} (${field.dataType}, ${field.role})`,
                                      value: evaluatorInputSourceKey(source),
                                      source,
                                    };
                                  });
                                const evaluationContextSourceOptions: typeof targetOutputSourceOptions =
                                  evaluatorInput.data.dataType === 'object' || evaluatorInput.data.dataType === 'any'
                                    ? LEGACY_EVALUATOR_INPUT_IDS.map((context) => {
                                        const source = { kind: 'context' as const, context };
                                        return {
                                          label: evaluatorContextLabels[context],
                                          value: evaluatorInputSourceKey(source),
                                          source,
                                        };
                                      })
                                    : [];
                                const sourceOptions = [
                                  ...targetOutputSourceOptions,
                                  ...datasetFieldSourceOptions,
                                  ...evaluationContextSourceOptions,
                                ];
                                const sourceOptionGroups = [
                                  ...(targetOutputSourceOptions.length > 0
                                    ? [{ label: 'Target outputs', options: targetOutputSourceOptions }]
                                    : []),
                                  ...(datasetFieldSourceOptions.length > 0
                                    ? [{ label: 'Dataset fields', options: datasetFieldSourceOptions }]
                                    : []),
                                  ...(evaluationContextSourceOptions.length > 0
                                    ? [{ label: 'Evaluation context', options: evaluationContextSourceOptions }]
                                    : []),
                                ];
                                const binding = evaluator.inputBindings?.find(
                                  (candidate) => candidate.graphInputId === evaluatorInput.data.id,
                                );
                                return (
                                  <tr key={evaluatorInput.id}>
                                    <td>{`${evaluatorInput.data.id} (${evaluatorInput.data.dataType})`}</td>
                                    <td>
                                      <Select
                                        isClearable
                                        options={sourceOptionGroups}
                                        styles={{
                                          groupHeading: (base) => ({
                                            ...base,
                                            margin: '6px 8px 4px',
                                            padding: '0 0 4px',
                                            borderBottom: '1px solid var(--grey-darkish)',
                                            color: 'var(--grey-light)',
                                            fontWeight: 600,
                                          }),
                                        }}
                                        value={sourceOptions.find(
                                          (option) =>
                                            binding !== undefined &&
                                            option.value === evaluatorInputSourceKey(binding.source),
                                        )}
                                        placeholder={
                                          hasStaticGraphInputDefault(evaluatorInput)
                                            ? 'Uses graph default'
                                            : sourceOptions.length === 0
                                              ? 'No compatible value sources'
                                              : 'Select value source'
                                        }
                                        onChange={(value) => {
                                          const source = sourceOptions.find(
                                            (option) => option.value === value?.value,
                                          )?.source;
                                          onUpdate((current) => ({
                                            ...current,
                                            evaluators: current.evaluators.map((item) =>
                                              item.id === evaluator.id
                                                ? {
                                                    ...item,
                                                    inputBindings: [
                                                      ...(item.inputBindings ?? []).filter(
                                                        (candidate) =>
                                                          candidate.graphInputId !== evaluatorInput.data.id,
                                                      ),
                                                      ...(source
                                                        ? [{ graphInputId: evaluatorInput.data.id, source }]
                                                        : []),
                                                    ],
                                                  }
                                                : item,
                                            ),
                                          }));
                                        }}
                                      />
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                      {evaluatorBindingIssue ? (
                        <p className="warning field full" role="alert">
                          {evaluatorBindingIssue}
                        </p>
                      ) : null}
                      <EvaluationFormField
                        className="field"
                        label="Relative score weight"
                        description="Influence when combining evaluator scores. Weight 2 counts twice as much as weight 1; with one evaluator it has no effect. Defaults to 1."
                      >
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
                      {evaluatorWeightIssue ? (
                        <p className="warning field full" role="alert">
                          {evaluatorWeightIssue}
                        </p>
                      ) : null}
                      {!isScoringSuite ? (
                        <div className="evaluation-evaluator-run-on-error">
                          <LabeledToggle
                            id={`evaluation-evaluator-run-on-target-error-${evaluator.id}`}
                            isChecked={evaluator.runOnTargetError === true}
                            label="Run after target error"
                            onChange={(runOnTargetError) =>
                              onUpdate((current) => ({
                                ...current,
                                evaluators: current.evaluators.map((item) =>
                                  item.id === evaluator.id ? { ...item, runOnTargetError } : item,
                                ),
                              }))
                            }
                          />
                        </div>
                      ) : null}
                      <RemoveButton
                        className="evaluation-editor-card-remove"
                        label="Remove evaluator"
                        onClick={() =>
                          onUpdate((current) => ({
                            ...current,
                            evaluators: current.evaluators.filter((item) => item.id !== evaluator.id),
                          }))
                        }
                      />
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
                          inputBindings: [],
                          required: true,
                        },
                      ],
                    }))
                  }
                >
                  + Add evaluator graph
                </Button>
              </div>
            </section>
          ) : null}
          {activeDefinitionTab === 'thresholds' && !isScoringSuite ? (
            <Thresholds
              suite={suite}
              thresholds={suite.thresholds ?? []}
              onUpdate={(thresholds) => onUpdate((current) => ({ ...current, thresholds }))}
            />
          ) : null}
          <section className="section">
            <h2>Execution settings</h2>
            <div className="evaluation-execution-primary-grid">
              <EvaluationFormField label="Trials per enabled case" description={isScoringSuite ? '' : ''}>
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
              <EvaluationFormField label="Parallel graph runs concurrency (1–32)" description="">
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
            </div>
            <div className="evaluation-execution-explanation">
              <p className="muted">Each run executes cases × trials. Concurrency is bounded to 32.</p>
              <p className="muted">
                Successful recordings are temporary for 24 hours unless you choose to keep every recording. Failed and
                baseline recordings are retained.
              </p>
            </div>
            {!showAdditionalExecutionSettings ? (
              <Button
                appearance="subtle"
                className="evaluation-additional-settings-button"
                aria-expanded={false}
                onClick={() => onShowAdditionalExecutionSettingsChange(true)}
              >
                Additional settings
              </Button>
            ) : (
              <div className="evaluation-additional-execution-settings">
                <div className="evaluation-additional-execution-settings-header">
                  <h3>Additional settings</h3>
                  <button
                    type="button"
                    className="evaluation-additional-settings-close"
                    aria-label="Close additional settings"
                    title="Close additional settings"
                    onClick={() => onShowAdditionalExecutionSettingsChange(false)}
                  >
                    <CrossIcon aria-hidden="true" />
                  </button>
                </div>
                <div className="evaluation-additional-execution-settings-fields">
                  <EvaluationFormField
                    label="Per-graph timeout, sec"
                    description="Seconds allowed for each target or evaluator graph."
                    descriptionPlacement="after-label"
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
                  <EvaluationFormField label="Recording retention">
                    <Select
                      options={[
                        { label: 'Keep failed and baseline recordings', value: 'failures-and-baselines' },
                        { label: 'Keep every recording', value: 'all' },
                      ]}
                      value={[
                        { label: 'Keep failed and baseline recordings', value: 'failures-and-baselines' },
                        { label: 'Keep every recording', value: 'all' },
                      ].find(
                        (option) =>
                          option.value === (suite.configuration?.recordingRetention ?? 'failures-and-baselines'),
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
                  <EvaluationFormField label="Target graph seed">
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
                    label="Seed target graph input"
                    description="Numeric Graph Input that receives each derived seed."
                    descriptionPlacement="after-label"
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
              </div>
            )}
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
    <section
      className="section"
      role="tabpanel"
      id="evaluation-definition-panel-thresholds"
      aria-labelledby="evaluation-definition-tab-thresholds"
    >
      <p className="muted">
        Thresholds judge aggregate run metrics and affect the quality result and CLI exit code. If a required metric is
        unavailable or a regression threshold has no compatible baseline, Rivet reports that it is unable to evaluate
        the requirement instead of showing a false pass. Custom evaluator metrics are the numeric keys returned in an
        evaluator result’s <code>metrics</code> object.
      </p>
      <div className="evaluation-editor-list">
        {thresholds.map((threshold) => {
          const customMetric = threshold.metric.startsWith('custom:');
          const usesPercentageValue = thresholdUsesPercentageValue(threshold.metric, threshold.operator);
          const isBoundedPercentage = percentageThresholdMetrics.has(threshold.metric);
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
                label={usesPercentageValue ? 'Threshold percentage' : 'Threshold value'}
                description={
                  threshold.operator === 'max-regression'
                    ? 'Enter a percentage: 10 allows a 10% regression.'
                    : isBoundedPercentage
                      ? 'Enter a percentage from 0 to 100.'
                      : threshold.metric === 'average-cost' || threshold.metric === 'total-cost'
                        ? 'US dollars.'
                        : isLatencyThresholdMetric(threshold.metric)
                          ? 'Seconds.'
                          : undefined
                }
              >
                <Textfield
                  type="number"
                  min={usesPercentageValue ? 0 : undefined}
                  max={isBoundedPercentage ? 100 : undefined}
                  step={usesPercentageValue || isLatencyThresholdMetric(threshold.metric) ? 0.1 : undefined}
                  value={
                    usesPercentageValue
                      ? formatPercentageThresholdValue(threshold.value)
                      : isLatencyThresholdMetric(threshold.metric)
                        ? String(Number((threshold.value / 1_000).toFixed(4)))
                        : String(threshold.value)
                  }
                  onChange={(event) =>
                    updateThreshold(
                      threshold.id,
                      (current) =>
                        ({
                          ...current,
                          value:
                            (Number(event.currentTarget.value) || 0) *
                            (thresholdUsesPercentageValue(current.metric, current.operator)
                              ? 0.01
                              : isLatencyThresholdMetric(current.metric)
                                ? 1_000
                                : 1),
                        }) as EvaluationThreshold,
                    )
                  }
                />
              </EvaluationFormField>
              {thresholdIssue ? (
                <p className="warning field full" role="alert">
                  {thresholdIssue}
                </p>
              ) : null}
              <RemoveButton
                className="evaluation-editor-card-remove"
                label="Remove threshold"
                onClick={() => onUpdate(thresholds.filter((item) => item.id !== threshold.id))}
              />
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
          + Add threshold
        </Button>
      </div>
    </section>
  );
};

const Dataset: FC<{
  dataset?: EvaluationDataset;
  onAddCase: () => void;
  onInvalidDraftChange: (invalid: boolean) => void;
  onRemoveField: (fieldId: string) => void;
  onUpdate: (dataset: EvaluationDataset) => void;
}> = ({ dataset, onAddCase, onInvalidDraftChange, onRemoveField, onUpdate }) => {
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

  const caseGridTemplate = getEvaluationCaseGridTemplate(dataset.fields);
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
  return (
    <>
      <section className="section">
        <div className="evaluation-dataset-intro" role="note">
          Evaluation datasets are reusable local Rivet resources. Graph input fields feed a suite’s target graph.
          Deterministic check reference fields provide values for visible quality checks; they do not judge a run on
          their own. Metadata travels only to evaluator graphs. JSON is lossless; CSV imports and exports typed JSON
          cell values against the current field definitions.
        </div>
      </section>
      <section className="section">
        <h3>Fields</h3>
        <table className="table evaluation-fields-table">
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
                <td className="evaluation-toggle-cell">
                  <ScalableToggle
                    aria-label={`${field.name} required`}
                    isChecked={field.required === true}
                    onChange={(event) => updateField(field.id, { required: event.currentTarget.checked })}
                  />
                </td>
                <td>
                  <RemoveButton label={`Remove ${field.name || 'field'}`} onClick={() => onRemoveField(field.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="evaluation-section-actions">
          <Button appearance="primary" onClick={addField}>
            + Add field
          </Button>
        </div>
      </section>
      <section className="section evaluation-dataset-table-section">
        <h3>Cases</h3>
        {dataset.cases.length > 0 ? (
          <div className="evaluation-cases">
            <div className="evaluation-case-header-row" style={{ gridTemplateColumns: caseGridTemplate }}>
              <span>Enabled</span>
              <span>Case</span>
              <span>Tags</span>
              <span>Notes</span>
              {dataset.fields.map((field) => (
                <div className="evaluation-case-field-heading" id={`evaluation-case-field-${field.id}`} key={field.id}>
                  <strong>
                    {field.name} <span className="evaluation-case-field-type">({field.dataType})</span>
                  </strong>
                </div>
              ))}
              <span />
            </div>
            {dataset.cases.map((testCase) => (
              <div className="evaluation-case-row" style={{ gridTemplateColumns: caseGridTemplate }} key={testCase.id}>
                <div className="evaluation-case-enabled-control">
                  <ScalableToggle
                    aria-label={`${testCase.name} enabled`}
                    isChecked={testCase.enabled !== false}
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
                </div>
                <div className="evaluation-case-name-control">
                  <Textfield
                    aria-label={`${testCase.name} name`}
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
                </div>
                <div className="evaluation-case-tags-control">
                  <Textfield
                    aria-label={`${testCase.name} tags`}
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
                </div>
                <div className="evaluation-case-notes-control">
                  <Textfield
                    aria-label={`${testCase.name} notes`}
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
                </div>
                {dataset.fields.map((field) => (
                  <div
                    className="evaluation-case-value-field"
                    role="group"
                    aria-labelledby={`evaluation-case-field-${field.id}`}
                    key={field.id}
                  >
                    <DatasetValueEditor
                      dataType={field.dataType}
                      value={testCase.values[field.id]}
                      onCommit={(value) => onUpdate(updateDatasetCaseValue(dataset, testCase.id, field.id, value))}
                      onValidityChange={(invalid) => setCellInvalid(`${testCase.id}:${field.id}`, invalid)}
                    />
                  </div>
                ))}
                <div className="evaluation-case-actions">
                  <RemoveButton
                    label={`Remove ${testCase.name || 'case'}`}
                    onClick={() =>
                      onUpdate({
                        ...dataset,
                        cases: dataset.cases.filter((candidate) => candidate.id !== testCase.id),
                      })
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">No cases yet. Add a case and give every bound input a portable JSON value.</p>
        )}
        <div className="evaluation-section-actions">
          <Button appearance="primary" onClick={onAddCase}>
            + Add case
          </Button>
        </div>
      </section>
    </>
  );
};

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

const Runs: FC<{
  dataset?: EvaluationDataset;
  runs: EvaluationRun[];
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
    () => liveRun ?? selectedRunSnapshot ?? currentRun ?? runs[0],
    [currentRun, liveRun, runs, selectedRunSnapshot],
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
    () => runs.map((candidate) => ({ label: formatEvaluationRunOptionLabel(candidate), value: candidate.id })),
    [runs],
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
      {runs.length > 1 && (
        <div className="row">
          <Select
            className="field"
            options={runOptions}
            value={selectedRunOption}
            onChange={(value) => onSelect(value!.value)}
          />
        </div>
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

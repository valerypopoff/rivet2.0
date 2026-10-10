import TextArea from '@atlaskit/textarea';
import Textfield from '@atlaskit/textfield';
import { css } from '@emotion/react';
import type { GraphInputNode } from '@valerypopoff/rivet2-core';
import {
  isEvaluationValueCompatibleWithDataType,
  summarizeEvaluationRun,
  type EvaluationDataset,
  type EvaluationDatasetField,
  type EvaluationEvaluatorInputSource,
  type EvaluationRun,
  type EvaluationThreshold,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';
import DeleteIcon from 'majesticons/line/delete-bin-line.svg?react';
import EditIcon from 'majesticons/line/edit-pen-2-line.svg?react';
import { useEffect, useRef, useState, type FC } from 'react';
import { EvaluationSelect as Select } from './EvaluationSelect.js';
import {
  formatEvaluationDurationSeconds,
  formatEvaluationScore,
  type EvaluationScoreSort,
} from './evaluationWorkspaceModel.js';

export const evaluationScoreSortOptions: Array<{ label: string; value: EvaluationScoreSort }> = [
  { label: 'Default order', value: 'default' },
  { label: 'Score: highest first', value: 'score-desc' },
  { label: 'Score: lowest first', value: 'score-asc' },
];

export type EvaluationRunSummary = NonNullable<ReturnType<typeof summarizeEvaluationRun>>;

// Completed run snapshots are immutable after they cross the store/runner
// boundary. Keep the score-by-case derivation by snapshot identity so a Runs
// tab remount does not repeat its observation walk. The summary intentionally
// re-derives newer factoids for legacy persisted aggregates that predate them.
const evaluationRunSummaryCache = new WeakMap<EvaluationRun, EvaluationRunSummary>();

export function getCachedEvaluationRunSummary(run: EvaluationRun): EvaluationRunSummary | undefined {
  if (!run.aggregate) return undefined;
  const cached = evaluationRunSummaryCache.get(run);
  if (cached) return cached;
  const summary = summarizeEvaluationRun(run);
  if (summary) evaluationRunSummaryCache.set(run, summary);
  return summary;
}

export const styles = css`
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

export const ResourceTitle: FC<{
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
export const JsonValueEditor: FC<{
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

export function isStructuredEvaluationDataType(dataType: string): boolean {
  return dataType !== 'string' && dataType !== 'number' && dataType !== 'boolean';
}

export function hasStaticGraphInputDefault(input: GraphInputNode): boolean {
  return input.data.defaultValue !== undefined && !input.data.useDefaultValueInput;
}

export function getEvaluationCaseGridTemplate(fields: EvaluationDatasetField[]): string {
  return [
    '56px',
    'minmax(0, 0.8fr)',
    'minmax(0, 0.9fr)',
    'minmax(0, 1fr)',
    ...fields.map((field) => (isStructuredEvaluationDataType(field.dataType) ? 'minmax(0, 2fr)' : 'minmax(0, 1fr)')),
    '28px',
  ].join(' ');
}

export const RemoveButton: FC<{ className?: string; label: string; onClick: () => void }> = ({
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

export const DatasetValueEditor: FC<{
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

export function updateDatasetCaseValue(
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

export function relativeDelta(current: number | undefined, baseline: number | undefined): string {
  if (current === undefined || baseline === undefined) return '—';
  if (baseline === 0) return current === 0 ? '0%' : 'new';
  const percent = ((current - baseline) / Math.abs(baseline)) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

export function humanizeEvaluationMetric(metric: string): string {
  if (metric === 'average-latency-ms') return 'Average latency';
  if (metric === 'p95-latency-ms') return 'P95 latency';
  const name = metric.startsWith('custom:') ? metric.slice('custom:'.length) : metric;
  return name.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export const percentageThresholdMetrics = new Set([
  'pass-rate',
  'mean-score',
  'target-error-rate',
  'evaluator-error-rate',
  'tool-failure-rate',
]);

export function thresholdUsesPercentageValue(metric: string, operator: EvaluationThreshold['operator']): boolean {
  return operator === 'max-regression' || percentageThresholdMetrics.has(metric);
}

export function isLatencyThresholdMetric(metric: string): boolean {
  return metric === 'average-latency-ms' || metric === 'p95-latency-ms';
}

export function formatPercentageThresholdValue(value: number): string {
  return String(Number((value * 100).toFixed(4)));
}

export function formatEvaluationMetricValue(metric: string, value: number | undefined): string {
  if (value === undefined) return 'Unavailable';
  if (percentageThresholdMetrics.has(metric)) {
    return `${(value * 100).toFixed(value * 100 === Math.round(value * 100) ? 0 : 1)}%`;
  }
  if (metric === 'average-cost' || metric === 'total-cost') return `$${value.toFixed(4)}`;
  if (isLatencyThresholdMetric(metric)) return formatEvaluationDurationSeconds(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

export function evaluatorInputSourceKey(source: EvaluationEvaluatorInputSource): string {
  if (source.kind === 'dataset-field') return `dataset-field:${source.fieldId}`;
  if (source.kind === 'target-output') return `target-output:${source.outputId}`;
  return `context:${source.context}`;
}

export const evaluatorContextLabels = {
  case: 'Case metadata and all field values',
  inputs: 'All supplied target inputs',
  expected: 'All expected dataset fields',
  outputs: 'All target outputs',
  run: 'Trial metadata',
} as const;

export function describeEvaluationThreshold(
  metric: string,
  operator: EvaluationThreshold['operator'],
  value: number,
): string {
  if (operator === 'at-least') return `At least ${formatEvaluationMetricValue(metric, value)}`;
  if (operator === 'at-most') return `At most ${formatEvaluationMetricValue(metric, value)}`;
  return `Regression no greater than ${formatEvaluationMetricValue('pass-rate', value)}`;
}

export function formatEvaluationComparisonMetric(label: string, value: number | undefined): string {
  if (value === undefined) return label === 'Total cost' ? 'Unavailable' : '—';
  if (label === 'Overall score') return formatEvaluationScore(value);
  if (label === 'Pass rate') return `${Math.round(value * 100)}%`;
  if (label === 'P95 latency') return formatEvaluationDurationSeconds(value);
  if (label === 'Total cost') return `$${value.toFixed(4)}`;
  return value.toFixed(4);
}

import Button from '@atlaskit/button';
import Textfield from '@atlaskit/textfield';
import type { GraphInputNode, Project } from '@valerypopoff/rivet2-core';
import {
  areEvaluationDataTypesCompatible,
  getEvaluationSuiteMode,
  LEGACY_EVALUATOR_INPUT_IDS,
  usesLegacyEvaluatorInputEnvelope,
  type EvaluationAssertionOperator,
  type EvaluationDataset,
  type EvaluationDatasetField,
  type EvaluationEvaluatorInputSource,
  type EvaluationSuite,
  type EvaluationThreshold,
} from '@valerypopoff/rivet2-evaluations';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import { nanoid } from 'nanoid/non-secure';
import { useEffect, useState, type FC } from 'react';
import { LabeledToggle } from '../LabeledToggle.js';
import { SegmentedEditor } from '../editors/SegmentedEditor.js';
import {
  EvaluationDefinitionTabs,
  type EvaluationDefinitionTab,
  type EvaluationDefinitionTabId,
} from './EvaluationDefinitionTabs.js';
import { EvaluationFormField } from './EvaluationFormField.js';
import { EvaluationSelect as Select } from './EvaluationSelect.js';
import {
  evaluationAssertionOperatorOptions,
  getEvaluationAssertionAuthoringIssue,
  getEvaluationEvaluatorAuthoringIssue,
  getEvaluationExecutionConfigurationAuthoringIssues,
  getEvaluationExpectedValueAuthoringIssues,
  getEvaluationInputBindingAuthoringIssues,
  getEvaluationThresholdAuthoringIssue,
  getUnusedExpectedFields,
  resolveEvaluationTargetOutput,
  suggestEvaluationAssertionOperator,
  type EvaluationTargetOutput,
} from './evaluationWorkspaceModel.js';

import {
  evaluatorContextLabels,
  evaluatorInputSourceKey,
  formatPercentageThresholdValue,
  hasStaticGraphInputDefault,
  humanizeEvaluationMetric,
  isLatencyThresholdMetric,
  JsonValueEditor,
  percentageThresholdMetrics,
  RemoveButton,
  ResourceTitle,
  thresholdUsesPercentageValue,
} from './evaluationPresentation.js';
export const Definition: FC<{
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

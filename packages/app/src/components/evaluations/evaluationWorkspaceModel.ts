import {
  isEvaluationValueCompatibleWithDataType,
  isEvaluationOutputPathSyntaxValid,
  type EvaluationAssertion,
  type EvaluationAssertionOperator,
  type EvaluationBaselineSnapshot,
  type EvaluationDataset,
  type EvaluationDatasetField,
  type EvaluationGraphEvaluator,
  type EvaluationQualityStatus,
  type EvaluationRun,
  type EvaluationSuite,
  type EvaluationThreshold,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';
import type {
  ChartNode,
  DataType,
  GraphId,
  GraphInputNode,
  GraphOutputNode,
  Project,
  ProjectId,
} from '@valerypopoff/rivet2-core';

export type EvaluationWorkspaceView = 'definition' | 'dataset' | 'runs' | 'compare';

export type EvaluationSuiteReferenceStatus = {
  datasetExists: boolean;
  targetGraphExists: boolean;
  evaluatorGraphsExist: boolean;
};

export type EvaluationRunQualityPresentation = {
  label: 'Passed' | 'Failed' | 'Not evaluated' | 'Unable to evaluate';
  explanation: string;
};

export const evaluationAssertionOperatorOptions: ReadonlyArray<{
  label: string;
  value: EvaluationAssertionOperator;
}> = [
  { label: 'Equals exactly', value: 'equals' },
  { label: 'Does not equal', value: 'not-equals' },
  { label: 'Contains', value: 'contains' },
  { label: 'Contains any expected text', value: 'contains-any' },
  { label: 'Contains every expected text', value: 'contains-all' },
  { label: 'Matches regular expression', value: 'matches-regex' },
  { label: 'Has type', value: 'type-is' },
  { label: 'Matches JSON Schema', value: 'json-schema' },
  { label: 'Number is at least', value: 'number-at-least' },
  { label: 'Number is at most', value: 'number-at-most' },
  { label: 'Number is between', value: 'number-between' },
  { label: 'Array includes value', value: 'array-includes' },
  { label: 'Sets overlap', value: 'set-overlaps' },
];

export type EvaluationTargetOutput = {
  id: string;
  dataType: DataType;
  outputPath: string;
};

export type EvaluationAssertionAuthoringIssue = {
  code:
    | 'missing-output'
    | 'invalid-output-path'
    | 'missing-expected-field'
    | 'incompatible-output'
    | 'incompatible-expected-value';
  message: string;
};

/** JSONPath for one exact Graph Output ID, including IDs with punctuation. */
export function getEvaluationTargetOutputPath(outputId: string): string {
  return `$[${JSON.stringify(outputId)}]`;
}

export function getEvaluationTargetOutputs(nodes: readonly ChartNode[]): EvaluationTargetOutput[] {
  return (nodes.filter((node) => node.type === 'graphOutput') as GraphOutputNode[]).map((node) => ({
    id: node.data.id,
    dataType: node.data.dataType,
    outputPath: getEvaluationTargetOutputPath(node.data.id),
  }));
}

/**
 * Returns the selected top-level output for both new quoted paths and simple
 * legacy `$.output` paths. Nested/custom paths intentionally return undefined.
 */
export function resolveEvaluationTargetOutput(
  outputPath: string,
  outputs: readonly EvaluationTargetOutput[],
): EvaluationTargetOutput | undefined {
  return outputs.find(
    (output) =>
      output.outputPath === outputPath || (/^[A-Za-z_$][\w$]*$/.test(output.id) && `$.${output.id}` === outputPath),
  );
}

function scalarTypeOf(dataType: string): string {
  return dataType.endsWith('[]') ? dataType.slice(0, -2) : dataType;
}

/** Suggests a useful first check without making expected data silently authoritative. */
export function suggestEvaluationAssertionOperator(
  outputType: string,
  expectedType: string,
): EvaluationAssertionOperator {
  if (outputType === 'string' && expectedType === 'string[]') return 'contains-all';
  if (outputType === 'string' && expectedType === 'string') return 'equals';
  if (outputType.endsWith('[]') && scalarTypeOf(outputType) === expectedType) return 'array-includes';
  if (outputType.endsWith('[]') && expectedType.endsWith('[]')) return 'set-overlaps';
  return 'equals';
}

function isArrayType(dataType: string): boolean {
  return dataType.endsWith('[]');
}

function isStringLikeType(dataType: string): boolean {
  return dataType === 'string' || dataType === 'date' || dataType === 'time' || dataType === 'datetime';
}

function comparableDataTypesMatch(left: string, right: string): boolean {
  if (left === 'any' || right === 'any' || left === right) return true;
  if (isStringLikeType(left) && isStringLikeType(right)) return true;
  if (isArrayType(left) && isArrayType(right)) {
    return comparableDataTypesMatch(scalarTypeOf(left), scalarTypeOf(right));
  }
  return false;
}

function expectedDataTypeMatchesOutput(
  operator: EvaluationAssertionOperator,
  outputDataType: string,
  expectedDataType: string,
): boolean {
  if (outputDataType === 'any' || expectedDataType === 'any') return true;
  switch (operator) {
    case 'equals':
    case 'not-equals':
      return comparableDataTypesMatch(outputDataType, expectedDataType);
    case 'array-includes':
      return isArrayType(outputDataType) && comparableDataTypesMatch(scalarTypeOf(outputDataType), expectedDataType);
    case 'set-overlaps':
      return (
        isArrayType(outputDataType) &&
        isArrayType(expectedDataType) &&
        comparableDataTypesMatch(scalarTypeOf(outputDataType), scalarTypeOf(expectedDataType))
      );
    default:
      return true;
  }
}

function portableJsonDataType(value: PortableJson): string {
  if (value === null) return 'null';
  if (!Array.isArray(value)) return typeof value;
  if (value.length === 0) return 'any[]';
  const elementTypes = new Set(value.map(portableJsonDataType));
  return elementTypes.size === 1 ? `${elementTypes.values().next().value!}[]` : 'any[]';
}

function expectedDataTypeMatches(operator: EvaluationAssertionOperator, dataType: string): boolean {
  if (dataType === 'any') return true;
  switch (operator) {
    case 'contains':
    case 'matches-regex':
    case 'type-is':
      return isStringLikeType(dataType);
    case 'contains-any':
    case 'contains-all':
      return dataType === 'string[]';
    case 'json-schema':
      return dataType === 'object';
    case 'number-at-least':
    case 'number-at-most':
      return dataType === 'number';
    case 'number-between':
      return dataType === 'number[]';
    case 'set-overlaps':
      return isArrayType(dataType);
    default:
      return true;
  }
}

function outputDataTypeMatches(operator: EvaluationAssertionOperator, dataType: string): boolean {
  if (dataType === 'any') return true;
  switch (operator) {
    case 'contains':
    case 'contains-any':
    case 'contains-all':
    case 'matches-regex':
      return isStringLikeType(dataType);
    case 'number-at-least':
    case 'number-at-most':
    case 'number-between':
      return dataType === 'number';
    case 'array-includes':
    case 'set-overlaps':
      return isArrayType(dataType);
    default:
      return true;
  }
}

function literalMatchesOperator(operator: EvaluationAssertionOperator, value: PortableJson): boolean {
  switch (operator) {
    case 'contains':
      return typeof value === 'string';
    case 'matches-regex':
      if (typeof value !== 'string') return false;
      try {
        new RegExp(value);
        return true;
      } catch {
        return false;
      }
    case 'contains-any':
    case 'contains-all':
      return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
    case 'type-is':
      return typeof value === 'string' && ['array', 'boolean', 'null', 'number', 'object', 'string'].includes(value);
    case 'json-schema':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'number-at-least':
    case 'number-at-most':
      return typeof value === 'number' && Number.isFinite(value);
    case 'number-between':
      return (
        Array.isArray(value) &&
        value.length === 2 &&
        value.every((item) => typeof item === 'number' && Number.isFinite(item)) &&
        value[0]! <= value[1]!
      );
    case 'set-overlaps':
      return Array.isArray(value);
    default:
      return true;
  }
}

function describeExpectedValue(operator: EvaluationAssertionOperator): string {
  switch (operator) {
    case 'contains':
      return 'text';
    case 'matches-regex':
      return 'a regular-expression string';
    case 'contains-any':
    case 'contains-all':
      return 'a non-empty array of text values';
    case 'type-is':
      return 'one of: array, boolean, null, number, object, or string';
    case 'json-schema':
      return 'a JSON Schema object';
    case 'number-at-least':
    case 'number-at-most':
      return 'a finite number';
    case 'number-between':
      return 'a two-number range whose minimum is not greater than its maximum';
    case 'set-overlaps':
      return 'an array';
    default:
      return 'a compatible value';
  }
}

/**
 * Finds configuration mistakes the editor can prove without running a graph.
 * Custom JSON paths intentionally have an unknown output type; the runtime
 * remains authoritative for the value found at those paths.
 */
export function getEvaluationAssertionAuthoringIssue(
  assertion: EvaluationAssertion,
  outputs: readonly EvaluationTargetOutput[],
  expectedFields: readonly EvaluationDatasetField[],
): EvaluationAssertionAuthoringIssue | undefined {
  const outputPath = assertion.outputPath.trim();
  if (outputPath.length === 0) {
    return { code: 'missing-output', message: 'Choose a target output or enter an output JSON path.' };
  }
  if (!isEvaluationOutputPathSyntaxValid(outputPath)) {
    return {
      code: 'invalid-output-path',
      message: 'Enter a valid output JSON path, such as $["answer"], $.result.score, or $.items[0].',
    };
  }

  const output = resolveEvaluationTargetOutput(outputPath, outputs);
  const isExactTopLevelPath = /^\$\.[A-Za-z_$][\w$]*$/.test(outputPath) || /^\$\["(?:[^"\\]|\\.)*"\]$/.test(outputPath);
  if (!output && isExactTopLevelPath) {
    return {
      code: 'missing-output',
      message: 'The selected target output no longer exists. Choose another output or enter a nested output path.',
    };
  }
  if (output && !outputDataTypeMatches(assertion.operator, output.dataType)) {
    return {
      code: 'incompatible-output',
      message: `“${evaluationAssertionOperatorOptions.find((option) => option.value === assertion.operator)?.label ?? assertion.operator}” is not compatible with the ${output.dataType} target output.`,
    };
  }

  if (assertion.expected.kind === 'dataset-field') {
    const expectedFieldId = assertion.expected.fieldId;
    const field = expectedFields.find((candidate) => candidate.id === expectedFieldId && candidate.role === 'expected');
    if (!field) {
      return { code: 'missing-expected-field', message: 'Choose an existing expected dataset field.' };
    }
    if (!expectedDataTypeMatches(assertion.operator, field.dataType)) {
      return {
        code: 'incompatible-expected-value',
        message: `This comparison requires ${describeExpectedValue(assertion.operator)}, but “${field.name}” is ${field.dataType}.`,
      };
    }
    if (output && !expectedDataTypeMatchesOutput(assertion.operator, output.dataType, field.dataType)) {
      return {
        code: 'incompatible-expected-value',
        message: `“${field.name}” (${field.dataType}) is not comparable with the ${output.dataType} target output using this comparison.`,
      };
    }
    return undefined;
  }

  if (!literalMatchesOperator(assertion.operator, assertion.expected.value)) {
    return {
      code: 'incompatible-expected-value',
      message: `This comparison requires ${describeExpectedValue(assertion.operator)} as its expected JSON value.`,
    };
  }
  const literalDataType = portableJsonDataType(assertion.expected.value);
  if (output && !expectedDataTypeMatchesOutput(assertion.operator, output.dataType, literalDataType)) {
    return {
      code: 'incompatible-expected-value',
      message: `The expected ${literalDataType} JSON value is not comparable with the ${output.dataType} target output using this comparison.`,
    };
  }
  return undefined;
}

export function getUnusedExpectedFields(
  fields: readonly EvaluationDatasetField[],
  assertions: readonly EvaluationAssertion[],
): EvaluationDatasetField[] {
  const referenced = new Set(
    assertions.flatMap((assertion) =>
      assertion.expected.kind === 'dataset-field' ? [assertion.expected.fieldId] : [],
    ),
  );
  return fields.filter((field) => field.role === 'expected' && !referenced.has(field.id));
}

/**
 * Mirrors the target-input invariants that can be proven in the editor. This
 * keeps missing bindings and missing case values out of the execution queue;
 * runtime validation remains authoritative for the complete graph contract.
 */
export function getEvaluationInputBindingAuthoringIssues(
  suite: EvaluationSuite,
  dataset: EvaluationDataset,
  graphInputs: readonly GraphInputNode[],
): string[] {
  const fields = new Map(dataset.fields.map((field) => [field.id, field]));
  const enabledCases = dataset.cases.filter((testCase) => testCase.enabled !== false);
  const issues: string[] = [];
  const graphInputIds = new Set(graphInputs.map((input) => input.data.id));
  const seenBindings = new Set<string>();

  for (const binding of suite.inputBindings) {
    if (!graphInputIds.has(binding.graphInputId)) {
      issues.push(`Remove the stale binding for missing target input “${binding.graphInputId}”.`);
    } else if (seenBindings.has(binding.graphInputId)) {
      issues.push(`Target input “${binding.graphInputId}” is bound more than once.`);
    }
    seenBindings.add(binding.graphInputId);
  }

  for (const input of graphInputs) {
    const binding = suite.inputBindings.find((candidate) => candidate.graphInputId === input.data.id);
    if (!binding) {
      if (input.data.defaultValue === undefined || input.data.useDefaultValueInput) {
        issues.push(`Bind target input “${input.data.id}” to a dataset field or give it a static graph default.`);
      }
      continue;
    }

    const field = fields.get(binding.datasetFieldId);
    if (!field || field.role !== 'input') {
      issues.push(`Target input “${input.data.id}” references a missing or non-input dataset field.`);
      continue;
    }
    if (field.dataType !== 'any' && input.data.dataType !== 'any' && field.dataType !== input.data.dataType) {
      issues.push(
        `Dataset field “${field.name}” (${field.dataType}) is not compatible with target input “${input.data.id}” (${input.data.dataType}).`,
      );
      continue;
    }

    for (const testCase of enabledCases) {
      const value = testCase.values[field.id];
      if (value === undefined) {
        issues.push(`Case “${testCase.name}” has no value for bound input “${field.name}”.`);
      } else if (!isEvaluationValueCompatibleWithDataType(value, input.data.dataType)) {
        issues.push(
          `Case “${testCase.name}” value for “${field.name}” is not compatible with target input “${input.data.id}” (${input.data.dataType}).`,
        );
      }
    }
  }

  return issues;
}

/** Required case values and values consumed by deterministic checks must be valid before execution. */
export function getEvaluationExpectedValueAuthoringIssues(
  suite: EvaluationSuite,
  dataset: EvaluationDataset,
): string[] {
  const assertionsByField = new Map<string, EvaluationAssertion[]>();
  for (const assertion of suite.assertions) {
    if (assertion.expected.kind !== 'dataset-field') continue;
    assertionsByField.set(assertion.expected.fieldId, [
      ...(assertionsByField.get(assertion.expected.fieldId) ?? []),
      assertion,
    ]);
  }

  const issues: string[] = [];
  for (const testCase of dataset.cases.filter((candidate) => candidate.enabled !== false)) {
    for (const field of dataset.fields) {
      const assertions = assertionsByField.get(field.id) ?? [];
      const value = testCase.values[field.id];
      if (value === undefined && (field.required || assertions.length > 0)) {
        issues.push(`Case “${testCase.name}” has no required value for “${field.name}”.`);
        continue;
      }
      if (value === undefined) continue;
      if (!isEvaluationValueCompatibleWithDataType(value, field.dataType)) {
        issues.push(
          `Case “${testCase.name}” value for “${field.name}” is not compatible with its declared ${field.dataType} type.`,
        );
        continue;
      }
      for (const assertion of assertions) {
        if (!literalMatchesOperator(assertion.operator, value)) {
          issues.push(
            `Case “${testCase.name}” value for “${field.name}” does not provide ${describeExpectedValue(assertion.operator)} required by “${assertion.name}”.`,
          );
        }
      }
    }
  }

  return issues;
}

export function getEvaluationEvaluatorAuthoringIssue(
  evaluator: EvaluationGraphEvaluator,
  project: Project,
): string | undefined {
  if (evaluator.scoreWeight !== undefined && (!Number.isFinite(evaluator.scoreWeight) || evaluator.scoreWeight <= 0)) {
    return 'Score weight must be a positive finite number.';
  }
  const graph = project.graphs[evaluator.graphId];
  if (!graph) return 'Choose an existing evaluator graph.';
  const graphInputs = graph.nodes.filter((node): node is GraphInputNode => node.type === 'graphInput');
  const reservedInputIds = ['case', 'inputs', 'expected', 'outputs', 'run'] as const;
  const missingInputs = reservedInputIds.filter((id) => !graphInputs.some((input) => input.data.id === id));
  if (missingInputs.length > 0) {
    return `Evaluator graph is missing reserved Graph Input${missingInputs.length === 1 ? '' : 's'}: ${missingInputs.join(', ')}.`;
  }
  for (const inputId of reservedInputIds) {
    const matchingInputs = graphInputs.filter((input) => input.data.id === inputId);
    if (matchingInputs.length > 1) {
      return `Evaluator graph declares reserved Graph Input “${inputId}” more than once.`;
    }
    const dataType = matchingInputs[0]!.data.dataType;
    if (dataType !== 'object' && dataType !== 'any') {
      return `Evaluator graph input “${inputId}” must use the object or any data type.`;
    }
  }
  const resultOutput = graph.nodes.find(
    (node): node is GraphOutputNode => node.type === 'graphOutput' && (node.data as { id?: unknown }).id === 'result',
  );
  if (!resultOutput) return 'Evaluator graph must declare a Graph Output named “result”.';
  if (resultOutput.data.dataType !== 'object' && resultOutput.data.dataType !== 'any') {
    return 'Evaluator graph output “result” must use the object or any data type.';
  }
  return undefined;
}

export function getEvaluationThresholdAuthoringIssue(
  threshold: EvaluationThreshold,
  suite: EvaluationSuite,
): string | undefined {
  const metric = threshold.metric;
  if (metric.length === 0 || metric === 'custom:') return 'Choose a metric or enter a custom evaluator metric name.';
  const supportedMetrics = new Set([
    'pass-rate',
    'mean-score',
    'target-error-rate',
    'evaluator-error-rate',
    'tool-failure-rate',
    'average-cost',
    'total-cost',
    'average-latency-ms',
    'p95-latency-ms',
  ]);
  if (!supportedMetrics.has(metric) && !(metric.startsWith('custom:') && metric.length > 'custom:'.length)) {
    return `Metric “${metric}” is not supported. Choose a built-in metric or a named custom evaluator metric.`;
  }
  if (!Number.isFinite(threshold.value)) return 'Threshold value must be a finite number.';

  const rateMetrics = new Set([
    'pass-rate',
    'mean-score',
    'target-error-rate',
    'evaluator-error-rate',
    'tool-failure-rate',
  ]);
  if (rateMetrics.has(metric) && (threshold.value < 0 || threshold.value > 1)) {
    return 'Rate and score thresholds must be between 0 and 1.';
  }
  if (['average-cost', 'total-cost', 'average-latency-ms', 'p95-latency-ms'].includes(metric) && threshold.value < 0) {
    return 'Cost and latency thresholds cannot be negative.';
  }
  if (threshold.operator === 'max-regression' && threshold.value < 0) {
    return 'Maximum regression cannot be negative.';
  }

  const hasRequiredPerTrialCheck =
    suite.assertions.some((assertion) => assertion.required !== false) ||
    suite.evaluators.some((evaluator) => evaluator.required !== false);
  if (metric === 'pass-rate' && !hasRequiredPerTrialCheck) {
    return 'Pass rate requires at least one required deterministic check or evaluator graph.';
  }
  if (
    (metric === 'mean-score' || metric === 'evaluator-error-rate' || metric.startsWith('custom:')) &&
    suite.evaluators.length === 0
  ) {
    return 'This metric requires at least one evaluator graph.';
  }

  if (threshold.operator !== 'max-regression') {
    const expectedOperator =
      metric === 'pass-rate' || metric === 'mean-score'
        ? 'at-least'
        : metric.startsWith('custom:')
          ? undefined
          : 'at-most';
    if (expectedOperator && threshold.operator !== expectedOperator) {
      return `This metric must use the “${expectedOperator}” comparison.`;
    }
  }
  return undefined;
}

/** Configuration errors that can be fixed before allocating any workers. */
export function getEvaluationExecutionConfigurationAuthoringIssues(
  suite: EvaluationSuite,
  targetInputs: readonly GraphInputNode[],
): string[] {
  const issues: string[] = [];
  const configuration = suite.configuration;
  const trialCount = configuration?.trialCount ?? 1;
  const concurrency = configuration?.concurrency ?? 4;

  if (!Number.isSafeInteger(trialCount) || trialCount < 1) {
    issues.push('Trials must be a positive whole number.');
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    issues.push('Concurrency must be a whole number from 1 to 32.');
  }
  if (
    configuration?.timeoutMs !== undefined &&
    (!Number.isFinite(configuration.timeoutMs) || configuration.timeoutMs <= 0)
  ) {
    issues.push('Per-graph timeout must be a positive number of seconds or left empty.');
  }

  if (configuration?.seed === undefined) {
    if (configuration?.seedGraphInputId !== undefined) {
      issues.push('Remove the seed target input or provide a suite seed.');
    }
    return issues;
  }

  if (!Number.isSafeInteger(configuration.seed) || configuration.seed < 0) {
    issues.push('Suite seed must be a non-negative whole number.');
  }
  if (!configuration.seedGraphInputId) {
    issues.push('Choose the numeric target input that receives each derived seed.');
    return issues;
  }

  const seedInput = targetInputs.find((input) => input.data.id === configuration.seedGraphInputId);
  if (!seedInput) {
    issues.push('The selected seed target input no longer exists.');
  } else if (seedInput.data.dataType !== 'number' && seedInput.data.dataType !== 'any') {
    issues.push('The seed target input must use the number or any data type.');
  }
  if (suite.inputBindings.some((binding) => binding.graphInputId === configuration.seedGraphInputId)) {
    issues.push('The seed target input cannot also be bound to a dataset field.');
  }

  return issues;
}

/**
 * Render the authoritative v2 quality state. Accounting completeness is a
 * separate concern and must never overwrite a passed quality result.
 */
export function getEvaluationRunQualityPresentation(run: EvaluationRun): EvaluationRunQualityPresentation {
  const qualityStatus: EvaluationQualityStatus = run.qualityStatus;
  if (qualityStatus === 'passed') {
    return { label: 'Passed', explanation: run.qualityReason.message };
  }
  if (qualityStatus === 'failed') {
    return { label: 'Failed', explanation: run.qualityReason.message };
  }
  if (qualityStatus === 'not-evaluated') {
    return {
      label: 'Not evaluated',
      explanation: run.qualityReason.message,
    };
  }
  return {
    label: 'Unable to evaluate',
    explanation: run.qualityReason.message,
  };
}

/**
 * Selection in Evaluations is explicit. In particular, loading a project with
 * no saved selection must not make the first suite look selected.
 */
export function resolveSelectedEvaluationSuite(
  suites: readonly EvaluationSuite[],
  selectedSuiteId: string | undefined,
): EvaluationSuite | undefined {
  return selectedSuiteId == null ? undefined : suites.find((suite) => suite.id === selectedSuiteId);
}

/**
 * Dataset IDs are only unique within a project. Do not let a stale or malformed
 * data file make a suite appear runnable against another project's dataset.
 */
export function resolveProjectEvaluationDataset(
  datasets: readonly EvaluationDataset[],
  projectId: ProjectId,
  datasetId: string | undefined,
): EvaluationDataset | undefined {
  return datasetId == null
    ? undefined
    : datasets.find((dataset) => dataset.id === datasetId && dataset.projectId === projectId);
}

export function getEvaluationSuiteReferenceStatus(
  suite: EvaluationSuite,
  project: Project,
  datasets: readonly EvaluationDataset[],
): EvaluationSuiteReferenceStatus {
  return {
    datasetExists: resolveProjectEvaluationDataset(datasets, project.metadata.id, suite.datasetId) !== undefined,
    targetGraphExists: project.graphs[suite.targetGraphId] != null,
    evaluatorGraphsExist: suite.evaluators?.every((evaluator) => project.graphs[evaluator.graphId] != null) ?? true,
  };
}

export function canCompareEvaluationSuite(
  suiteId: string,
  runs: readonly EvaluationRun[],
  baselines: readonly EvaluationBaselineSnapshot[],
): boolean {
  if (baselines.some((baseline) => baseline.suiteId === suiteId)) {
    return true;
  }

  return (
    runs.filter((run) => run.suiteId === suiteId && run.executionStatus === 'completed' && run.aggregate !== undefined)
      .length >= 2
  );
}

/**
 * The Compare view needs a completed aggregate. Stored history can also
 * contain canceled or failed runs, so the first stored run is not a safe
 * default merely because it belongs to the selected suite.
 */
export function resolveComparableEvaluationRun(
  suiteId: string,
  runs: readonly EvaluationRun[],
  selectedRunId: string | undefined,
  currentRun: EvaluationRun | undefined,
): EvaluationRun | undefined {
  const isComparable = (run: EvaluationRun | undefined): run is EvaluationRun =>
    run?.suiteId === suiteId && run.executionStatus === 'completed' && run.aggregate !== undefined;
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  return [currentRun, selectedRun, ...runs].find(isComparable);
}

/**
 * Prompt Designer drafts are ephemeral and belong to one exact project graph.
 * Graph IDs can collide across projects, so matching only the target graph is
 * not enough to safely substitute an unsaved draft during an evaluation.
 */
export function resolvePromptDesignerEvaluationProject(
  override: { project: Project; projectId: ProjectId; graphId: GraphId } | undefined,
  projectId: ProjectId,
  targetGraphId: GraphId,
): Project | undefined {
  return override?.projectId === projectId && override.graphId === targetGraphId ? override.project : undefined;
}

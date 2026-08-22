import {
  areEvaluationDataTypesCompatible,
  getEvaluationTopLevelOutputId,
  isEvaluationValueCompatibleWithDataType,
  isEvaluationOutputPathSyntaxValid,
  preserveEvaluationRunName,
  shouldReplaceEvaluationRun,
  validateEvaluationAssertionExpectedValue,
  LEGACY_EVALUATOR_INPUT_IDS,
  usesLegacyEvaluatorInputEnvelope,
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
  label: 'Passed' | 'Failed' | 'Scored' | 'Not evaluated' | 'Unable to evaluate';
  explanation: string;
};

/** UI-only ordering; stored run and trial history always keeps its execution order. */
export type EvaluationScoreSort = 'default' | 'score-desc' | 'score-asc';

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

function expectedValueMatchesAssertion(assertion: EvaluationAssertion, value: PortableJson): boolean {
  try {
    validateEvaluationAssertionExpectedValue(assertion, value);
    return true;
  } catch {
    return false;
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

  const topLevelOutputId = getEvaluationTopLevelOutputId(outputPath);
  if (outputPath !== '$' && topLevelOutputId === undefined) {
    return {
      code: 'invalid-output-path',
      message: 'The output path must start with a named Graph Output, such as $["answer"] or $.result.score.',
    };
  }
  if (topLevelOutputId !== undefined && !outputs.some((candidate) => candidate.id === topLevelOutputId)) {
    return {
      code: 'missing-output',
      message: 'The target output used by this path no longer exists. Choose another output.',
    };
  }
  const output = resolveEvaluationTargetOutput(outputPath, outputs);
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

  if (!expectedValueMatchesAssertion(assertion, assertion.expected.value)) {
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

/**
 * Required case values are always validated. Values consumed exclusively by
 * dormant pass/fail assertions are ignored while the suite uses scoring.
 */
export function getEvaluationExpectedValueAuthoringIssues(
  suite: EvaluationSuite,
  dataset: EvaluationDataset,
): string[] {
  const assertionsByField = new Map<string, EvaluationAssertion[]>();
  if (suite.evaluationMode !== 'scoring') {
    for (const assertion of suite.assertions) {
      if (assertion.expected.kind !== 'dataset-field') continue;
      assertionsByField.set(assertion.expected.fieldId, [
        ...(assertionsByField.get(assertion.expected.fieldId) ?? []),
        assertion,
      ]);
    }
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
        if (!expectedValueMatchesAssertion(assertion, value)) {
          issues.push(
            `Case “${testCase.name}” value for “${field.name}” does not provide ${describeExpectedValue(assertion.operator)} required by “${assertion.name}”.`,
          );
        }
      }
    }
  }

  return issues;
}

/**
 * Dataset values participate in every run, including execution benchmarks.
 * Keep this check separate from assertion-specific expected-value validation so
 * the benchmark controls can reject corrupt typed cells without requiring
 * pass/fail-only reference values.
 */
export function getEvaluationDatasetValueTypeAuthoringIssues(dataset: EvaluationDataset): string[] {
  const issues: string[] = [];
  const fields = new Map(dataset.fields.map((field) => [field.id, field]));

  for (const testCase of dataset.cases.filter((candidate) => candidate.enabled !== false)) {
    for (const [fieldId, value] of Object.entries(testCase.values)) {
      const field = fields.get(fieldId);
      if (!field || value === undefined) continue;
      if (!isEvaluationValueCompatibleWithDataType(value, field.dataType)) {
        issues.push(
          `Case “${testCase.name}” value for “${field.name}” is not compatible with its declared ${field.dataType} type.`,
        );
      }
    }
  }

  return issues;
}

export function getEvaluationEvaluatorAuthoringIssue(
  evaluator: EvaluationGraphEvaluator,
  project: Project,
  suite?: EvaluationSuite,
  dataset?: EvaluationDataset,
): string | undefined {
  if (evaluator.scoreWeight !== undefined && (!Number.isFinite(evaluator.scoreWeight) || evaluator.scoreWeight <= 0)) {
    return 'Score weight must be a positive finite number.';
  }
  const graph = project.graphs[evaluator.graphId];
  if (!graph) return 'Choose an existing evaluator graph.';
  const resultOutput = graph.nodes.find(
    (node): node is GraphOutputNode => node.type === 'graphOutput' && (node.data as { id?: unknown }).id === 'result',
  );
  if (!resultOutput) return 'Evaluator graph must declare a Graph Output named “result”.';
  if (resultOutput.data.dataType !== 'object' && resultOutput.data.dataType !== 'any') {
    return 'Evaluator graph output “result” must use the object or any data type.';
  }

  const graphInputs = graph.nodes.filter((node): node is GraphInputNode => node.type === 'graphInput');
  const graphInputIds = graphInputs.map((input) => input.data.id);
  if (new Set(graphInputIds).size !== graphInputIds.length) return 'Evaluator graph has duplicate Graph Input ids.';
  const graphInputsById = new Map(graphInputs.map((input) => [input.data.id, input]));
  if (usesLegacyEvaluatorInputEnvelope(evaluator, graphInputIds)) {
    for (const inputId of LEGACY_EVALUATOR_INPUT_IDS) {
      const dataType = graphInputsById.get(inputId)!.data.dataType;
      if (dataType !== 'object' && dataType !== 'any') {
        return `Legacy evaluator input “${inputId}” must use the object or any data type.`;
      }
    }
    const unboundInput = graphInputs.find(
      (input) =>
        !LEGACY_EVALUATOR_INPUT_IDS.includes(input.data.id as (typeof LEGACY_EVALUATOR_INPUT_IDS)[number]) &&
        (input.data.defaultValue === undefined || input.data.useDefaultValueInput),
    );
    return unboundInput
      ? `Evaluator input “${unboundInput.data.id}” needs a direct binding or a static graph default.`
      : undefined;
  }

  const boundInputIds = new Set<string>();
  for (const binding of evaluator.inputBindings ?? []) {
    if (boundInputIds.has(binding.graphInputId))
      return `Evaluator input “${binding.graphInputId}” is bound more than once.`;
    boundInputIds.add(binding.graphInputId);
    const evaluatorInput = graphInputsById.get(binding.graphInputId);
    if (!evaluatorInput) return `Bound evaluator input “${binding.graphInputId}” does not exist on the selected graph.`;

    let sourceDataType: string;
    if (binding.source.kind === 'dataset-field') {
      const fieldId = binding.source.fieldId;
      const field = dataset?.fields.find((candidate) => candidate.id === fieldId);
      if (!field) return `Binding for “${binding.graphInputId}” references a missing dataset field.`;
      sourceDataType = field.dataType;
      for (const testCase of dataset!.cases.filter((candidate) => candidate.enabled !== false)) {
        const value = testCase.values[field.id];
        if (value === undefined) {
          return `Case “${testCase.name}” has no value for evaluator input “${binding.graphInputId}” from “${field.name}”.`;
        }
        if (!isEvaluationValueCompatibleWithDataType(value, evaluatorInput.data.dataType)) {
          return `Case “${testCase.name}” value from “${field.name}” is not compatible with evaluator input “${binding.graphInputId}” (${evaluatorInput.data.dataType}).`;
        }
      }
    } else if (binding.source.kind === 'target-output') {
      const outputId = binding.source.outputId;
      const targetOutput = suite
        ? getEvaluationTargetOutputs(project.graphs[suite.targetGraphId]?.nodes ?? []).find(
            (output) => output.id === outputId,
          )
        : undefined;
      if (!targetOutput) return `Binding for “${binding.graphInputId}” references a missing target output.`;
      sourceDataType = targetOutput.dataType;
    } else if (binding.source.kind === 'context') {
      sourceDataType = 'object';
    } else {
      return `Binding for “${binding.graphInputId}” uses an unsupported source.`;
    }
    if (!areEvaluationDataTypesCompatible(sourceDataType, evaluatorInput.data.dataType)) {
      return `Source for evaluator input “${binding.graphInputId}” (${sourceDataType}) is not compatible with ${evaluatorInput.data.dataType}.`;
    }
  }
  const unboundInput = graphInputs.find(
    (input) =>
      !boundInputIds.has(input.data.id) && (input.data.defaultValue === undefined || input.data.useDefaultValueInput),
  );
  return unboundInput
    ? `Choose a source for evaluator input “${unboundInput.data.id}” or give it a static graph default.`
    : undefined;
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
    return 'Rate and score thresholds must be between 0% and 100%.';
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
  if (qualityStatus === 'scored') {
    return { label: 'Scored', explanation: run.qualityReason.message };
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
 * Scores are normalized internally, but the Runs view displays them on Rivet's
 * 0–100 scale. Keep missing scores last so partial scoring runs stay useful.
 */
export function meanEvaluationTrialScore(trial: EvaluationRun['trials'][number]): number | undefined {
  let weightedScore = 0;
  let totalWeight = 0;
  for (const observation of trial.observations) {
    if (typeof observation.score !== 'number' || !Number.isFinite(observation.score)) continue;
    const weight = observation.scoreWeight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weightedScore += observation.score * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? undefined : weightedScore / totalWeight;
}

function sortByOptionalScore<T>(
  items: readonly T[],
  sort: EvaluationScoreSort,
  getScore: (item: T) => number | undefined,
): T[] {
  if (sort === 'default') return [...items];
  const direction = sort === 'score-desc' ? -1 : 1;
  return items
    .map((item, index) => ({ item, index, score: getScore(item) }))
    .sort((left, right) => {
      if (left.score === undefined) return right.score === undefined ? left.index - right.index : 1;
      if (right.score === undefined) return -1;
      return (left.score - right.score) * direction || left.index - right.index;
    })
    .map(({ item }) => item);
}

export function sortEvaluationTrialsByScore(
  trials: readonly EvaluationRun['trials'][number][],
  sort: EvaluationScoreSort,
): EvaluationRun['trials'][number][] {
  return sortByOptionalScore(trials, sort, meanEvaluationTrialScore);
}

export function sortEvaluationRunsByScore(
  runs: readonly EvaluationRun[],
  sort: EvaluationScoreSort,
): EvaluationRun[] {
  return sortByOptionalScore(runs, sort, (run) => {
    const score = run.aggregate?.meanScore;
    return typeof score === 'number' && Number.isFinite(score) ? score : undefined;
  });
}

/** Evaluation timings are stored in milliseconds but presented in seconds. */
export function formatEvaluationDurationSeconds(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return 'Unavailable';
  const decimals = durationMs >= 10_000 ? 1 : 2;
  return `${(durationMs / 1_000).toFixed(decimals)} sec`;
}

/**
 * Selection in Evaluations is explicit. In particular, entering a project
 * without a workspace selection must not make the first suite look selected.
 */
export function resolveSelectedEvaluationSuite(
  suites: readonly EvaluationSuite[],
  selectedSuiteId: string | undefined,
): EvaluationSuite | undefined {
  return selectedSuiteId == null ? undefined : suites.find((suite) => suite.id === selectedSuiteId);
}

/**
 * Resource reassignment must clear only bindings owned by that resource. Keep
 * unrelated evaluator sources intact so repairing one suite reference does not
 * discard valid authoring work.
 */
export function reassignEvaluationSuiteDataset(suite: EvaluationSuite, datasetId: string): EvaluationSuite {
  return {
    ...suite,
    datasetId,
    inputBindings: [],
    assertions: suite.assertions.map((assertion) =>
      assertion.expected.kind === 'dataset-field'
        ? { ...assertion, expected: { kind: 'literal' as const, value: null } }
        : assertion,
    ),
    evaluators: suite.evaluators.map((evaluator) => ({
      ...evaluator,
      ...(evaluator.inputBindings === undefined
        ? {}
        : {
            inputBindings: evaluator.inputBindings.filter((binding) => binding.source.kind !== 'dataset-field'),
          }),
    })),
  };
}

export function reassignEvaluationSuiteTarget(
  suite: EvaluationSuite,
  targetGraphId: EvaluationSuite['targetGraphId'],
): EvaluationSuite {
  return {
    ...suite,
    targetGraphId,
    inputBindings: [],
    // Assertions remain useful when their expected value and operator stay
    // intact, but an output path belongs to the old target graph. Clear it so
    // the editor requires an explicit choice from the newly selected graph.
    assertions: suite.assertions.map((assertion) => ({ ...assertion, outputPath: '' })),
    evaluators: suite.evaluators.map((evaluator) => ({
      ...evaluator,
      ...(evaluator.inputBindings === undefined
        ? {}
        : {
            inputBindings: evaluator.inputBindings.filter((binding) => binding.source.kind !== 'target-output'),
          }),
    })),
  };
}

export function removeEvaluationDatasetField(dataset: EvaluationDataset, fieldId: string): EvaluationDataset {
  return {
    ...dataset,
    fields: dataset.fields.filter((field) => field.id !== fieldId),
    cases: dataset.cases.map((testCase) => {
      const { [fieldId]: _removedValue, ...values } = testCase.values;
      return { ...testCase, values };
    }),
  };
}

export function removeEvaluationDatasetFieldReferences(suite: EvaluationSuite, fieldId: string): EvaluationSuite {
  return {
    ...suite,
    inputBindings: suite.inputBindings.filter((binding) => binding.datasetFieldId !== fieldId),
    assertions: suite.assertions.map((assertion) =>
      assertion.expected.kind === 'dataset-field' && assertion.expected.fieldId === fieldId
        ? { ...assertion, expected: { kind: 'literal' as const, value: null } }
        : assertion,
    ),
    evaluators: suite.evaluators.map((evaluator) => ({
      ...evaluator,
      ...(evaluator.inputBindings === undefined
        ? {}
        : {
            inputBindings: evaluator.inputBindings.filter(
              (binding) => binding.source.kind !== 'dataset-field' || binding.source.fieldId !== fieldId,
            ),
          }),
    })),
  };
}

/** Resolves a dataset from Rivet's application-local evaluation library. */
export function resolveEvaluationDataset(
  datasets: readonly EvaluationDataset[],
  datasetId: string | undefined,
): EvaluationDataset | undefined {
  return datasetId == null ? undefined : datasets.find((dataset) => dataset.id === datasetId);
}

/**
 * Retained for legacy project-owned dataset imports. Application-local
 * datasets omit projectId and are valid for any active project.
 */
export function resolveProjectEvaluationDataset(
  datasets: readonly EvaluationDataset[],
  projectId: ProjectId,
  datasetId: string | undefined,
): EvaluationDataset | undefined {
  return datasetId == null
    ? undefined
    : datasets.find(
        (dataset) => dataset.id === datasetId && (dataset.projectId === undefined || dataset.projectId === projectId),
      );
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
 * Merges a delayed run-store read with the in-memory snapshot published by the
 * active executor. The store read may have begun before the executor wrote its
 * terminal revision, so replacing state with it would make a completed run
 * appear to be running again.
 */
export function mergeEvaluationRunHistory(
  persistedRuns: readonly EvaluationRun[],
  currentRun: EvaluationRun | undefined,
): EvaluationRun[] {
  if (!currentRun) return [...persistedRuns];

  const existingIndex = persistedRuns.findIndex((run) => run.id === currentRun.id);
  if (existingIndex === -1) return [currentRun, ...persistedRuns];

  if (!shouldReplaceEvaluationRun(persistedRuns[existingIndex], currentRun)) return [...persistedRuns];

  return persistedRuns.map((run, index) => (index === existingIndex ? preserveEvaluationRunName(run, currentRun) : run));
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

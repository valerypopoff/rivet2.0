import * as yaml from 'yaml';
import { assertPortableJson } from './canonical.js';
import { normalizeEvaluationBaselineSnapshot } from './normalization.js';
import type { EvaluationProjectData, EvaluationSuite } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return value;
}

function requireString(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be a non-empty string.`);
}

function requireBoolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`);
}

function requireFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`);
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value;
}

function validateOptionalPrimitive(
  record: Record<string, unknown>,
  key: string,
  type: 'string' | 'boolean' | 'number',
  path: string,
): void {
  const value = record[key];
  if (value === undefined) return;
  if (type === 'number') requireFiniteNumber(value, `${path}.${key}`);
  else if (typeof value !== type) throw new Error(`${path}.${key} must be a ${type}.`);
}

const ASSERTION_OPERATORS = new Set([
  'equals',
  'not-equals',
  'contains',
  'matches-regex',
  'type-is',
  'json-schema',
  'number-at-least',
  'number-at-most',
  'number-between',
  'array-includes',
  'set-overlaps',
  'contains-any',
  'contains-all',
]);

function validateSuiteShape(value: unknown, index: number): asserts value is EvaluationSuite {
  const path = `evaluations.suites[${index}]`;
  const suite = requireRecord(value, path);
  for (const key of ['id', 'name', 'targetGraphId', 'datasetId']) requireString(suite[key], `${path}.${key}`);
  for (const [bindingIndex, bindingValue] of requireArray(suite.inputBindings, `${path}.inputBindings`).entries()) {
    const binding = requireRecord(bindingValue, `${path}.inputBindings[${bindingIndex}]`);
    requireString(binding.graphInputId, `${path}.inputBindings[${bindingIndex}].graphInputId`);
    requireString(binding.datasetFieldId, `${path}.inputBindings[${bindingIndex}].datasetFieldId`);
  }
  for (const [assertionIndex, assertionValue] of requireArray(suite.assertions, `${path}.assertions`).entries()) {
    const assertionPath = `${path}.assertions[${assertionIndex}]`;
    const assertion = requireRecord(assertionValue, assertionPath);
    for (const key of ['id', 'name', 'outputPath']) requireString(assertion[key], `${assertionPath}.${key}`);
    if (typeof assertion.operator !== 'string' || !ASSERTION_OPERATORS.has(assertion.operator)) {
      throw new Error(`${assertionPath}.operator is not supported.`);
    }
    validateOptionalPrimitive(assertion, 'required', 'boolean', assertionPath);
    const expected = requireRecord(assertion.expected, `${assertionPath}.expected`);
    if (expected.kind === 'literal') {
      if (!Object.hasOwn(expected, 'value')) throw new Error(`${assertionPath}.expected.value is required.`);
    } else if (expected.kind === 'dataset-field') {
      requireString(expected.fieldId, `${assertionPath}.expected.fieldId`);
    } else {
      throw new Error(`${assertionPath}.expected.kind must be "literal" or "dataset-field".`);
    }
  }
  for (const [evaluatorIndex, evaluatorValue] of requireArray(suite.evaluators, `${path}.evaluators`).entries()) {
    const evaluatorPath = `${path}.evaluators[${evaluatorIndex}]`;
    const evaluator = requireRecord(evaluatorValue, evaluatorPath);
    for (const key of ['id', 'name', 'graphId']) requireString(evaluator[key], `${evaluatorPath}.${key}`);
    validateOptionalPrimitive(evaluator, 'required', 'boolean', evaluatorPath);
    validateOptionalPrimitive(evaluator, 'runOnTargetError', 'boolean', evaluatorPath);
    validateOptionalPrimitive(evaluator, 'scoreWeight', 'number', evaluatorPath);
  }
  if (suite.thresholds !== undefined) {
    for (const [thresholdIndex, thresholdValue] of requireArray(suite.thresholds, `${path}.thresholds`).entries()) {
      const thresholdPath = `${path}.thresholds[${thresholdIndex}]`;
      const threshold = requireRecord(thresholdValue, thresholdPath);
      for (const key of ['id', 'metric', 'operator']) requireString(threshold[key], `${thresholdPath}.${key}`);
      requireFiniteNumber(threshold.value, `${thresholdPath}.value`);
    }
  }
  if (suite.configuration !== undefined) {
    const configuration = requireRecord(suite.configuration, `${path}.configuration`);
    for (const key of ['trialCount', 'concurrency', 'timeoutMs', 'seed']) {
      validateOptionalPrimitive(configuration, key, 'number', `${path}.configuration`);
    }
    validateOptionalPrimitive(configuration, 'seedGraphInputId', 'string', `${path}.configuration`);
    validateOptionalPrimitive(configuration, 'recordingRetention', 'string', `${path}.configuration`);
  }
  validateOptionalPrimitive(suite, 'description', 'string', path);
  if (suite.tags !== undefined) {
    for (const [tagIndex, tag] of requireArray(suite.tags, `${path}.tags`).entries()) {
      requireString(tag, `${path}.tags[${tagIndex}]`);
    }
  }
}

function validateNumericRecord(value: unknown, path: string): void {
  const record = requireRecord(value, path);
  for (const [key, entry] of Object.entries(record)) requireFiniteNumber(entry, `${path}.${key}`);
}

function validateBaselineShape(value: unknown, index: number): void {
  const path = `evaluations.baselines[${index}]`;
  const baseline = requireRecord(value, path);
  for (const key of ['id', 'suiteId', 'createdAt']) requireString(baseline[key], `${path}.${key}`);
  validateOptionalPrimitive(baseline, 'sourceRunId', 'string', path);
  const provenance = requireRecord(baseline.provenance, `${path}.provenance`);
  for (const key of [
    'projectFingerprint',
    'suiteFingerprint',
    'datasetFingerprint',
    'targetFingerprint',
    'executionMode',
  ]) {
    requireString(provenance[key], `${path}.provenance.${key}`);
  }
  const evaluatorFingerprints = requireRecord(
    provenance.evaluatorFingerprints,
    `${path}.provenance.evaluatorFingerprints`,
  );
  for (const [key, fingerprint] of Object.entries(evaluatorFingerprints)) {
    requireString(fingerprint, `${path}.provenance.evaluatorFingerprints.${key}`);
  }
  requireBoolean(provenance.accountingComplete, `${path}.provenance.accountingComplete`);
  const aggregate = requireRecord(baseline.aggregate, `${path}.aggregate`);
  for (const key of [
    'trialCount',
    'passedTrialCount',
    'failedTrialCount',
    'erroredTrialCount',
    'canceledTrialCount',
    'passRate',
    'averageLatencyMs',
    'p95LatencyMs',
    'targetErrorRate',
    'evaluatorErrorRate',
    'toolFailureRate',
  ]) {
    requireFiniteNumber(aggregate[key], `${path}.aggregate.${key}`);
  }
  for (const key of [
    'evaluatedTrialCount',
    'notEvaluatedTrialCount',
    'unableToEvaluateTrialCount',
    'meanScore',
    'totalCostUsd',
    'averageCostUsd',
  ]) {
    validateOptionalPrimitive(aggregate, key, 'number', `${path}.aggregate`);
  }
  validateNumericRecord(aggregate.metrics, `${path}.aggregate.metrics`);
  for (const [caseIndex, caseValue] of requireArray(baseline.cases, `${path}.cases`).entries()) {
    const casePath = `${path}.cases[${caseIndex}]`;
    const caseAggregate = requireRecord(caseValue, casePath);
    requireString(caseAggregate.caseId, `${casePath}.caseId`);
    requireString(caseAggregate.caseName, `${casePath}.caseName`);
    validateNumericRecord(caseAggregate.metrics, `${casePath}.metrics`);
    for (const key of [
      'passRate',
      'meanScore',
      'evaluatedTrialCount',
      'passedTrialCount',
      'failedTrialCount',
      'notEvaluatedTrialCount',
      'unableToEvaluateTrialCount',
      'erroredTrialCount',
      'canceledTrialCount',
    ]) {
      validateOptionalPrimitive(caseAggregate, key, 'number', casePath);
    }
  }
}

export function createEmptyEvaluationProjectData(): EvaluationProjectData {
  return { version: 1, suites: [], baselines: [] };
}

export function serializeEvaluationProjectData(data: EvaluationProjectData): EvaluationProjectData {
  if (data.version !== 1) throw new Error(`Unsupported evaluation data version: ${data.version}`);
  assertPortableJson(data);
  return {
    ...structuredClone(data),
    baselines: data.baselines.map(normalizeEvaluationBaselineSnapshot),
  };
}

export function deserializeEvaluationProjectData(data: unknown): EvaluationProjectData {
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Evaluation project data must be an object.');
  const candidate = data as Partial<EvaluationProjectData>;
  if (candidate.version !== 1 || !Array.isArray(candidate.suites) || !Array.isArray(candidate.baselines)) {
    throw new Error('Unsupported or invalid evaluation project data.');
  }
  assertPortableJson(candidate);
  candidate.suites.forEach(validateSuiteShape);
  candidate.baselines.forEach(validateBaselineShape);
  if (candidate.selectedSuiteId !== undefined) requireString(candidate.selectedSuiteId, 'evaluations.selectedSuiteId');
  if (candidate.selectedDatasetId !== undefined)
    requireString(candidate.selectedDatasetId, 'evaluations.selectedDatasetId');
  return {
    ...structuredClone(candidate as EvaluationProjectData),
    baselines: candidate.baselines.map(normalizeEvaluationBaselineSnapshot),
  };
}

export function serializeEvaluationProjectDataToString(data: EvaluationProjectData): string {
  return yaml.stringify(serializeEvaluationProjectData(data), null, 2);
}

export function deserializeEvaluationProjectDataFromString(data: string): EvaluationProjectData {
  return deserializeEvaluationProjectData(yaml.parse(data));
}

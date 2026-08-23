import {
  evaluateAssertion,
  getEvaluationTopLevelOutputId,
  validateEvaluationAssertionConfiguration,
} from './assertions.js';
import {
  assertPortableJson,
  canonicalStringify,
  clonePortableJson,
  fingerprint,
  fingerprintEvaluationDataset,
} from './canonical.js';
import { normalizeEvaluationRun } from './normalization.js';
import { EvaluationGraphExecutionError } from './types.js';
import { areEvaluationDataTypesCompatible, isEvaluationValueCompatibleWithDataType } from './dataTypes.js';
import type {
  EvaluationAggregate,
  EvaluationBaselineSnapshot,
  EvaluationCaseAggregate,
  EvaluationDataset,
  EvaluationExecutionMetrics,
  EvaluationGraphRunner,
  EvaluationGraphEvaluator,
  EvaluationObservation,
  EvaluationProjectData,
  EvaluationQualityReason,
  EvaluationQualityStatus,
  EvaluationRun,
  EvaluationRunEvent,
  EvaluationRunPurpose,
  EvaluationRunProvenance,
  EvaluationSuite,
  EvaluationSuiteMode,
  EvaluationThreshold,
  EvaluationThresholdResult,
  EvaluationTrial,
  EvaluationTrialExecutionStatus,
  EvaluationRecordingReference,
  PortableJson,
} from './types.js';
import { findAutoDelegateGraphCandidate } from '@valerypopoff/rivet2-core';
import type {
  ChartNode,
  GraphId,
  GraphInputNode,
  GraphOutputNode,
  NodeConnection,
  NodeGraph,
  Project,
} from '@valerypopoff/rivet2-core';

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 32;

export const LEGACY_EVALUATOR_INPUT_IDS = ['case', 'inputs', 'expected', 'outputs', 'run'] as const;

export type RunEvaluationSuiteOptions = {
  project: Project;
  evaluationData: EvaluationProjectData;
  dataset: EvaluationDataset;
  suiteId: string;
  runGraph: EvaluationGraphRunner;
  projectFingerprint?: string;
  executionMode?: string;
  signal?: AbortSignal;
  runId?: string;
  /** An evaluation judges quality; a benchmark deliberately measures execution only. */
  purpose?: EvaluationRunPurpose;
  /** Explicit caller selection; otherwise the suite's saved baseline is used. */
  baseline?: EvaluationBaselineSnapshot;
  /** Incremental live-run transport. Prefer this over onUpdate in new integrations. */
  onEvent?: (event: EvaluationRunEvent) => void | Promise<void>;
  /** @deprecated Prefer onEvent; this clones the complete accumulated run after every trial. */
  onUpdate?: (run: EvaluationRun) => void;
};

export function hasAuthoritativeEvaluationCriteria(suite: EvaluationSuite): boolean {
  if (getEvaluationSuiteMode(suite) === 'scoring') return suite.evaluators.length > 0;
  return (
    suite.assertions.some((assertion) => assertion.required !== false) ||
    suite.evaluators.some((evaluator) => evaluator.required !== false) ||
    (suite.thresholds?.length ?? 0) > 0
  );
}

/** Older saved suites predate scoring and therefore retain pass/fail semantics. */
export function getEvaluationSuiteMode(suite: Pick<EvaluationSuite, 'evaluationMode'>): EvaluationSuiteMode {
  return suite.evaluationMode === 'scoring' ? 'scoring' : 'pass-fail';
}

/** Existing evaluators with the complete reserved-input contract keep working without migration. */
export function usesLegacyEvaluatorInputEnvelope(
  evaluator: Pick<EvaluationGraphEvaluator, 'inputBindings'>,
  graphInputIds: readonly string[],
): boolean {
  return (
    evaluator.inputBindings === undefined &&
    LEGACY_EVALUATOR_INPUT_IDS.every((inputId) => graphInputIds.includes(inputId))
  );
}

/**
 * Shared bounded work scheduler for evaluation adapters that need stable
 * result ordering without serializing independent cases. It deliberately has
 * no retry policy: callers own their authoritative execution semantics.
 *
 * The result array is aligned to `work`; entries that were still queued when
 * the signal was canceled stay `undefined`. Completed work is never erased.
 */
export type RunEvaluationWorkPoolOptions<TWork, TResult> = {
  work: readonly TWork[];
  concurrency: number;
  signal?: AbortSignal;
  execute: (work: TWork, index: number) => Promise<TResult>;
  onSettled?: (result: TResult, index: number, results: readonly (TResult | undefined)[]) => void | Promise<void>;
};

export async function runEvaluationWorkPool<TWork, TResult>(
  options: RunEvaluationWorkPoolOptions<TWork, TResult>,
): Promise<readonly (TResult | undefined)[]> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Evaluation worker-pool concurrency must be a positive safe integer.');
  }
  const results: Array<TResult | undefined> = Array.from({ length: options.work.length });
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      // Do not dequeue a new case after cancellation. Active work receives
      // the same signal and may still settle with useful partial evidence.
      if (options.signal?.aborted) return;
      const index = nextIndex++;
      if (index >= options.work.length) return;
      const work = options.work[index]!;
      const result = await options.execute(work, index);
      results[index] = result;
      await options.onSettled?.(result, index, results);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, options.work.length) }, worker));
  return results;
}

export function createEmptyMetrics(): EvaluationExecutionMetrics {
  return { durationMs: 0 };
}

const executionMetricCountKeys = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'reasoningTokens',
  'modelCallCount',
  'toolCallCount',
  'toolFailureCount',
] as const;

/**
 * Graph runners are host adapters, so their TypeScript return type is not a
 * runtime trust boundary. Copy only the metrics Rivet understands and reject
 * values that would become `null` or otherwise change during JSON storage.
 */
function cloneExecutionMetrics(value: EvaluationExecutionMetrics, path: string): EvaluationExecutionMetrics {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  if (!Number.isFinite(value.durationMs) || value.durationMs < 0) {
    throw new Error(`${path}.durationMs must be a non-negative finite number.`);
  }
  const metrics: EvaluationExecutionMetrics = { durationMs: value.durationMs };
  for (const key of executionMetricCountKeys) {
    const count = value[key];
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${path}.${key} must be a non-negative safe integer.`);
    }
    metrics[key] = count;
  }
  if (value.costUsd !== undefined) {
    if (!Number.isFinite(value.costUsd) || value.costUsd < 0) {
      throw new Error(`${path}.costUsd must be a non-negative finite number.`);
    }
    metrics.costUsd = value.costUsd;
  }
  if (value.hasUnknownCost !== undefined) {
    if (typeof value.hasUnknownCost !== 'boolean') throw new Error(`${path}.hasUnknownCost must be a boolean.`);
    metrics.hasUnknownCost = value.hasUnknownCost;
  }
  return metrics;
}

function tryCloneExecutionMetrics(
  value: EvaluationExecutionMetrics | undefined,
  path: string,
): EvaluationExecutionMetrics | undefined {
  if (value === undefined) return undefined;
  try {
    return cloneExecutionMetrics(value, path);
  } catch {
    return undefined;
  }
}

function cloneOptionalPortableJson(value: PortableJson | undefined, path: string): PortableJson | undefined {
  if (value === undefined) return undefined;
  assertPortableJson(value, path);
  return clonePortableJson(value);
}

function tryCloneOptionalPortableJson(value: PortableJson | undefined, path: string): PortableJson | undefined {
  try {
    return cloneOptionalPortableJson(value, path);
  } catch {
    return undefined;
  }
}

/**
 * Resolves the provisional recording references created while a suite is
 * running into its final retention policy. The caller persists the returned
 * references through its EvaluationRunStore.
 *
 * A successful candidate recording remains promotable for 24 hours by
 * default. Failed/error trials are retained, and `all` pins every artifact.
 * This deliberately operates per trial: one failed case must not pin every
 * otherwise-successful recording in the suite.
 */
export function finalizeEvaluationRecordingRetention(
  run: EvaluationRun,
  policy: 'failures-and-baselines' | 'all' = 'failures-and-baselines',
  now = Date.now(),
): EvaluationRun {
  const retainAll = policy === 'all';
  const finalize = (reference: EvaluationRecordingReference, failed: boolean): EvaluationRecordingReference => {
    const retention: EvaluationRecordingReference['retention'] = retainAll
      ? 'retained'
      : failed
        ? 'failure'
        : 'temporary';
    return {
      id: reference.id,
      retention,
      ...(retention === 'temporary' ? { expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString() } : {}),
    };
  };
  return {
    ...run,
    trials: run.trials.map((trial) => {
      const targetFailed =
        trial.executionStatus !== 'completed' ||
        trial.observations.some(
          (observation) =>
            observation.kind === 'assertion' &&
            observation.required &&
            (observation.status === 'failed' || observation.status === 'error'),
        );
      return {
        ...trial,
        ...(trial.recording === undefined ? {} : { recording: finalize(trial.recording, targetFailed) }),
        observations: trial.observations.map((observation) => ({
          ...observation,
          ...(observation.recording === undefined
            ? {}
            : {
                recording: finalize(
                  observation.recording,
                  observation.status === 'failed' || observation.status === 'error',
                ),
              }),
        })),
      };
    }),
  };
}

function mergeMetrics(...metrics: EvaluationExecutionMetrics[]): EvaluationExecutionMetrics {
  const numberKeys: Array<keyof EvaluationExecutionMetrics> = [
    'durationMs',
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'reasoningTokens',
    'modelCallCount',
    'toolCallCount',
    'toolFailureCount',
    'costUsd',
  ];
  const merged: EvaluationExecutionMetrics = { durationMs: 0 };
  for (const key of numberKeys) {
    const value = metrics.reduce((sum, item) => sum + ((item[key] as number | undefined) ?? 0), 0);
    if (value !== 0 || key === 'durationMs') (merged as Record<string, unknown>)[key] = value;
  }
  if (metrics.some((item) => item.hasUnknownCost)) merged.hasUnknownCost = true;
  return merged;
}

function makeId(prefix: string): string {
  const cryptoValue = globalThis.crypto;
  if (cryptoValue?.randomUUID) return `${prefix}-${cryptoValue.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Evaluation canceled.', 'AbortError');
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError')
  );
}

function resolveSuite(data: EvaluationProjectData, id: string): EvaluationSuite {
  const suite = data.suites.find((candidate) => candidate.id === id);
  if (!suite) throw new Error(`Evaluation suite "${id}" does not exist.`);
  return suite;
}

function validateDefinitionIds(suite: EvaluationSuite): void {
  const seen = new Map<string, string>();
  for (const [kind, definitions] of [
    ['quality check', suite.assertions],
    ['evaluator graph', suite.evaluators],
    ['threshold', suite.thresholds ?? []],
  ] as const) {
    for (const definition of definitions) {
      if (typeof definition.id !== 'string' || definition.id.trim().length === 0) {
        throw new Error(`Every evaluation ${kind} must have a non-empty id.`);
      }
      const previous = seen.get(definition.id);
      if (previous) {
        throw new Error(`Evaluation ${kind} id "${definition.id}" duplicates a ${previous} id.`);
      }
      seen.set(definition.id, kind);
    }
  }
}

const rateThresholdMetrics = new Set([
  'pass-rate',
  'mean-score',
  'target-error-rate',
  'evaluator-error-rate',
  'tool-failure-rate',
]);

function formatThresholdResultValue(metric: string, operator: EvaluationThreshold['operator'], value: number): string {
  return operator === 'max-regression' || rateThresholdMetrics.has(metric)
    ? `${Number((value * 100).toFixed(4))}%`
    : String(value);
}

function validateThresholdConfiguration(threshold: EvaluationThreshold): void {
  const { metric, operator, value } = threshold as EvaluationThreshold & {
    metric: string;
    operator: string;
    value: number;
  };
  if (typeof metric !== 'string' || metric.length === 0) {
    throw new Error(`Evaluation threshold "${threshold.id}" must select a metric.`);
  }
  if (typeof operator !== 'string') {
    throw new Error(`Evaluation threshold "${threshold.id}" must select an operator.`);
  }
  if (!Number.isFinite(value)) throw new Error(`Evaluation threshold "${threshold.id}" must use a finite value.`);

  if (rateThresholdMetrics.has(metric) && (value < 0 || value > 1)) {
    throw new Error(`Evaluation threshold "${threshold.id}" must use a value from 0 to 1.`);
  }
  if (['average-cost', 'total-cost', 'average-latency-ms', 'p95-latency-ms'].includes(metric) && value < 0) {
    throw new Error(`Evaluation threshold "${threshold.id}" cannot use a negative value.`);
  }
  if (operator === 'max-regression') {
    if (value < 0) throw new Error(`Evaluation regression threshold "${threshold.id}" cannot be negative.`);
    return;
  }
  const expectedOperator =
    metric === 'pass-rate' || metric === 'mean-score'
      ? 'at-least'
      : metric.startsWith('custom:')
        ? undefined
        : 'at-most';
  if (
    (expectedOperator !== undefined && operator !== expectedOperator) ||
    (expectedOperator === undefined && operator !== 'at-least' && operator !== 'at-most')
  ) {
    throw new Error(`Evaluation threshold "${threshold.id}" uses an incompatible operator for "${metric}".`);
  }
}

function validateSuite(
  project: Project,
  suite: EvaluationSuite,
  dataset: EvaluationDataset,
  purpose: EvaluationRunPurpose,
): void {
  const evaluationMode = getEvaluationSuiteMode(suite);
  validateDefinitionIds(suite);
  if (dataset.projectId !== undefined && dataset.projectId !== project.metadata.id) {
    throw new Error(`Evaluation dataset "${dataset.name}" belongs to a different project.`);
  }
  if (suite.datasetId !== dataset.id)
    throw new Error(`Suite "${suite.name}" is bound to a different evaluation dataset.`);
  const graph = project.graphs[suite.targetGraphId];
  if (!graph) throw new Error(`Target graph "${suite.targetGraphId}" does not exist.`);
  const graphInputs = graph.nodes.filter((node): node is GraphInputNode => node.type === 'graphInput');
  const graphInputIds = graphInputs.map((input) => input.data.id);
  if (new Set(graphInputIds).size !== graphInputIds.length) {
    throw new Error(`Target graph "${suite.targetGraphId}" has duplicate Graph Input ids.`);
  }
  const graphOutputs = graph.nodes.filter((node): node is GraphOutputNode => node.type === 'graphOutput');
  const graphOutputIds = graphOutputs.map((output) => output.data.id);
  if (new Set(graphOutputIds).size !== graphOutputIds.length) {
    throw new Error(`Target graph "${suite.targetGraphId}" has duplicate Graph Output ids.`);
  }
  const inputIds = new Set(graphInputIds);
  const graphInputsById = new Map(graphInputs.map((input) => [input.data.id, input]));
  const fields = new Map(dataset.fields.map((field) => [field.id, field]));
  if (fields.size !== dataset.fields.length)
    throw new Error(`Evaluation dataset "${dataset.name}" has duplicate field ids.`);
  const boundGraphInputs = new Set<string>();
  for (const binding of suite.inputBindings) {
    if (boundGraphInputs.has(binding.graphInputId)) {
      throw new Error(`Target graph input "${binding.graphInputId}" is bound more than once.`);
    }
    boundGraphInputs.add(binding.graphInputId);
    if (!inputIds.has(binding.graphInputId))
      throw new Error(`Graph input "${binding.graphInputId}" does not exist on the target graph.`);
    const field = fields.get(binding.datasetFieldId);
    if (!field) throw new Error(`Evaluation dataset field "${binding.datasetFieldId}" does not exist.`);
    if (field.role !== 'input')
      throw new Error(`Dataset field "${field.name}" must have the input role to bind it to a graph input.`);
    const graphInput = graphInputsById.get(binding.graphInputId)!;
    if (!areEvaluationDataTypesCompatible(field.dataType, graphInput.data.dataType)) {
      throw new Error(
        `Dataset field "${field.name}" (${field.dataType}) is not compatible with graph input "${graphInput.data.id}" (${graphInput.data.dataType}).`,
      );
    }
  }
  for (const input of graphInputs) {
    if (suite.inputBindings.some((binding) => binding.graphInputId === input.data.id)) continue;
    // A connection-driven default cannot be proven before executing the graph;
    // require an explicit dataset binding in that case instead of quietly
    // fabricating a value from the input data type.
    if (input.data.defaultValue === undefined || input.data.useDefaultValueInput) {
      throw new Error(
        `Target graph input "${input.data.id}" must be bound to an evaluation dataset field or have a static graph default.`,
      );
    }
  }

  // Validate every enabled case before the worker pool starts. The declared
  // field type is part of the dataset contract even when that field is not
  // bound directly to the target graph (for example evaluator metadata).
  for (const testCase of dataset.cases.filter((candidate) => candidate.enabled !== false)) {
    for (const [fieldId, value] of Object.entries(testCase.values)) {
      const field = fields.get(fieldId);
      if (!field) {
        throw new Error(`Case "${testCase.name}" supplies unknown dataset field "${fieldId}".`);
      }
      assertPortableJson(value, `case.${testCase.id}.${fieldId}`);
      if (!isEvaluationValueCompatibleWithDataType(value, field.dataType)) {
        throw new Error(
          `Case "${testCase.name}" value for "${field.name}" is not compatible with its declared ${field.dataType} type.`,
        );
      }
    }
    for (const binding of suite.inputBindings) {
      const value = testCase.values[binding.datasetFieldId];
      if (value === undefined) {
        const field = fields.get(binding.datasetFieldId)!;
        throw new Error(`Case "${testCase.name}" has no saved value for bound input field "${field.name}".`);
      }
      const graphInput = graphInputsById.get(binding.graphInputId)!;
      if (!isEvaluationValueCompatibleWithDataType(value, graphInput.data.dataType)) {
        throw new Error(
          `Case "${testCase.name}" value for "${binding.datasetFieldId}" is not compatible with target graph input "${binding.graphInputId}" (${graphInput.data.dataType}).`,
        );
      }
    }
    for (const field of dataset.fields) {
      const requiredForThisRun = field.required && (purpose === 'evaluation' || field.role === 'input');
      if (requiredForThisRun && testCase.values[field.id] === undefined) {
        throw new Error(`Case "${testCase.name}" is missing required field "${field.name}".`);
      }
    }
  }
  if (purpose === 'evaluation' && evaluationMode === 'pass-fail') {
    for (const assertion of suite.assertions) {
      const outputId = getEvaluationTopLevelOutputId(assertion.outputPath);
      if (assertion.outputPath.trim() !== '$' && outputId === undefined) {
        throw new Error(`Assertion "${assertion.name}" output path must start with a named target Graph Output.`);
      }
      if (outputId !== undefined && !graphOutputIds.includes(outputId)) {
        throw new Error(`Assertion "${assertion.name}" references missing target output "${outputId}".`);
      }
      if (assertion.expected.kind === 'dataset-field') {
        const field = fields.get(assertion.expected.fieldId);
        if (!field) throw new Error(`Assertion "${assertion.name}" references a missing expected dataset field.`);
        if (field.role !== 'expected')
          throw new Error(`Assertion "${assertion.name}" must reference a dataset field with the expected role.`);
        for (const testCase of dataset.cases.filter((candidate) => candidate.enabled !== false)) {
          const expected = testCase.values[field.id];
          if (expected === undefined) {
            throw new Error(`Case "${testCase.name}" is missing expected field "${field.name}".`);
          }
          validateEvaluationAssertionConfiguration(assertion, expected);
        }
      } else {
        validateEvaluationAssertionConfiguration(assertion, assertion.expected.value);
      }
    }
  }
  if (suite.configuration?.seed !== undefined) {
    const seedInputId = suite.configuration.seedGraphInputId;
    if (!seedInputId) throw new Error('A suite seed requires selecting the target graph input that receives it.');
    const seedInput = graphInputsById.get(seedInputId);
    if (!seedInput)
      throw new Error(`The selected seed graph input "${seedInputId}" does not exist on the target graph.`);
    if (seedInput.data.dataType !== 'number' && seedInput.data.dataType !== 'any') {
      throw new Error(`The selected seed graph input "${seedInputId}" must accept a number.`);
    }
    if (suite.inputBindings.some((binding) => binding.graphInputId === seedInputId)) {
      throw new Error(`The selected seed graph input "${seedInputId}" cannot also be bound to a dataset field.`);
    }
  }
  for (const evaluator of purpose === 'evaluation' ? suite.evaluators : []) {
    if (
      evaluator.scoreWeight !== undefined &&
      (!Number.isFinite(evaluator.scoreWeight) || evaluator.scoreWeight <= 0)
    ) {
      throw new Error(`Evaluator graph "${evaluator.name}" score weight must be a positive finite number.`);
    }
    const evaluatorGraph = project.graphs[evaluator.graphId];
    if (!evaluatorGraph) throw new Error(`Evaluator graph "${evaluator.graphId}" does not exist.`);
    const evaluatorGraphInputs = evaluatorGraph.nodes.filter(
      (node): node is GraphInputNode => node.type === 'graphInput',
    );
    const evaluatorInputIds = evaluatorGraphInputs.map((input) => input.data.id);
    if (new Set(evaluatorInputIds).size !== evaluatorInputIds.length) {
      throw new Error(`Evaluator graph "${evaluator.name}" has duplicate Graph Input ids.`);
    }
    const evaluatorOutputIds = evaluatorGraph.nodes
      .filter((node): node is GraphOutputNode => node.type === 'graphOutput')
      .map((output) => output.data.id);
    if (new Set(evaluatorOutputIds).size !== evaluatorOutputIds.length) {
      throw new Error(`Evaluator graph "${evaluator.name}" has duplicate Graph Output ids.`);
    }
    const evaluatorInputsById = new Map(evaluatorGraphInputs.map((input) => [input.data.id, input]));
    const usesLegacyInputs = usesLegacyEvaluatorInputEnvelope(evaluator, evaluatorInputIds);
    if (usesLegacyInputs) {
      for (const inputId of LEGACY_EVALUATOR_INPUT_IDS) {
        const evaluatorInput = evaluatorInputsById.get(inputId)!;
        if (evaluatorInput.data.dataType !== 'object' && evaluatorInput.data.dataType !== 'any') {
          throw new Error(
            `Evaluator graph "${evaluator.name}" legacy input "${inputId}" must accept the object or any data type.`,
          );
        }
      }
      for (const evaluatorInput of evaluatorGraphInputs) {
        if (
          LEGACY_EVALUATOR_INPUT_IDS.includes(evaluatorInput.data.id as (typeof LEGACY_EVALUATOR_INPUT_IDS)[number])
        ) {
          continue;
        }
        if (evaluatorInput.data.defaultValue === undefined || evaluatorInput.data.useDefaultValueInput) {
          throw new Error(
            `Evaluator graph "${evaluator.name}" input "${evaluatorInput.data.id}" needs a direct binding or a static graph default.`,
          );
        }
      }
    } else {
      const evaluatorBindings = evaluator.inputBindings ?? [];
      const boundEvaluatorInputs = new Set<string>();
      for (const binding of evaluatorBindings) {
        if (boundEvaluatorInputs.has(binding.graphInputId)) {
          throw new Error(
            `Evaluator graph "${evaluator.name}" input "${binding.graphInputId}" is bound more than once.`,
          );
        }
        boundEvaluatorInputs.add(binding.graphInputId);
        const evaluatorInput = evaluatorInputsById.get(binding.graphInputId);
        if (!evaluatorInput) {
          throw new Error(
            `Evaluator graph "${evaluator.name}" input "${binding.graphInputId}" does not exist on the selected graph.`,
          );
        }

        let sourceDataType: string;
        if (binding.source.kind === 'dataset-field') {
          const field = fields.get(binding.source.fieldId);
          if (!field) {
            throw new Error(
              `Evaluator graph "${evaluator.name}" binding references missing dataset field "${binding.source.fieldId}".`,
            );
          }
          sourceDataType = field.dataType;
          for (const testCase of dataset.cases.filter((candidate) => candidate.enabled !== false)) {
            const value = testCase.values[field.id];
            if (value === undefined) {
              throw new Error(
                `Case "${testCase.name}" has no saved value for evaluator input "${binding.graphInputId}" from dataset field "${field.name}".`,
              );
            }
            if (!isEvaluationValueCompatibleWithDataType(value, evaluatorInput.data.dataType)) {
              throw new Error(
                `Case "${testCase.name}" value from dataset field "${field.name}" is not compatible with evaluator input "${binding.graphInputId}" (${evaluatorInput.data.dataType}).`,
              );
            }
          }
        } else if (binding.source.kind === 'target-output') {
          const outputId = binding.source.outputId;
          const targetOutput = graph.nodes.find(
            (node): node is GraphOutputNode =>
              node.type === 'graphOutput' && (node.data as { id?: unknown }).id === outputId,
          );
          if (!targetOutput) {
            throw new Error(
              `Evaluator graph "${evaluator.name}" binding references missing target output "${outputId}".`,
            );
          }
          sourceDataType = targetOutput.data.dataType;
        } else if (binding.source.kind === 'context') {
          sourceDataType = 'object';
        } else {
          throw new Error(
            `Evaluator graph "${evaluator.name}" input "${binding.graphInputId}" uses an unsupported source.`,
          );
        }
        if (!areEvaluationDataTypesCompatible(sourceDataType, evaluatorInput.data.dataType)) {
          throw new Error(
            `Evaluator graph "${evaluator.name}" source for input "${binding.graphInputId}" (${sourceDataType}) is not compatible with ${evaluatorInput.data.dataType}.`,
          );
        }
      }
      for (const evaluatorInput of evaluatorGraphInputs) {
        if (boundEvaluatorInputs.has(evaluatorInput.data.id)) continue;
        if (evaluatorInput.data.defaultValue === undefined || evaluatorInput.data.useDefaultValueInput) {
          throw new Error(
            `Evaluator graph "${evaluator.name}" input "${evaluatorInput.data.id}" must be bound to a target output, dataset field, or evaluation context value, or have a static graph default.`,
          );
        }
      }
    }
    const resultOutput = evaluatorGraph.nodes.find(
      (node): node is GraphOutputNode => node.type === 'graphOutput' && (node.data as { id?: unknown }).id === 'result',
    );
    if (!resultOutput) {
      throw new Error(`Evaluator graph "${evaluator.name}" must declare a Graph Output named "result".`);
    }
    if (resultOutput.data.dataType !== 'object' && resultOutput.data.dataType !== 'any') {
      throw new Error(`Evaluator graph "${evaluator.name}" output "result" must have the object data type.`);
    }
  }

  if (purpose === 'evaluation' && evaluationMode === 'pass-fail') {
    const hasRequiredPerTrialCheck =
      suite.assertions.some((assertion) => assertion.required !== false) ||
      suite.evaluators.some((evaluator) => evaluator.required !== false);
    const hasEvaluator = suite.evaluators.length > 0;
    for (const threshold of suite.thresholds ?? []) {
      validateThresholdConfiguration(threshold);
      const metric = threshold.metric;
      const supportedExecutionMetric = [
        'target-error-rate',
        'tool-failure-rate',
        'average-cost',
        'total-cost',
        'average-latency-ms',
        'p95-latency-ms',
      ].includes(metric);
      const supportedEvaluatorMetric =
        metric === 'mean-score' ||
        metric === 'evaluator-error-rate' ||
        (metric.startsWith('custom:') && metric.length > 'custom:'.length);
      if (metric === 'pass-rate' && !hasRequiredPerTrialCheck) {
        throw new Error('A pass-rate threshold requires at least one required quality check or evaluator graph.');
      }
      if (supportedEvaluatorMetric && !hasEvaluator) {
        throw new Error(`The "${metric}" threshold requires at least one evaluator graph.`);
      }
      if (metric !== 'pass-rate' && !supportedExecutionMetric && !supportedEvaluatorMetric) {
        throw new Error(`Evaluation threshold metric "${metric}" is not supported.`);
      }
    }
  } else if (purpose === 'evaluation' && suite.evaluators.length === 0) {
    throw new Error('A scoring evaluation suite requires at least one evaluator graph.');
  }

  const caseIds = new Set(dataset.cases.map((testCase) => testCase.id));
  if (caseIds.size !== dataset.cases.length)
    throw new Error(`Evaluation dataset "${dataset.name}" has duplicate case ids.`);

  if (!dataset.cases.some((testCase) => testCase.enabled !== false)) {
    throw new Error(`Evaluation dataset "${dataset.name}" has no enabled cases.`);
  }

  const configuration = suite.configuration;
  if (
    configuration?.trialCount !== undefined &&
    (!Number.isSafeInteger(configuration.trialCount) || configuration.trialCount < 1)
  ) {
    throw new Error('Evaluation trial count must be a positive safe integer.');
  }
  if (
    configuration?.concurrency !== undefined &&
    (!Number.isSafeInteger(configuration.concurrency) ||
      configuration.concurrency < 1 ||
      configuration.concurrency > MAX_CONCURRENCY)
  ) {
    throw new Error(`Evaluation concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}.`);
  }
  if (
    configuration?.timeoutMs !== undefined &&
    (!Number.isFinite(configuration.timeoutMs) || configuration.timeoutMs <= 0)
  ) {
    throw new Error('Evaluation timeout must be a positive number of milliseconds.');
  }
  if (configuration?.seed !== undefined && (!Number.isSafeInteger(configuration.seed) || configuration.seed < 0)) {
    throw new Error('Evaluation seed must be a non-negative safe integer.');
  }
}

function resolveCaseInputs(
  suite: EvaluationSuite,
  dataset: EvaluationDataset,
  testCase: EvaluationDataset['cases'][number],
  purpose: EvaluationRunPurpose,
): {
  inputs: Record<string, PortableJson>;
  expected: Record<string, PortableJson>;
} {
  const fields = new Map(dataset.fields.map((field) => [field.id, field]));
  const inputs: Record<string, PortableJson> = {};
  const expected: Record<string, PortableJson> = {};
  for (const field of dataset.fields) {
    const value = testCase.values[field.id];
    if (value === undefined) {
      const requiredForThisRun = field.required && (purpose === 'evaluation' || field.role === 'input');
      if (requiredForThisRun) {
        throw new Error(`Case "${testCase.name}" is missing required field "${field.name}".`);
      }
      continue;
    }
    assertPortableJson(value, `case.${field.id}`);
    if (field.role === 'expected') expected[field.id] = clonePortableJson(value);
  }
  for (const binding of suite.inputBindings) {
    const field = fields.get(binding.datasetFieldId)!;
    const value = testCase.values[field.id];
    if (value === undefined) {
      throw new Error(`Case "${testCase.name}" has no saved value for bound input field "${field.name}".`);
    }
    if (!isEvaluationValueCompatibleWithDataType(value, field.dataType)) {
      throw new Error(
        `Case "${testCase.name}" input "${field.name}" is not compatible with its declared ${field.dataType} type.`,
      );
    }
    inputs[binding.graphInputId] = clonePortableJson(value);
  }
  return { inputs, expected };
}

/**
 * Evaluators need the case identity and tags as well as its field values. Do
 * not pass the mutable dataset case object itself: this portable snapshot is
 * the stable evaluator-graph contract for a particular trial.
 */
function createEvaluatorCaseInput(testCase: EvaluationDataset['cases'][number]): PortableJson {
  return {
    id: testCase.id,
    name: testCase.name,
    enabled: testCase.enabled !== false,
    ...(testCase.tags === undefined ? {} : { tags: [...testCase.tags] }),
    ...(testCase.note === undefined ? {} : { note: testCase.note }),
    values: clonePortableJson(testCase.values),
  };
}

function createEvaluatorGraphInputs(input: {
  evaluator: EvaluationGraphEvaluator;
  project: Project;
  testCase: EvaluationDataset['cases'][number];
  targetInputs: Record<string, PortableJson>;
  expected: Record<string, PortableJson>;
  targetOutputs: Record<string, PortableJson>;
  run: PortableJson;
}): Record<string, PortableJson> {
  const { evaluator, project, testCase, targetInputs, expected, targetOutputs, run } = input;
  const contextValues = {
    case: createEvaluatorCaseInput(testCase),
    inputs: clonePortableJson(targetInputs),
    expected: clonePortableJson(expected),
    outputs: clonePortableJson(targetOutputs),
    run: clonePortableJson(run),
  } satisfies Record<(typeof LEGACY_EVALUATOR_INPUT_IDS)[number], PortableJson>;
  const evaluatorGraphInputs =
    project.graphs[evaluator.graphId]?.nodes.filter((node): node is GraphInputNode => node.type === 'graphInput') ?? [];
  const evaluatorGraphInputIds = evaluatorGraphInputs.map((node) => node.data.id);
  if (usesLegacyEvaluatorInputEnvelope(evaluator, evaluatorGraphInputIds)) return contextValues;
  const evaluatorInputsById = new Map(evaluatorGraphInputs.map((node) => [node.data.id, node]));

  const evaluatorInputs: Record<string, PortableJson> = {};
  for (const binding of evaluator.inputBindings ?? []) {
    if (binding.source.kind === 'dataset-field') {
      const value = testCase.values[binding.source.fieldId];
      if (value === undefined) {
        throw new Error(
          `Case "${testCase.name}" has no value for evaluator input "${binding.graphInputId}" from dataset field "${binding.source.fieldId}".`,
        );
      }
      evaluatorInputs[binding.graphInputId] = clonePortableJson(value);
    } else if (binding.source.kind === 'target-output') {
      if (!Object.hasOwn(targetOutputs, binding.source.outputId)) {
        throw new Error(
          `Target graph did not produce output "${binding.source.outputId}" required by evaluator input "${binding.graphInputId}".`,
        );
      }
      const targetOutputValue = targetOutputs[binding.source.outputId]!;
      const evaluatorInput = evaluatorInputsById.get(binding.graphInputId);
      if (evaluatorInput && !isEvaluationValueCompatibleWithDataType(targetOutputValue, evaluatorInput.data.dataType)) {
        throw new Error(
          `Target output "${binding.source.outputId}" is not compatible with evaluator input "${binding.graphInputId}" (${evaluatorInput.data.dataType}).`,
        );
      }
      evaluatorInputs[binding.graphInputId] = clonePortableJson(targetOutputValue);
    } else if (binding.source.kind === 'context') {
      evaluatorInputs[binding.graphInputId] = clonePortableJson(contextValues[binding.source.context]);
    } else {
      throw new Error(`Evaluator input "${binding.graphInputId}" uses an unsupported source.`);
    }
  }
  return evaluatorInputs;
}

function hashStableText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function deriveSeed(seed: number | undefined, caseId: string, trialIndex: number): number | undefined {
  if (seed == null) return undefined;
  let value = seed >>> 0;
  value = Math.imul(value ^ hashStableText(caseId), 0x45d9f3b);
  value = Math.imul(value ^ (trialIndex + 1), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function normalizeEvaluatorResult(value: PortableJson, evaluationMode: EvaluationSuiteMode): EvaluationObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Evaluator graph output "result" must be an object.');
  }
  if (evaluationMode === 'pass-fail' && typeof value.passed !== 'boolean') {
    throw new Error('Evaluator graph output "result.passed" must be a boolean.');
  }
  const score = value.score;
  if (
    (evaluationMode === 'scoring' || score !== undefined) &&
    (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100)
  ) {
    throw new Error(
      'Evaluator graph output "result.score" must be a number from 0 to 100 (for example, return 85 for 85/100).',
    );
  }
  if (value.message !== undefined && typeof value.message !== 'string') {
    throw new Error('Evaluator graph output "result.message" must be a string.');
  }
  if (
    value.metrics !== undefined &&
    (typeof value.metrics !== 'object' || value.metrics === null || Array.isArray(value.metrics))
  ) {
    throw new Error('Evaluator graph output "result.metrics" must be an object.');
  }
  const metrics = value.metrics as Record<string, PortableJson> | undefined;
  if (metrics && Object.values(metrics).some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new Error('Evaluator graph output "result.metrics" values must be finite numbers.');
  }
  if (value.evidence !== undefined) assertPortableJson(value.evidence, 'evaluator result.evidence');
  return {
    id: '',
    kind: 'graph',
    name: '',
    required: true,
    status: evaluationMode === 'scoring' ? 'scored' : value.passed ? 'passed' : 'failed',
    // Evaluator authors use the same 100-point scale shown by the UI. Runs
    // retain normalized values so historical aggregation and thresholds stay
    // backward compatible with existing evaluation records.
    ...(typeof score === 'number' ? { score: score / 100 } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(value.evidence !== undefined ? { evidence: clonePortableJson(value.evidence) } : {}),
    ...(metrics ? { metrics: clonePortableJson(metrics) as Record<string, number> } : {}),
  };
}

async function runWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  outer?: AbortSignal,
): Promise<T> {
  throwIfAborted(outer);
  const controller = new AbortController();
  let rejectCanceled: ((reason: unknown) => void) | undefined;
  const canceled = new Promise<never>((_, reject) => {
    rejectCanceled = reject;
  });
  const abort = () => {
    const error = outer?.reason ?? new DOMException('Evaluation canceled.', 'AbortError');
    controller.abort(error);
    rejectCanceled?.(error);
  };
  outer?.addEventListener('abort', abort, { once: true });
  // `throwIfAborted` above covers the common case. This second check closes
  // the narrow race where the caller aborts while this timeout wrapper is
  // installing its listener, before the adapter has been started.
  if (outer?.aborted) {
    outer.removeEventListener('abort', abort);
    throw outer.reason ?? new DOMException('Evaluation canceled.', 'AbortError');
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timeoutPromise: Promise<never> | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new DOMException('Evaluation trial timed out.', 'TimeoutError');
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
  }
  const execution = run(controller.signal);
  try {
    return await Promise.race([execution, canceled, ...(timeoutPromise ? [timeoutPromise] : [])]);
  } finally {
    if (timeout) clearTimeout(timeout);
    outer?.removeEventListener('abort', abort);
  }
}

async function runTrial(input: {
  project: Project;
  suite: EvaluationSuite;
  dataset: EvaluationDataset;
  purpose: EvaluationRunPurpose;
  testCase: EvaluationDataset['cases'][number];
  caseIndex: number;
  trialIndex: number;
  runId: string;
  runGraph: EvaluationGraphRunner;
  signal?: AbortSignal;
}): Promise<EvaluationTrial> {
  const { project, suite, dataset, purpose, testCase, caseIndex, trialIndex, runId, runGraph, signal } = input;
  const evaluationMode = getEvaluationSuiteMode(suite);
  const { inputs, expected } = resolveCaseInputs(suite, dataset, testCase, purpose);
  const seed = deriveSeed(suite.configuration?.seed, testCase.id, trialIndex);
  if (seed !== undefined && suite.configuration?.seedGraphInputId) inputs[suite.configuration.seedGraphInputId] = seed;
  const metadata = {
    evaluationRunId: runId,
    suiteId: suite.id,
    caseId: testCase.id,
    trialIndex,
    phase: 'target' as const,
  };
  let targetMetrics = createEmptyMetrics();
  let evaluatorMetrics = createEmptyMetrics();
  let outputs: Record<string, PortableJson> = {};
  let targetError: string | undefined;
  let recording: EvaluationTrial['recording'];
  let targetProviderAttempts: EvaluationTrial['targetProviderAttempts'];
  const targetStartedAt = Date.now();
  try {
    throwIfAborted(signal);
    const target = await runWithTimeout(
      (attemptSignal) => runGraph({ project, graphId: suite.targetGraphId, inputs, signal: attemptSignal, metadata }),
      suite.configuration?.timeoutMs,
      signal,
    );
    targetMetrics = cloneExecutionMetrics(target.metrics, 'target metrics');
    assertPortableJson(target.outputs, 'target outputs');
    outputs = clonePortableJson(target.outputs);
    recording = target.recording === undefined ? undefined : structuredClone(target.recording);
    targetProviderAttempts = cloneOptionalPortableJson(target.providerAttempts, 'target provider attempts');
  } catch (error) {
    if (error instanceof EvaluationGraphExecutionError) {
      const errorMetrics = tryCloneExecutionMetrics(error.metrics, 'target error metrics');
      targetMetrics = errorMetrics ?? { ...targetMetrics, hasUnknownCost: true };
      recording = error.recording === undefined ? undefined : structuredClone(error.recording);
      targetProviderAttempts = tryCloneOptionalPortableJson(error.providerAttempts, 'target error provider attempts');
    } else {
      // A plain adapter failure does not prove that no priced provider work
      // happened before the error. Do not report authoritative zero cost.
      targetMetrics = { ...targetMetrics, hasUnknownCost: true };
    }
    targetError = toErrorMessage(error);
    targetMetrics = { ...targetMetrics, durationMs: Math.max(targetMetrics.durationMs, Date.now() - targetStartedAt) };
    if (isAbort(error) || signal?.aborted) {
      const executionStatus = 'canceled' as const;
      const qualityStatus = 'not-evaluated' as const;
      return {
        id: makeId('trial'),
        caseId: testCase.id,
        caseName: testCase.name,
        caseIndex,
        trialIndex,
        executionStatus,
        qualityStatus,
        qualityReason: { code: 'canceled', message: 'The evaluation trial was canceled.' },
        inputs,
        expected,
        outputs,
        observations: [],
        targetMetrics,
        evaluatorMetrics,
        totalMetrics: { ...mergeMetrics(targetMetrics, evaluatorMetrics), hasUnknownCost: true },
        error: targetError,
        ...(seed === undefined ? {} : { seed }),
        ...(recording === undefined ? {} : { recording }),
        ...(targetProviderAttempts === undefined ? {} : { targetProviderAttempts }),
      };
    }
  }

  const observations: EvaluationObservation[] = [];
  if (purpose === 'evaluation' && targetError) {
    observations.push({
      id: 'target-error',
      kind: 'assertion',
      name: 'Target graph',
      required: true,
      status: 'error',
      message: targetError,
    });
  } else if (purpose === 'evaluation' && evaluationMode === 'pass-fail') {
    for (const assertion of suite.assertions) {
      try {
        observations.push(evaluateAssertion(assertion, outputs, testCase));
      } catch (error) {
        observations.push({
          id: assertion.id,
          kind: 'assertion',
          name: assertion.name,
          required: assertion.required !== false,
          status: 'error',
          message: toErrorMessage(error),
        });
      }
    }
  }

  for (const evaluator of purpose === 'evaluation' ? suite.evaluators : []) {
    if (targetError && (evaluationMode === 'scoring' || !evaluator.runOnTargetError)) {
      observations.push({
        id: evaluator.id,
        kind: 'graph',
        name: evaluator.name,
        required: evaluator.required !== false,
        status: 'skipped',
        message: 'Skipped because the target graph failed.',
      });
      continue;
    }
    const start = Date.now();
    let completedAttemptMetrics: EvaluationExecutionMetrics | undefined;
    let completedAttemptRecording: EvaluationRecordingReference | undefined;
    let completedAttemptProviderAttempts: PortableJson | undefined;
    try {
      const result = await runWithTimeout(
        (attemptSignal) =>
          runGraph({
            project,
            graphId: evaluator.graphId,
            inputs: createEvaluatorGraphInputs({
              evaluator,
              project,
              testCase,
              targetInputs: inputs,
              expected,
              targetOutputs: outputs,
              run: { targetError: targetError ?? null, caseIndex, trialIndex, seed: seed ?? null },
            }),
            signal: attemptSignal,
            metadata: { ...metadata, phase: 'evaluator' },
          }),
        suite.configuration?.timeoutMs,
        signal,
      );
      completedAttemptMetrics = cloneExecutionMetrics(result.metrics, `evaluator ${evaluator.name} metrics`);
      completedAttemptRecording = result.recording === undefined ? undefined : structuredClone(result.recording);
      completedAttemptProviderAttempts = cloneOptionalPortableJson(
        result.providerAttempts,
        `evaluator ${evaluator.name} provider attempts`,
      );
      evaluatorMetrics = mergeMetrics(evaluatorMetrics, completedAttemptMetrics);
      assertPortableJson(result.outputs, `evaluator ${evaluator.name} outputs`);
      const observation = normalizeEvaluatorResult(result.outputs.result ?? null, evaluationMode);
      observations.push({
        ...observation,
        id: evaluator.id,
        name: evaluator.name,
        required: evaluator.required !== false,
        scoreWeight: evaluator.scoreWeight ?? 1,
        durationMs: completedAttemptMetrics.durationMs || Date.now() - start,
        ...(completedAttemptMetrics.costUsd === undefined ? {} : { costUsd: completedAttemptMetrics.costUsd }),
        ...(completedAttemptProviderAttempts === undefined
          ? {}
          : { providerAttempts: completedAttemptProviderAttempts }),
        ...(completedAttemptRecording === undefined ? {} : { recording: completedAttemptRecording }),
      });
    } catch (error) {
      const executionError = error instanceof EvaluationGraphExecutionError ? error : undefined;
      const executionErrorMetrics = tryCloneExecutionMetrics(
        executionError?.metrics,
        `evaluator ${evaluator.name} error metrics`,
      );
      const failureMetrics = executionErrorMetrics ?? completedAttemptMetrics;
      const failureProviderAttempts =
        tryCloneOptionalPortableJson(
          executionError?.providerAttempts,
          `evaluator ${evaluator.name} error provider attempts`,
        ) ?? completedAttemptProviderAttempts;
      const failureRecording =
        executionError?.recording === undefined ? completedAttemptRecording : structuredClone(executionError.recording);
      if (executionErrorMetrics) {
        // A failed judge is still a physical graph execution. Its latency,
        // tokens, and cost must remain part of the run rather than vanishing
        // just because the evaluator did not return a valid result object.
        evaluatorMetrics = mergeMetrics(evaluatorMetrics, executionErrorMetrics);
      } else if (!completedAttemptMetrics) {
        // Generic adapter failures and runner timeouts do not carry an
        // EvaluationGraphExecutionError payload. Their elapsed time is still
        // physical evaluator work and must remain visible in run metrics.
        evaluatorMetrics = mergeMetrics(evaluatorMetrics, {
          durationMs: Date.now() - start,
          hasUnknownCost: true,
        });
      }
      if (isAbort(error) || signal?.aborted) {
        const executionStatus = 'canceled' as const;
        const qualityStatus = 'not-evaluated' as const;
        return {
          id: makeId('trial'),
          caseId: testCase.id,
          caseName: testCase.name,
          caseIndex,
          trialIndex,
          executionStatus,
          qualityStatus,
          qualityReason: { code: 'canceled', message: 'The evaluation trial was canceled.' },
          inputs,
          expected,
          outputs,
          observations,
          targetMetrics,
          evaluatorMetrics,
          totalMetrics: { ...mergeMetrics(targetMetrics, evaluatorMetrics), hasUnknownCost: true },
          error: toErrorMessage(error),
          ...(seed === undefined ? {} : { seed }),
          ...(recording === undefined ? {} : { recording }),
          ...(targetProviderAttempts === undefined ? {} : { targetProviderAttempts }),
        };
      }
      observations.push({
        id: evaluator.id,
        kind: 'graph',
        name: evaluator.name,
        required: evaluator.required !== false,
        status: 'error',
        message: toErrorMessage(error),
        durationMs: failureMetrics?.durationMs ?? Date.now() - start,
        ...(failureMetrics?.costUsd === undefined ? {} : { costUsd: failureMetrics.costUsd }),
        ...(failureProviderAttempts === undefined ? {} : { providerAttempts: failureProviderAttempts }),
        ...(failureRecording === undefined ? {} : { recording: failureRecording }),
      });
    }
  }

  const required = observations.filter((entry) => entry.required);
  const executionStatus: EvaluationTrialExecutionStatus = targetError === undefined ? 'completed' : 'error';
  let qualityStatus: EvaluationQualityStatus;
  let qualityReason: EvaluationQualityReason;
  if (purpose === 'execution-benchmark') {
    qualityStatus = 'not-evaluated';
    qualityReason = {
      code: 'benchmark',
      message: 'This trial measured execution without evaluating output quality.',
    };
  } else if (evaluationMode === 'scoring') {
    const scoringObservations = observations.filter((entry) => entry.kind === 'graph');
    const hasCompleteScore =
      targetError === undefined &&
      scoringObservations.length === suite.evaluators.length &&
      scoringObservations.every((entry) => entry.status === 'scored' && entry.score !== undefined);
    if (hasCompleteScore) {
      qualityStatus = 'scored';
      qualityReason = { code: 'scores-complete', message: 'All evaluator graphs returned a score for this trial.' };
    } else {
      qualityStatus = 'unable-to-evaluate';
      qualityReason = {
        code: 'scores-incomplete',
        message:
          targetError === undefined
            ? 'One or more evaluator graphs did not return a usable score for this trial.'
            : 'The target graph failed, so this trial could not contribute a score.',
      };
    }
  } else if (targetError !== undefined) {
    qualityStatus = 'failed';
    qualityReason = {
      code: 'target-error',
      message: 'The target graph failed before it could produce a valid result.',
    };
  } else if (required.some((entry) => entry.status === 'failed')) {
    qualityStatus = 'failed';
    qualityReason = { code: 'checks-failed', message: 'One or more required quality checks failed.' };
  } else if (required.some((entry) => entry.status === 'error')) {
    qualityStatus = 'unable-to-evaluate';
    qualityReason = {
      code: 'required-check-error',
      message: 'A required quality check could not be evaluated.',
    };
  } else if (required.some((entry) => entry.status === 'passed')) {
    qualityStatus = 'passed';
    qualityReason = { code: 'checks-passed', message: 'All required per-trial quality checks passed.' };
  } else {
    qualityStatus = 'not-evaluated';
    qualityReason = {
      code: 'no-trial-quality-checks',
      message: 'No required per-trial quality check evaluated this result.',
    };
  }
  const totalMetrics = mergeMetrics(targetMetrics, evaluatorMetrics);
  return {
    id: makeId('trial'),
    caseId: testCase.id,
    caseName: testCase.name,
    caseIndex,
    trialIndex,
    executionStatus,
    qualityStatus,
    qualityReason,
    inputs,
    expected,
    outputs,
    observations,
    targetMetrics,
    evaluatorMetrics,
    totalMetrics,
    ...(targetError === undefined ? {} : { error: targetError }),
    ...(seed === undefined ? {} : { seed }),
    ...(recording === undefined ? {} : { recording }),
    ...(targetProviderAttempts === undefined ? {} : { targetProviderAttempts }),
  };
}

function percentile(values: number[], percentage: number): number {
  if (values.length === 0) return 0;
  const ordered = values.slice().sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil((percentage / 100) * ordered.length) - 1)]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = values.slice().sort((left, right) => left - right);
  const upperIndex = Math.floor(ordered.length / 2);
  if (ordered.length % 2 !== 0) return ordered[upperIndex]!;
  return (ordered[upperIndex - 1]! + ordered[upperIndex]!) / 2;
}

function meanObservationScore(observations: readonly EvaluationObservation[]): number | undefined {
  let weightedScore = 0;
  let totalWeight = 0;
  for (const observation of observations) {
    if (observation.score === undefined) continue;
    // Assertions do not currently produce scores. The fallback preserves
    // compatibility with old recordings and evaluators that predate weights.
    const weight = observation.scoreWeight ?? 1;
    weightedScore += observation.score * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? undefined : weightedScore / totalWeight;
}

function meanObservationMetrics(observations: readonly EvaluationObservation[]): Record<string, number> {
  const totals: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const observation of observations) {
    for (const [name, value] of Object.entries(observation.metrics ?? {})) {
      totals[name] = (totals[name] ?? 0) + value;
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([name, total]) => [name, total / counts[name]!]));
}

function aggregate(
  trials: EvaluationTrial[],
  evaluationMode: EvaluationSuiteMode = 'pass-fail',
): { aggregate: EvaluationAggregate; cases: EvaluationCaseAggregate[] } {
  const incurred = trials;
  const settled = trials.filter((trial) => trial.executionStatus !== 'canceled');
  const completed = trials.filter((trial) => trial.executionStatus === 'completed');
  const evaluated = completed.filter((trial) => trial.qualityStatus === 'passed' || trial.qualityStatus === 'failed');
  const passed = evaluated.filter((trial) => trial.qualityStatus === 'passed');
  const failed = evaluated.filter((trial) => trial.qualityStatus === 'failed');
  const notEvaluated = completed.filter((trial) => trial.qualityStatus === 'not-evaluated');
  const unable = completed.filter((trial) => trial.qualityStatus === 'unable-to-evaluate');
  const errors = trials.filter((trial) => trial.executionStatus === 'error');
  const canceled = trials.filter((trial) => trial.executionStatus === 'canceled');
  // Canceled work can have partial observations and accounting. It remains
  // inspectable in the run, but must not distort completed-run quality or cost
  // thresholds.
  const settledObservations = settled.flatMap((trial) => trial.observations);
  const meanScore = meanObservationScore(settledObservations);
  const accountingComplete = !incurred.some((trial) => trial.totalMetrics.hasUnknownCost);
  const totalCostUsd = accountingComplete
    ? incurred.reduce((sum, trial) => sum + (trial.totalMetrics.costUsd ?? 0), 0)
    : undefined;
  // Evaluator metrics are per-observation measurements. Aggregating them as
  // a mean keeps a `0..1` quality score meaningful as trial count changes;
  // an evaluator that needs a total can return it as an explicit metric.
  const meanMetrics = meanObservationMetrics(settledObservations);
  const byCase = new Map<string, EvaluationTrial[]>();
  for (const trial of trials) byCase.set(trial.caseId, [...(byCase.get(trial.caseId) ?? []), trial]);
  const cases = Array.from(byCase.values()).map((caseTrials): EvaluationCaseAggregate => {
    const caseSettled = caseTrials.filter((trial) => trial.executionStatus !== 'canceled');
    const caseCompleted = caseSettled.filter((trial) => trial.executionStatus === 'completed');
    const caseEvaluated = caseCompleted.filter(
      (trial) => trial.qualityStatus === 'passed' || trial.qualityStatus === 'failed',
    );
    const casePassed = caseEvaluated.filter((trial) => trial.qualityStatus === 'passed');
    const caseFailed = caseEvaluated.filter((trial) => trial.qualityStatus === 'failed');
    const caseScored = caseCompleted.filter((trial) => trial.qualityStatus === 'scored');
    const caseObservations = caseSettled.flatMap((trial) => trial.observations);
    // A scoring trial has already proved every configured evaluator produced
    // a score. Average evaluators within a trial first, then average those
    // trials, so each case gets equal weight regardless of its evaluator set.
    const caseTrialScores = caseScored
      .map((trial) => meanObservationScore(trial.observations))
      .filter((score): score is number => score !== undefined);
    const caseMeanScore =
      evaluationMode === 'scoring'
        ? caseTrialScores.length === 0
          ? undefined
          : caseTrialScores.reduce((sum, score) => sum + score, 0) / caseTrialScores.length
        : meanObservationScore(caseObservations);
    return {
      caseId: caseTrials[0]!.caseId,
      caseName: caseTrials[0]!.caseName,
      ...(caseEvaluated.length === 0 ? {} : { passRate: casePassed.length / caseEvaluated.length }),
      evaluatedTrialCount: caseEvaluated.length,
      passedTrialCount: casePassed.length,
      failedTrialCount: caseFailed.length,
      notEvaluatedTrialCount: caseCompleted.filter((trial) => trial.qualityStatus === 'not-evaluated').length,
      unableToEvaluateTrialCount: caseCompleted.filter((trial) => trial.qualityStatus === 'unable-to-evaluate').length,
      erroredTrialCount: caseTrials.filter((trial) => trial.executionStatus === 'error').length,
      canceledTrialCount: caseTrials.filter((trial) => trial.executionStatus === 'canceled').length,
      ...(evaluationMode === 'scoring'
        ? {
            scoredTrialCount: caseScored.length,
            missingScoreTrialCount: caseTrials.length - caseScored.length,
          }
        : {}),
      ...(caseMeanScore === undefined ? {} : { meanScore: caseMeanScore }),
      metrics: meanObservationMetrics(caseObservations),
    };
  });
  const scoredTrialCount = cases.reduce((sum, testCase) => sum + (testCase.scoredTrialCount ?? 0), 0);
  const scoringCaseMeans = cases
    .map((testCase) => testCase.meanScore)
    .filter((score): score is number => score !== undefined);
  const scoringMeanScore =
    scoringCaseMeans.length === 0
      ? undefined
      : scoringCaseMeans.reduce((sum, score) => sum + score, 0) / scoringCaseMeans.length;
  const incurredLatencies = incurred.map((trial) => trial.totalMetrics.durationMs);
  const aggregateValue: EvaluationAggregate = {
    trialCount: trials.length,
    evaluatedTrialCount: evaluated.length,
    notEvaluatedTrialCount: notEvaluated.length,
    unableToEvaluateTrialCount: unable.length,
    passedTrialCount: passed.length,
    failedTrialCount: failed.length,
    erroredTrialCount: errors.length,
    canceledTrialCount: canceled.length,
    passRate: evaluated.length === 0 ? 0 : passed.length / evaluated.length,
    ...(evaluationMode === 'scoring'
      ? {
          scoredTrialCount,
          missingScoreTrialCount: trials.length - scoredTrialCount,
          ...(scoringMeanScore === undefined ? {} : { meanScore: scoringMeanScore }),
          ...(scoringCaseMeans.length === 0
            ? {}
            : {
                medianScore: median(scoringCaseMeans),
                p95Score: percentile(scoringCaseMeans, 95),
              }),
        }
      : meanScore === undefined
        ? {}
        : { meanScore }),
    averageLatencyMs:
      incurred.length === 0 ? 0 : incurredLatencies.reduce((sum, durationMs) => sum + durationMs, 0) / incurred.length,
    medianLatencyMs: median(incurredLatencies),
    p95LatencyMs: percentile(incurredLatencies, 95),
    ...(incurred.length === 0 || totalCostUsd === undefined
      ? {}
      : { totalCostUsd, averageCostUsd: totalCostUsd / incurred.length }),
    targetErrorRate: settled.length === 0 ? 0 : errors.length / settled.length,
    evaluatorErrorRate:
      settled.length === 0
        ? 0
        : settled.filter((trial) =>
            trial.observations.some((observation) => observation.kind === 'graph' && observation.status === 'error'),
          ).length / settled.length,
    toolFailureRate:
      settled.reduce((sum, trial) => sum + (trial.totalMetrics.toolCallCount ?? 0), 0) === 0
        ? 0
        : settled.reduce((sum, trial) => sum + (trial.totalMetrics.toolFailureCount ?? 0), 0) /
          settled.reduce((sum, trial) => sum + (trial.totalMetrics.toolCallCount ?? 0), 0),
    metrics: meanMetrics,
  };
  return {
    aggregate: aggregateValue,
    cases,
  };
}

function thresholdValue(aggregateValue: EvaluationAggregate, metric: string): number | undefined {
  switch (metric) {
    case 'pass-rate':
      return aggregateValue.evaluatedTrialCount === 0 ? undefined : aggregateValue.passRate;
    case 'mean-score':
      return aggregateValue.meanScore;
    case 'target-error-rate':
      return aggregateValue.targetErrorRate;
    case 'evaluator-error-rate':
      return aggregateValue.evaluatorErrorRate;
    case 'tool-failure-rate':
      return aggregateValue.toolFailureRate;
    case 'average-cost':
      return aggregateValue.averageCostUsd;
    case 'total-cost':
      return aggregateValue.totalCostUsd;
    case 'average-latency-ms':
      return aggregateValue.averageLatencyMs;
    case 'p95-latency-ms':
      return aggregateValue.p95LatencyMs;
    default:
      return metric.startsWith('custom:') ? aggregateValue.metrics[metric.slice('custom:'.length)] : undefined;
  }
}

function isHigherBetterMetric(metric: string): boolean {
  return metric === 'pass-rate' || metric === 'mean-score' || metric.startsWith('custom:');
}

function baselineCompatible(current: EvaluationRunProvenance, baseline: EvaluationBaselineSnapshot): boolean {
  return (
    current.executionMode === baseline.provenance.executionMode &&
    current.suiteFingerprint === baseline.provenance.suiteFingerprint &&
    current.datasetFingerprint === baseline.provenance.datasetFingerprint &&
    current.targetFingerprint === baseline.provenance.targetFingerprint &&
    canonicalStringify(current.evaluatorFingerprints) === canonicalStringify(baseline.provenance.evaluatorFingerprints)
  );
}

/**
 * Project-level values which can change a graph execution even though no node
 * or connection changed. Deliberately omit cosmetic metadata (title,
 * description, path, main-graph selection) and UI graphs: changing those must
 * not invalidate an otherwise comparable baseline.
 */
function executionNodeConfiguration(node: ChartNode): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    data: node.data,
    variants: node.variants,
    isSplitRun: node.isSplitRun,
    isSplitSequential: node.isSplitSequential,
    splitRunMax: node.splitRunMax,
    splitRunConcurrency: node.splitRunConcurrency,
    disabled: node.disabled,
    isConditional: node.isConditional,
  };
}

function executionConnectionConfiguration(connection: NodeConnection): Record<string, unknown> {
  return {
    outputNodeId: connection.outputNodeId,
    inputNodeId: connection.inputNodeId,
    outputId: connection.outputId,
    inputId: connection.inputId,
  };
}

function executionGraphConfiguration(graph: NodeGraph): Record<string, unknown> {
  return {
    metadata: {
      id: graph.metadata?.id,
      name: graph.metadata?.name,
      attachedData: graph.metadata?.attachedData,
    },
    nodes: graph.nodes.map(executionNodeConfiguration),
    connections: graph.connections.map(executionConnectionConfiguration),
  };
}

function executionProjectGraphs(project: Project): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(project.graphs).map(([graphId, graph]) => [graphId, executionGraphConfiguration(graph)]),
  );
}

function executionProjectConfiguration(project: Project): Record<string, unknown> {
  return {
    ...(project.plugins === undefined ? {} : { plugins: project.plugins }),
    ...(project.nodePrefabs === undefined
      ? {}
      : {
          nodePrefabs: Object.fromEntries(
            Object.entries(project.nodePrefabs).map(([prefabId, prefab]) => [
              prefabId,
              { id: prefab.id, sourceNode: executionNodeConfiguration(prefab.sourceNode) },
            ]),
          ),
        }),
    ...(project.data === undefined ? {} : { data: project.data }),
    ...(project.references === undefined ? {} : { references: project.references }),
    ...(project.metadata.mcpServer === undefined ? {} : { mcpServer: project.metadata.mcpServer }),
    ...(project.metadata.knowledgeStores === undefined ? {} : { knowledgeStores: project.metadata.knowledgeStores }),
  };
}

/**
 * Rivet's live project model intentionally keeps optional fields as own
 * properties whose value is `undefined` (for example `node.description`).
 * That is valid executable state, but it is not PortableJson. Evaluation
 * datasets and graph outputs must retain the stricter contract; provenance
 * fingerprints instead mirror ordinary JSON serialization for this one
 * runtime-only boundary so those optional fields neither block a run nor
 * create a distinct baseline identity.
 */
function canonicalizeExecutionFingerprintValue(value: unknown, path = '$', stack = new Set<object>()): PortableJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must not contain a non-finite number.`);
    return value;
  }
  if (value === undefined) return null;
  if (typeof value !== 'object') throw new Error(`${path} must be JSON-compatible to fingerprint an evaluation.`);
  if (stack.has(value)) throw new Error(`${path} must not contain a cycle.`);

  if (Array.isArray(value)) {
    stack.add(value);
    const normalized = Array.from(value, (entry, index) =>
      canonicalizeExecutionFingerprintValue(entry, `${path}[${index}]`, stack),
    );
    stack.delete(value);
    return normalized;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`${path} must be a plain object to fingerprint an evaluation.`);
  }

  stack.add(value);
  const normalized = Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      entry === undefined ? [] : [[key, canonicalizeExecutionFingerprintValue(entry, `${path}.${key}`, stack)]],
    ),
  );
  stack.delete(value);
  return normalized;
}

function fingerprintExecutionProject(value: unknown): string {
  return fingerprint(canonicalizeExecutionFingerprintValue(value));
}

/**
 * A baseline must follow every graph that a static node configuration can
 * invoke, not only Subgraph and Loop nodes. Dynamic Call Graph references
 * deliberately remain part of the owning graph fingerprint, because their
 * eventual target cannot be known before a trial runs.
 */
function fingerprintGraphDependency(project: Project, graphId: GraphId): string {
  const visited = new Set<GraphId>();
  const graphEntries = Object.entries(project.graphs) as Array<[GraphId, (typeof project.graphs)[GraphId]]>;
  const asKnownGraphId = (value: unknown): GraphId | undefined => {
    return typeof value === 'string' && project.graphs[value as GraphId] ? (value as GraphId) : undefined;
  };
  const getStaticChildren = (graph: (typeof project.graphs)[GraphId]): GraphId[] => {
    const children = new Set<GraphId>();
    const autoDelegatedToolNames: string[] = [];
    const add = (value: unknown) => {
      const id = asKnownGraphId(value);
      if (id) children.add(id);
    };

    for (const node of graph.nodes) {
      const data = node.data as {
        autoDelegate?: unknown;
        graphId?: unknown;
        handlers?: unknown;
        name?: unknown;
        targetGraph?: unknown;
        unknownHandler?: unknown;
        useNameInput?: unknown;
      };
      switch (node.type) {
        case 'subGraph':
        case 'loopUntil':
        case 'cron':
          add(node.type === 'subGraph' ? data.graphId : data.targetGraph);
          break;
        case 'delegateFunctionCall': {
          add(data.unknownHandler);
          if (data.autoDelegate === true) {
            continue;
          }
          if (Array.isArray(data.handlers)) {
            for (const handler of data.handlers) {
              if (handler && typeof handler === 'object' && 'value' in handler) {
                add((handler as { value?: unknown }).value);
              }
            }
          }
          break;
        }
        case 'gptFunction':
          if (data.useNameInput !== true && typeof data.name === 'string' && data.name) {
            autoDelegatedToolNames.push(data.name);
          }
          break;
      }
    }

    if (
      graph.nodes.some(
        (node) =>
          node.type === 'delegateFunctionCall' && (node.data as { autoDelegate?: unknown }).autoDelegate === true,
      )
    ) {
      for (const toolName of autoDelegatedToolNames) {
        const resolved = findAutoDelegateGraphCandidate(
          graphEntries,
          toolName,
          ([, candidate]) => candidate.metadata?.name,
        );
        if (resolved) children.add(resolved[0]);
      }
    }
    return [...children];
  };
  const collect = (id: GraphId): unknown => {
    if (visited.has(id)) return { graphId: id, cycle: true };
    visited.add(id);
    const graph = project.graphs[id];
    if (!graph) return { graphId: id, missing: true };
    const dependencies = getStaticChildren(graph).map(collect);
    return { graph: executionGraphConfiguration(graph), dependencies };
  };
  return fingerprintExecutionProject({
    graphDependency: collect(graphId),
    projectExecutionConfiguration: executionProjectConfiguration(project),
  });
}

function unavailableThresholdResult(threshold: EvaluationThreshold, message: string): EvaluationThresholdResult {
  return {
    id: threshold.id,
    metric: threshold.metric,
    operator: threshold.operator,
    status: 'unavailable',
    expectedValue: threshold.value,
    message,
  };
}

export function evaluateThresholdResults(
  aggregateValue: EvaluationAggregate,
  thresholds: EvaluationThreshold[] = [],
  baseline?: EvaluationBaselineSnapshot,
): EvaluationThresholdResult[] {
  return thresholds.map((threshold) => {
    const actual = thresholdValue(aggregateValue, threshold.metric);
    if (actual === undefined || !Number.isFinite(actual)) {
      const message =
        threshold.metric === 'average-cost' || threshold.metric === 'total-cost'
          ? 'Some provider pricing was unavailable, so this cost requirement could not be evaluated.'
          : threshold.metric === 'pass-rate'
            ? 'No completed trial produced an evaluated pass or fail result.'
            : `The metric "${threshold.metric}" was unavailable.`;
      return unavailableThresholdResult(threshold, message);
    }

    if (threshold.operator === 'max-regression') {
      const isCostMetric = threshold.metric === 'average-cost' || threshold.metric === 'total-cost';
      if (
        isCostMetric &&
        (baseline?.accountingStatus === 'partial' || baseline?.provenance.accountingComplete === false)
      ) {
        return unavailableThresholdResult(
          threshold,
          'The baseline has partial accounting because some provider pricing was unavailable, so this cost regression could not be evaluated.',
        );
      }
      const previous = baseline ? thresholdValue(baseline.aggregate, threshold.metric) : undefined;
      if (previous === undefined || !Number.isFinite(previous)) {
        return unavailableThresholdResult(
          threshold,
          baseline
            ? `The baseline does not contain a comparable "${threshold.metric}" metric.`
            : 'A compatible baseline is required for this regression requirement.',
        );
      }
      const delta = isHigherBetterMetric(threshold.metric) ? previous - actual : actual - previous;
      const zeroBaselineRegression = previous === 0 && delta > 0;
      const regression = previous === 0 ? 0 : delta / Math.abs(previous);
      const failed = zeroBaselineRegression || regression > threshold.value;
      return {
        id: threshold.id,
        metric: threshold.metric,
        operator: threshold.operator,
        status: failed ? 'failed' : 'passed',
        expectedValue: threshold.value,
        actualValue: actual,
        baselineValue: previous,
        ...(zeroBaselineRegression ? {} : { regression }),
        message: failed
          ? `Regression exceeded the allowed ${formatThresholdResultValue(
              threshold.metric,
              threshold.operator,
              threshold.value,
            )}.`
          : `Regression stayed within the allowed ${formatThresholdResultValue(
              threshold.metric,
              threshold.operator,
              threshold.value,
            )}.`,
      };
    }

    const passed = threshold.operator === 'at-least' ? actual >= threshold.value : actual <= threshold.value;
    return {
      id: threshold.id,
      metric: threshold.metric,
      operator: threshold.operator,
      status: passed ? 'passed' : 'failed',
      expectedValue: threshold.value,
      actualValue: actual,
      message: passed
        ? `Actual value ${formatThresholdResultValue(threshold.metric, threshold.operator, actual)} satisfied ${
            threshold.operator
          } ${formatThresholdResultValue(threshold.metric, threshold.operator, threshold.value)}.`
        : `Actual value ${formatThresholdResultValue(threshold.metric, threshold.operator, actual)} did not satisfy ${
            threshold.operator
          } ${formatThresholdResultValue(threshold.metric, threshold.operator, threshold.value)}.`,
    };
  });
}

function createProvenance(
  project: Project,
  suite: EvaluationSuite,
  dataset: EvaluationDataset,
  options: RunEvaluationSuiteOptions,
): EvaluationRunProvenance {
  const purpose = options.purpose ?? 'evaluation';
  const evaluationMode = getEvaluationSuiteMode(suite);
  const configuration = suite.configuration;
  const materialEvaluators = suite.evaluators.map((evaluator) => ({
    graphId: evaluator.graphId,
    inputBindings:
      evaluator.inputBindings?.slice().sort((left, right) => left.graphInputId.localeCompare(right.graphInputId)) ??
      null,
    // Normalize defaults so editing a control between its implicit and
    // explicit default does not invalidate a baseline.
    scoreWeight: evaluator.scoreWeight ?? 1,
    ...(evaluationMode === 'scoring'
      ? {}
      : { required: evaluator.required !== false, runOnTargetError: evaluator.runOnTargetError === true }),
  }));
  const materialSuiteDefinition = {
    purpose,
    evaluationMode,
    targetGraphId: suite.targetGraphId,
    datasetId: suite.datasetId,
    inputBindings: suite.inputBindings
      .slice()
      .sort((left, right) => left.graphInputId.localeCompare(right.graphInputId)),
    configuration: {
      trialCount: configuration?.trialCount ?? 1,
      concurrency: configuration?.concurrency ?? DEFAULT_CONCURRENCY,
      timeoutMs: configuration?.timeoutMs ?? null,
      seed: configuration?.seed ?? null,
      seedGraphInputId: configuration?.seedGraphInputId ?? null,
    },
    ...(purpose !== 'evaluation'
      ? {}
      : evaluationMode === 'scoring'
        ? { evaluators: materialEvaluators }
        : {
            assertions: suite.assertions,
            evaluators: materialEvaluators,
            thresholds: suite.thresholds ?? [],
          }),
  };
  return {
    projectFingerprint:
      options.projectFingerprint ??
      fingerprintExecutionProject({
        projectId: project.metadata.id,
        graphs: executionProjectGraphs(project),
        executionConfiguration: executionProjectConfiguration(project),
      }),
    // Names, descriptions, tags, and recording-retention choices do not
    // change an execution result. Quality-only definitions likewise cannot
    // stale an execution-benchmark comparison because they never ran. Pass/
    // fail assertions and thresholds are equally dormant in scoring mode.
    suiteFingerprint: fingerprint(materialSuiteDefinition),
    datasetFingerprint: fingerprintEvaluationDataset(dataset),
    targetFingerprint: fingerprintGraphDependency(project, suite.targetGraphId),
    evaluatorFingerprints:
      purpose === 'evaluation'
        ? Object.fromEntries(
            suite.evaluators.map((evaluator) => [evaluator.id, fingerprintGraphDependency(project, evaluator.graphId)]),
          )
        : {},
    executionMode: options.executionMode ?? 'unknown',
    accountingComplete: true,
  };
}

export async function runEvaluationSuite(options: RunEvaluationSuiteOptions): Promise<EvaluationRun> {
  const suite = resolveSuite(options.evaluationData, options.suiteId);
  const purpose = options.purpose ?? 'evaluation';
  const evaluationMode = getEvaluationSuiteMode(suite);
  if (purpose === 'evaluation' && !hasAuthoritativeEvaluationCriteria(suite)) {
    throw new Error(
      evaluationMode === 'scoring'
        ? `Scoring evaluation suite "${suite.name}" has no evaluator graph. Add an evaluator that returns result.score or run an execution benchmark.`
        : `Evaluation suite "${suite.name}" has no required quality check or threshold. Add a quality criterion or run it as an execution benchmark.`,
    );
  }
  validateSuite(options.project, suite, options.dataset, purpose);
  const runId = options.runId ?? makeId('evaluation');
  const run: EvaluationRun = {
    version: 2,
    id: runId,
    projectId: options.project.metadata.id,
    suiteId: suite.id,
    suiteName: suite.name,
    revision: 0,
    startedAt: new Date().toISOString(),
    purpose,
    evaluationMode,
    executionStatus: 'running',
    qualityStatus: 'not-evaluated',
    qualityReason: { code: 'in-progress', message: 'The run is still in progress.' },
    accountingStatus: 'complete',
    provenance: createProvenance(options.project, suite, options.dataset, options),
    trials: [],
    thresholdResults: [],
    warnings: [],
  };
  const trialCount = Math.max(1, Math.floor(suite.configuration?.trialCount ?? 1));
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Math.floor(suite.configuration?.concurrency ?? DEFAULT_CONCURRENCY)),
  );
  const work = options.dataset.cases
    .filter((testCase) => testCase.enabled !== false)
    .flatMap((testCase, caseIndex) =>
      Array.from({ length: trialCount }, (_, trialIndex) => ({ testCase, caseIndex, trialIndex })),
    );
  run.requestedTrialCount = work.length;
  const settledTrials: Array<EvaluationTrial | undefined> = Array.from({ length: work.length });
  let settledTrialCount = 0;
  const nextRevision = () => {
    run.revision = (run.revision ?? 0) + 1;
    return run.revision;
  };
  const publishLegacySnapshot = () => {
    // Legacy consumers may retain earlier revisions. Keep their snapshots
    // detached, while incremental consumers avoid cloning all prior trials.
    if (!options.onUpdate) return;
    run.trials = settledTrials.filter((trial): trial is EvaluationTrial => trial !== undefined);
    options.onUpdate(structuredClone(run));
  };
  const publishStarted = async () => {
    const revision = nextRevision();
    if (options.onEvent) {
      const shell = structuredClone(run);
      shell.trials = [];
      await options.onEvent({ type: 'run-started', revision, run: shell });
    }
    publishLegacySnapshot();
  };
  const publishSettledTrial = async (trial: EvaluationTrial) => {
    const revision = nextRevision();
    await options.onEvent?.({
      type: 'trial-settled',
      revision,
      runId: run.id,
      projectId: run.projectId,
      suiteId: run.suiteId,
      requestedTrialCount: run.requestedTrialCount ?? work.length,
      settledTrialCount,
      trial: structuredClone(trial),
    });
    publishLegacySnapshot();
  };
  const publishFinalized = async () => {
    const revision = nextRevision();
    await options.onEvent?.({ type: 'run-finalized', revision, run: structuredClone(run) });
    publishLegacySnapshot();
  };
  // Publish the running shell before constructing the worker-pool promise:
  // async workers start immediately, so publishing afterwards can otherwise
  // let the first graph call race ahead of the run's initial state.
  await publishStarted();
  const workPool = runEvaluationWorkPool({
    work,
    concurrency,
    signal: options.signal,
    execute: async (task) => {
      try {
        return await runTrial({
          ...task,
          project: options.project,
          suite,
          dataset: options.dataset,
          purpose,
          runId,
          runGraph: options.runGraph,
          signal: options.signal,
        });
      } catch (error) {
        const executionStatus = isAbort(error) ? ('canceled' as const) : ('error' as const);
        const qualityStatus =
          purpose === 'evaluation' && executionStatus === 'error'
            ? evaluationMode === 'scoring'
              ? ('unable-to-evaluate' as const)
              : ('failed' as const)
            : ('not-evaluated' as const);
        return {
          id: makeId('trial'),
          caseId: task.testCase.id,
          caseName: task.testCase.name,
          caseIndex: task.caseIndex,
          trialIndex: task.trialIndex,
          executionStatus,
          qualityStatus,
          qualityReason:
            executionStatus === 'canceled'
              ? { code: 'canceled' as const, message: 'The evaluation trial was canceled.' }
              : purpose === 'evaluation'
                ? evaluationMode === 'scoring'
                  ? { code: 'scores-incomplete' as const, message: 'The target graph could not produce a score.' }
                  : { code: 'target-error' as const, message: 'The target graph could not be executed.' }
                : { code: 'benchmark' as const, message: 'This benchmark trial could not be executed.' },
          inputs: {},
          expected: {},
          outputs: {},
          observations: [],
          targetMetrics: createEmptyMetrics(),
          evaluatorMetrics: createEmptyMetrics(),
          totalMetrics:
            executionStatus === 'canceled' ? { ...createEmptyMetrics(), hasUnknownCost: true } : createEmptyMetrics(),
          error: toErrorMessage(error),
        };
      }
    },
    onSettled: async (result, index) => {
      settledTrials[index] = result;
      settledTrialCount += 1;
      await publishSettledTrial(result);
    },
  });
  const results = await workPool;
  run.trials = results.filter((result): result is EvaluationTrial => result !== undefined);
  run.completedAt = new Date().toISOString();
  const outcome = aggregate(run.trials, evaluationMode);
  run.aggregate = outcome.aggregate;
  run.provenance.accountingComplete = !run.trials.some((trial) => trial.totalMetrics.hasUnknownCost);
  run.accountingStatus = run.provenance.accountingComplete ? 'complete' : 'partial';
  if (run.accountingStatus === 'partial') {
    run.warnings.push(
      'Some provider pricing was unavailable. Cost totals are unavailable, and cost requirements cannot be evaluated.',
    );
  }
  if (options.signal?.aborted) {
    run.executionStatus = 'canceled';
    run.qualityStatus = 'not-evaluated';
    run.qualityReason = { code: 'canceled', message: 'The evaluation run was canceled.' };
  } else if (purpose === 'execution-benchmark') {
    run.executionStatus = 'completed';
    run.qualityStatus = 'not-evaluated';
    run.qualityReason = {
      code: 'benchmark',
      message: 'This run measured execution without evaluating output quality.',
    };
  } else if (evaluationMode === 'scoring') {
    run.executionStatus = 'completed';
    if ((outcome.aggregate.missingScoreTrialCount ?? run.trials.length) > 0) {
      run.qualityStatus = 'unable-to-evaluate';
      run.qualityReason = {
        code: 'scores-incomplete',
        message:
          'One or more requested trials did not produce a usable score. Available averages are shown with coverage.',
      };
      run.warnings.push(
        `Score coverage is ${outcome.aggregate.scoredTrialCount ?? 0} of ${outcome.aggregate.trialCount} requested trials.`,
      );
    } else if ((outcome.aggregate.scoredTrialCount ?? 0) > 0) {
      run.qualityStatus = 'scored';
      run.qualityReason = {
        code: 'scores-complete',
        message: 'Every requested trial produced a score. Overall score is the equal-weight average of case averages.',
      };
    } else {
      run.qualityStatus = 'unable-to-evaluate';
      run.qualityReason = { code: 'scores-incomplete', message: 'No requested trial produced a usable score.' };
    }
  } else {
    const baseline =
      options.baseline ?? options.evaluationData.baselines.find((candidate) => candidate.suiteId === suite.id);
    const usableBaseline = baseline && baselineCompatible(run.provenance, baseline) ? baseline : undefined;
    if (baseline && !usableBaseline)
      run.warnings.push(
        'The suite baseline is stale because its target, dataset, bindings, or evaluator definition changed.',
      );
    run.thresholdResults = evaluateThresholdResults(outcome.aggregate, suite.thresholds, usableBaseline);
    const hasPassRateThreshold = suite.thresholds?.some((threshold) => threshold.metric === 'pass-rate') ?? false;
    const hasTargetErrorRateThreshold =
      suite.thresholds?.some((threshold) => threshold.metric === 'target-error-rate') ?? false;
    // Per-trial checks and target execution errors are strict by default. An
    // author can deliberately replace either default with its matching
    // aggregate tolerance, but one kind of threshold must never hide the
    // other kind of failure.
    const hasUngovernedCheckFailure =
      !hasPassRateThreshold &&
      run.trials.some((trial) => trial.executionStatus === 'completed' && trial.qualityStatus === 'failed');
    const hasUngovernedTargetError =
      !hasTargetErrorRateThreshold && run.trials.some((trial) => trial.executionStatus === 'error');
    const hasThresholdFailure = run.thresholdResults.some((result) => result.status === 'failed');
    const hasUnavailableEvidence =
      run.trials.some((trial) => trial.qualityStatus === 'unable-to-evaluate') ||
      run.thresholdResults.some((result) => result.status === 'unavailable');
    const hasAuthoritativePass =
      run.trials.some((trial) => trial.executionStatus === 'completed' && trial.qualityStatus === 'passed') ||
      run.thresholdResults.some((result) => result.status === 'passed');

    if (hasUngovernedCheckFailure || hasUngovernedTargetError || hasThresholdFailure) {
      run.qualityStatus = 'failed';
      run.qualityReason = {
        code: hasThresholdFailure ? 'thresholds-failed' : 'checks-failed',
        message: hasThresholdFailure
          ? 'One or more required aggregate thresholds failed.'
          : 'One or more target executions or required quality checks failed.',
      };
    } else if (hasUnavailableEvidence) {
      run.qualityStatus = 'unable-to-evaluate';
      run.qualityReason = {
        code: run.thresholdResults.some((result) => result.status === 'unavailable')
          ? 'required-metric-unavailable'
          : 'required-check-error',
        message: run.thresholdResults.some((result) => result.status === 'unavailable')
          ? 'A required aggregate metric could not be evaluated.'
          : 'A required quality check could not be evaluated.',
      };
    } else if (hasAuthoritativePass) {
      run.qualityStatus = 'passed';
      run.qualityReason = {
        code: run.thresholdResults.length > 0 ? 'thresholds-passed' : 'checks-passed',
        message:
          run.thresholdResults.length > 0
            ? 'All required quality checks and aggregate thresholds passed.'
            : 'All required quality checks passed.',
      };
    } else {
      run.qualityStatus = 'not-evaluated';
      run.qualityReason = {
        code: 'no-completed-trials',
        message: 'No completed trial produced an authoritative quality result.',
      };
    }
    run.executionStatus = 'completed';
  }
  await publishFinalized();
  return run;
}

export async function runEvaluationCases(
  options: RunEvaluationSuiteOptions & { caseIds: readonly string[] },
): Promise<EvaluationRun> {
  const permitted = new Set(options.caseIds);
  return runEvaluationSuite({
    ...options,
    dataset: { ...options.dataset, cases: options.dataset.cases.filter((testCase) => permitted.has(testCase.id)) },
  });
}

export function summarizeEvaluationRun(
  run: EvaluationRun,
): { aggregate: EvaluationAggregate; cases: EvaluationCaseAggregate[] } | undefined {
  return run.aggregate ? aggregate(run.trials, getEvaluationSuiteMode(run)) : undefined;
}

/**
 * Baselines deliberately retain aggregate/provenance only. Raw prompts,
 * outputs, credentials, and replay artifacts remain in the run store.
 */
export function createEvaluationBaselineSnapshot(run: EvaluationRun): EvaluationBaselineSnapshot {
  const normalizedRun = normalizeEvaluationRun(run);
  if (normalizedRun.executionStatus !== 'completed') {
    throw new Error('Only a completed evaluation run can be promoted to a baseline.');
  }
  if (
    normalizedRun.purpose !== 'execution-benchmark' &&
    getEvaluationSuiteMode(normalizedRun) === 'scoring' &&
    normalizedRun.qualityStatus !== 'scored'
  ) {
    throw new Error('A scoring baseline needs a complete score for every requested trial.');
  }
  const summary = summarizeEvaluationRun(normalizedRun);
  if (!summary) throw new Error('Only a completed evaluation run can be promoted to a baseline.');
  return {
    id: makeId('baseline'),
    suiteId: normalizedRun.suiteId,
    sourceRunId: normalizedRun.id,
    createdAt: new Date().toISOString(),
    provenance: normalizedRun.provenance,
    aggregate: summary.aggregate,
    purpose: normalizedRun.purpose,
    evaluationMode: getEvaluationSuiteMode(normalizedRun),
    qualityStatus: normalizedRun.qualityStatus,
    qualityReason: normalizedRun.qualityReason,
    accountingStatus: normalizedRun.accountingStatus,
    cases: summary.cases,
  };
}

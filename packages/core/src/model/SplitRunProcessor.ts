import { max, range } from 'lodash-es';
import {
  type DataValue,
  type ArrayDataValue,
  type AnyDataValue,
  isArrayDataValue,
  arrayizeDataValue,
} from './DataValue.js';
import { type ChartNode, type NodeInputDefinition, type PortId } from './NodeBase.js';
import type { ProcessId } from './ProcessContext.js';
import type { Inputs, Outputs } from './GraphProcessor.js';
import { getGraphAbortReasonFromError, isAbortLikeError } from './GraphAbortReasons.js';
import { getError } from '../utils/errors.js';
import PQueue from '../utils/pQueueCompat.js';
import { entries, fromEntries } from '../utils/typeSafety.js';

export type SplitRunDeps = {
  getInputValues(node: ChartNode): Inputs;
  getInputDefinitions(node: ChartNode): NodeInputDefinition[];
  isExcludedDueToControlFlow(node: ChartNode, inputValues: Inputs, processId: ProcessId): boolean;
  processNodeWithInputData(
    node: ChartNode,
    inputs: Inputs,
    index: number,
    processId: ProcessId,
    partialOutput?: (node: ChartNode, partialOutputs: Outputs, index: number) => void,
  ): Promise<Outputs>;
  splitRunConcurrency: number;
  accumulateCost(output: Outputs): void;
  setNodeResults(nodeId: ChartNode['id'], outputs: Outputs): void;
  markNodeVisited(nodeId: ChartNode['id']): void;
  nodeErrored(
    node: ChartNode,
    error: unknown,
    processId: ProcessId,
    durationMs?: number,
    splitRunDurationMs?: Record<number, number>,
  ): Promise<void>;
  isAborted(): boolean;
  getAbortError(): Error;
  emit(event: 'nodeStart', data: { node: ChartNode; inputs: Inputs; processId: ProcessId }): Promise<void> | void;
  emit(
    event: 'nodeFinish',
    data: {
      node: ChartNode;
      outputs: Outputs;
      processId: ProcessId;
      durationMs?: number;
      splitRunDurationMs?: Record<number, number>;
    },
  ): Promise<void> | void;
  emit(
    event: 'partialOutput',
    data: { node: ChartNode; outputs: Outputs; index: number; processId: ProcessId },
  ): void;
  startNodeTiming?(): number | undefined;
  finishNodeTiming?(start: number | undefined): number | undefined;
};

type SplitResult =
  | { type: 'output'; output: Outputs; durationMs?: number; error?: Error }
  | { type: 'error'; error: Error; durationMs?: number; output?: Outputs };

function withOptionalDuration<T extends object>(
  payload: T,
  durationMs: number | undefined,
  splitRunDurationMs?: Record<number, number>,
): T & { durationMs?: number; splitRunDurationMs?: Record<number, number> } {
  return {
    ...payload,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(splitRunDurationMs === undefined ? {} : { splitRunDurationMs }),
  } as T & { durationMs?: number; splitRunDurationMs?: Record<number, number> };
}

export async function processSplitRunNode(
  node: ChartNode,
  processId: ProcessId,
  deps: SplitRunDeps,
): Promise<void> {
  const inputValues = deps.getInputValues(node);

  if (deps.isExcludedDueToControlFlow(node, inputValues, processId)) {
    return;
  }

  const inputDefinitionsById = new Map(deps.getInputDefinitions(node).map((definition) => [definition.id, definition]));
  const splittingAmount = Math.min(
    max(
      entries(inputValues).map(([portId, value]) =>
        inputDefinitionsById.get(portId as PortId)?.splitRunBehavior === 'preserve-array'
          ? 1
          : Array.isArray(value?.value)
            ? value.value.length
            : 1,
      ),
    ) ?? 1,
    node.splitRunMax ?? 10,
  );

  await deps.emit('nodeStart', { node, inputs: inputValues, processId });
  const timingStart = deps.startNodeTiming?.();
  let splitRunDurationMs: Record<number, number> | undefined;

  try {
    let results: SplitResult[];

    if (node.isSplitSequential) {
      results = await runSequential(node, inputValues, inputDefinitionsById, splittingAmount, processId, deps);
    } else {
      results = await runParallel(node, inputValues, inputDefinitionsById, splittingAmount, processId, deps);
    }

    splitRunDurationMs = getSplitRunDurationMs(results);
    const errors = results.filter((r) => r.type === 'error').map((r) => r.error!);
    if (errors.length === 1) {
      throw errors[0]!;
    } else if (errors.length > 0) {
      if (deps.isAborted() && errors.every(isGraphAbortOrAbortLikeError)) {
        throw deps.getAbortError();
      }

      throw new AggregateError(errors);
    }

    const aggregateResults = aggregateOutputs(results);

    deps.setNodeResults(node.id, aggregateResults);
    deps.markNodeVisited(node.id);
    await deps.emit(
      'nodeFinish',
      withOptionalDuration(
        {
          node,
          outputs: aggregateResults,
          processId,
        },
        deps.finishNodeTiming?.(timingStart),
        splitRunDurationMs,
      ),
    );
  } catch (error) {
    await deps.nodeErrored(node, error, processId, deps.finishNodeTiming?.(timingStart), splitRunDurationMs);
  }
}

async function runSequential(
  node: ChartNode,
  inputValues: Inputs,
  inputDefinitionsById: ReadonlyMap<PortId, NodeInputDefinition>,
  splittingAmount: number,
  processId: ProcessId,
  deps: SplitRunDeps,
): Promise<SplitResult[]> {
  const results: SplitResult[] = [];

  for (let i = 0; i < splittingAmount; i++) {
    if (deps.isAborted()) {
      throw deps.getAbortError();
    }

    const inputs = splitInputsAtIndex(inputValues, inputDefinitionsById, i);
    const splitTimingStart = deps.startNodeTiming?.();

    try {
      const output = await deps.processNodeWithInputData(node, inputs, i, processId, (n, partialOutputs, index) => {
        deps.emit('partialOutput', { node: n, outputs: partialOutputs, index, processId });
      });

      deps.accumulateCost(output);
      results.push({ type: 'output', output, durationMs: deps.finishNodeTiming?.(splitTimingStart) });
    } catch (error) {
      results.push({ type: 'error', error: getError(error), durationMs: deps.finishNodeTiming?.(splitTimingStart) });
    }
  }

  return results;
}

async function runParallel(
  node: ChartNode,
  inputValues: Inputs,
  inputDefinitionsById: ReadonlyMap<PortId, NodeInputDefinition>,
  splittingAmount: number,
  processId: ProcessId,
  deps: SplitRunDeps,
): Promise<SplitResult[]> {
  const queue = new PQueue({ concurrency: getParallelSplitRunConcurrency(node, deps.splitRunConcurrency) });

  return Promise.all(
    range(0, splittingAmount).map(async (i: number) => {
      const result = await queue.add(async () => {
        const splitTimingStart = deps.startNodeTiming?.();

        try {
          if (deps.isAborted()) {
            throw deps.getAbortError();
          }

          const inputs = splitInputsAtIndex(inputValues, inputDefinitionsById, i);
          const output = await deps.processNodeWithInputData(node, inputs, i, processId, (n, partialOutputs, index) => {
            deps.emit('partialOutput', { node: n, outputs: partialOutputs, index, processId });
          });

          deps.accumulateCost(output);
          return { type: 'output' as const, output, durationMs: deps.finishNodeTiming?.(splitTimingStart) };
        } catch (error) {
          return {
            type: 'error' as const,
            error: getError(error),
            durationMs: deps.finishNodeTiming?.(splitTimingStart),
          };
        }
      });

      if (!result) {
        throw new Error('Parallel split-run task completed without a result.');
      }

      return result;
    }),
  );
}

function getParallelSplitRunConcurrency(node: ChartNode, defaultConcurrency: number): number {
  const value = node.splitRunConcurrency;
  return typeof value === 'number' && Number.isFinite(value) && value >= 2 ? Math.floor(value) : defaultConcurrency;
}

function splitInputsAtIndex(
  inputValues: Inputs,
  inputDefinitionsById: ReadonlyMap<PortId, NodeInputDefinition>,
  index: number,
): Inputs {
  return fromEntries(
    entries(inputValues).map(([port, value]) => [
      port as PortId,
      inputDefinitionsById.get(port as PortId)?.splitRunBehavior === 'preserve-array'
        ? value
        : isArrayDataValue(value)
          ? arrayizeDataValue(value)[index] ?? undefined
          : value,
    ]),
  ) as Inputs;
}

function aggregateOutputs(results: SplitResult[]): Outputs {
  return results.reduce((acc, result) => {
    for (const [portId, value] of entries(result.output!)) {
      acc[portId as PortId] ??= { type: (value?.type + '[]') as DataValue['type'], value: [] } as DataValue;
      (acc[portId as PortId] as ArrayDataValue<AnyDataValue>).value.push(value?.value);
    }
    return acc;
  }, {} as Outputs);
}

function getSplitRunDurationMs(results: SplitResult[]): Record<number, number> | undefined {
  const durations: Record<number, number> = {};
  for (const [index, result] of results.entries()) {
    if (result.durationMs !== undefined) {
      durations[index] = result.durationMs;
    }
  }

  return Object.keys(durations).length > 0 ? durations : undefined;
}

function isGraphAbortOrAbortLikeError(error: Error): boolean {
  return getGraphAbortReasonFromError(error) != null || isAbortLikeError(error);
}

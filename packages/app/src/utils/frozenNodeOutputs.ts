import {
  cloneFrozenNodeOutputs,
  cloneFrozenNodeOutputsByGraph,
  createDebuggerTransportEscapedSentinelEnvelope,
  createDebuggerTransportUndefinedSentinel,
  hasFrozenNodeOutputs,
  isDebuggerTransportSentinelEnvelope,
  type ChartNode,
  type FrozenNodeOutputsByGraph,
  type GraphId,
  type NodeId,
  type Outputs,
} from '@valerypopoff/rivet2-core';
import type { DataRefReader } from '../providers/ProvidersContext.js';
import type { GraphRunRecord, GraphRunSelection, ProcessDataForNode } from '../state/dataFlow.js';
import { filterProcessDataForSelection } from '../state/selectors/executionSelectors.js';
import { hasStoredPortMapValues, restoreStoredPortMap } from './executionDataReaders.js';

type GraphSelectionOptions = {
  graphRuns?: GraphRunRecord[];
  selectedGraphRun?: GraphRunSelection;
};

const UNFREEZABLE_NODE_TYPES = new Set<ChartNode['type']>([
  'comment',
  'abortGraph',
  'graphOutput',
  'appendToDataset',
  'createDataset',
  'replaceDataset',
  'raiseEvent',
  'playAudio',
  'startBackgroundBranch',
  // Data Bus channels are compiled into effective connections before a run;
  // there is no node invocation whose outputs could be replayed.
  'dataBus',
]);

export function canNodeTypeBeFrozen(nodeType: ChartNode['type']): boolean {
  return !UNFREEZABLE_NODE_TYPES.has(nodeType);
}

export function getSuccessfulFrozenOutputCandidates(options: {
  graphId: GraphId;
  processData: ProcessDataForNode[] | undefined;
  selection: GraphSelectionOptions;
}): ProcessDataForNode[] {
  const filteredProcessData = filterProcessDataForSelection({
    graphRuns: options.selection.graphRuns,
    processData: options.processData,
    selectedGraphRun: options.selection.selectedGraphRun,
  });

  return (filteredProcessData ?? []).filter(
    (process) =>
      process.data.status?.type === 'ok' &&
      (process.graphId == null || process.graphId === options.graphId) &&
      hasStoredPortMapValues(process.data.outputData),
  );
}

export function canFreezeNodeOutputs(options: {
  graphId: GraphId;
  processData: ProcessDataForNode[] | undefined;
  selection: GraphSelectionOptions;
}): boolean {
  return getSuccessfulFrozenOutputCandidates(options).length > 0;
}

export function captureFrozenNodeOutputs(options: {
  dataRefs: DataRefReader;
  graphId: GraphId;
  nodeId: NodeId;
  processData: ProcessDataForNode[] | undefined;
  selection: GraphSelectionOptions;
}): Outputs[] {
  const outputInstances = getSuccessfulFrozenOutputCandidates({
    graphId: options.graphId,
    processData: options.processData,
    selection: options.selection,
  }).map((process) => {
    const outputs = restoreStoredPortMap(process.data.outputData, options.dataRefs);
    if (!outputs || Object.keys(outputs).length === 0) {
      throw new Error(`Node ${options.nodeId} output data could not be restored from execution memory`);
    }

    return cloneFrozenNodeOutputs(outputs);
  });

  if (outputInstances.length === 0) {
    throw new Error(`Node ${options.nodeId} has no successful output data to freeze`);
  }

  return outputInstances;
}

export function setFrozenNodeOutputsForNode(
  previous: FrozenNodeOutputsByGraph,
  graphId: GraphId,
  nodeId: NodeId,
  outputInstances: Outputs[],
): FrozenNodeOutputsByGraph {
  return {
    ...previous,
    [graphId]: {
      ...(previous[graphId] ?? {}),
      [nodeId]: outputInstances.map((outputs) => cloneFrozenNodeOutputs(outputs)),
    },
  };
}

export function removeFrozenNodeOutputsForNode(
  previous: FrozenNodeOutputsByGraph,
  graphId: GraphId,
  nodeId: NodeId,
): FrozenNodeOutputsByGraph {
  const outputsByNode = previous[graphId];
  if (!outputsByNode?.[nodeId]) {
    return previous;
  }

  const nextOutputsByNode = { ...outputsByNode };
  delete nextOutputsByNode[nodeId];

  if (Object.keys(nextOutputsByNode).length === 0) {
    const next = { ...previous };
    delete next[graphId];
    return next;
  }

  return {
    ...previous,
    [graphId]: nextOutputsByNode,
  };
}

export function removeFrozenNodeOutputsForNodes(
  previous: FrozenNodeOutputsByGraph,
  graphId: GraphId | undefined,
  nodeIds: NodeId[],
): FrozenNodeOutputsByGraph {
  if (!graphId || nodeIds.length === 0) {
    return previous;
  }

  let next = previous;
  for (const nodeId of nodeIds) {
    next = removeFrozenNodeOutputsForNode(next, graphId, nodeId);
  }
  return next;
}

export function removeFrozenNodeOutputsForGraphs(
  previous: FrozenNodeOutputsByGraph,
  graphIds: GraphId[],
): FrozenNodeOutputsByGraph {
  if (graphIds.length === 0) {
    return previous;
  }

  const next = { ...previous };
  for (const graphId of graphIds) {
    delete next[graphId];
  }
  return next;
}

export function getFrozenNodePreloadOutput(
  frozenNodeOutputs: FrozenNodeOutputsByGraph | undefined,
  graphId: GraphId | undefined,
  nodeId: NodeId,
): Outputs | undefined {
  if (!graphId) {
    return undefined;
  }

  const outputs = frozenNodeOutputs?.[graphId]?.[nodeId]?.[0];
  return outputs ? cloneFrozenNodeOutputs(outputs) : undefined;
}

export function cloneFrozenNodeOutputsForExecutor(
  frozenNodeOutputs: FrozenNodeOutputsByGraph,
): FrozenNodeOutputsByGraph | undefined {
  if (!hasFrozenNodeOutputs(frozenNodeOutputs)) {
    return undefined;
  }

  return cloneFrozenNodeOutputsByGraph(frozenNodeOutputs);
}

export function assertFrozenNodeOutputsSerializableForInternalExecutor(value: unknown): void {
  prepareFrozenNodeOutputsForInternalExecutorTransport(value);
}

export function prepareFrozenNodeOutputsForInternalExecutorTransport<T>(value: T): T {
  const stack = new WeakSet<object>();
  return prepareInternalExecutorSerializableValue(value, ['frozenNodeOutputs'], stack) as T;
}

function prepareInternalExecutorSerializableValue(
  value: unknown,
  path: Array<string | number>,
  stack: WeakSet<object>,
): unknown {
  switch (typeof value) {
    case 'bigint':
      throw new Error(createInternalExecutorSerializationError('BigInt', path));
    case 'function':
      throw new Error(createInternalExecutorSerializationError('function', path));
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(createInternalExecutorSerializationError(String(value), path));
      }
      return value;
    case 'symbol':
      throw new Error(createInternalExecutorSerializationError('symbol', path));
    case 'undefined':
      return createDebuggerTransportUndefinedSentinel();
    case 'object':
      if (value == null) {
        return value;
      }

      if (stack.has(value)) {
        throw new Error(createInternalExecutorSerializationError('circular reference', path));
      }

      stack.add(value);
      try {
        if (Array.isArray(value)) {
          return value.map((item, index) => prepareInternalExecutorSerializableValue(item, [...path, index], stack));
        }

        if (!isPlainJsonObject(value)) {
          throw new Error(createInternalExecutorSerializationError('a non-plain object', path));
        }

        const prepared: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          prepared[key] = prepareInternalExecutorSerializableValue(item, [...path, key], stack);
        }

        return isDebuggerTransportSentinelEnvelope(value)
          ? createDebuggerTransportEscapedSentinelEnvelope(prepared)
          : prepared;
      } finally {
        stack.delete(value);
      }
    default:
      return value;
  }
}

function isPlainJsonObject(value: object) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createInternalExecutorSerializationError(reason: string, path: Array<string | number>) {
  return `Frozen node output cannot be sent to the internal Node executor because ${formatFrozenOutputPath(
    path,
  )} contains ${reason}. Use the Browser executor or freeze a JSON-serializable output.`;
}

function formatFrozenOutputPath(path: Array<string | number>) {
  return path
    .map((part, index) => {
      if (typeof part === 'number') {
        return `[${part}]`;
      }

      return index === 0 ? part : `.${part}`;
    })
    .join('');
}

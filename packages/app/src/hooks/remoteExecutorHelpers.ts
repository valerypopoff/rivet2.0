import {
  compileDataBusTopology,
  GraphProcessor,
  isDataBusTopologyNode,
  resolveNodePrefabInstance,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type NodeRegistration,
  type Outputs,
  type ProcessEvents,
  type ProcessEventMessageMap,
  type Project,
  type FrozenNodeOutputsByGraph,
} from '@valerypopoff/rivet2-core';
import type { ProcessDataForNode, RunDataByNodeId } from '../state/dataFlow.js';
import type { DataRefReader } from '../providers/ProvidersContext.js';
import { hasStoredPortMapValues, restoreStoredPortMap } from '../utils/executionDataReaders.js';
import { hasUnavailableStoredRefs } from '../utils/executionDataStorage.js';
import { getGlobalDataRef } from '../utils/globals/globalDataRefs.js';
import {
  cloneFrozenNodeOutputsForExecutor,
  getFrozenNodePreloadOutput,
  prepareFrozenNodeOutputsForInternalExecutorTransport,
} from '../utils/frozenNodeOutputs.js';
import type { ExecutorSessionTarget } from './executorSessionTarget.js';
import { dispatchGraphExecutionEvent } from './graphExecutionEventDispatch.js';

const dataRefs: DataRefReader = {
  get: getGlobalDataRef,
};

export function getDependentDataForNodeForPreload(
  dependencyNodes: NodeId[],
  previousRunData: RunDataByNodeId,
  options: { frozenNodeOutputs?: FrozenNodeOutputsByGraph; graphId?: GraphId } = {},
) {
  const preloadData: Record<NodeId, Outputs> = {};

  for (const dependencyNode of dependencyNodes) {
    const frozenOutput = getFrozenNodePreloadOutput(options.frozenNodeOutputs, options.graphId, dependencyNode);
    if (frozenOutput) {
      preloadData[dependencyNode] = frozenOutput;
      continue;
    }

    const dependencyNodeData = previousRunData[dependencyNode];

    if (!dependencyNodeData) {
      throw new Error(`Node ${dependencyNode} was not found in the previous run data, cannot continue preloading data`);
    }

    const latestExecutionWithOutput = findLatestExecutionWithOutput(dependencyNodeData);

    const outputData = latestExecutionWithOutput?.data.outputData;
    if (!hasStoredPortMapValues(outputData)) {
      throw new Error(
        `Node ${dependencyNode} has no output data in the previous run data, cannot continue preloading data`,
      );
    }

    let outputDataWithoutRefs: Outputs | undefined;

    try {
      outputDataWithoutRefs = restoreStoredPortMap(outputData, dataRefs);
    } catch (error) {
      throw new Error(
        `Node ${dependencyNode} output data was cleared from execution memory and cannot be preloaded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!outputDataWithoutRefs || Object.keys(outputDataWithoutRefs).length === 0) {
      throw new Error(
        `Node ${dependencyNode} output data could not be restored from execution memory, cannot continue preloading data`,
      );
    }

    preloadData[dependencyNode] = outputDataWithoutRefs;
  }

  return preloadData;
}

export function getFrozenNodeOutputsForExecutorRunPayload(
  frozenNodeOutputs: FrozenNodeOutputsByGraph,
  target: ExecutorSessionTarget | null | undefined,
): FrozenNodeOutputsByGraph | undefined {
  if (!canUseFrozenNodeOutputsForExecutorTarget(target)) {
    return undefined;
  }

  const payload = cloneFrozenNodeOutputsForExecutor(frozenNodeOutputs);
  return payload ? prepareFrozenNodeOutputsForInternalExecutorTransport(payload) : undefined;
}

export function getFrozenNodeOptionsForExecutorTarget(
  frozenNodeOutputs: FrozenNodeOutputsByGraph,
  graphId: GraphId,
  target: ExecutorSessionTarget | null | undefined,
): { frozenNodeOutputs: FrozenNodeOutputsByGraph; graphId: GraphId } | undefined {
  return canUseFrozenNodeOutputsForExecutorTarget(target) ? { frozenNodeOutputs, graphId } : undefined;
}

const REMOTE_DEBUGGER_NON_RUN_EVENT_MESSAGES = new Set<keyof ProcessEventMessageMap>(['trace', 'webAppStoragePatch']);

export function shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent(options: {
  alreadyFlushed: boolean;
  message: keyof ProcessEventMessageMap;
  shouldDispatchExecutionEvent: boolean;
  target: ExecutorSessionTarget | null | undefined;
}): boolean {
  return (
    options.target?.type === 'external-debugger' &&
    options.shouldDispatchExecutionEvent &&
    !options.alreadyFlushed &&
    !REMOTE_DEBUGGER_NON_RUN_EVENT_MESSAGES.has(options.message)
  );
}

function canUseFrozenNodeOutputsForExecutorTarget(target: ExecutorSessionTarget | null | undefined): boolean {
  return target?.type === 'internal-desktop' || target?.type === 'internal-hosted';
}

export type EditorRunFromPlan = {
  nodesToRun: NodeId[];
  preserveNodeIds: NodeId[];
  preloadNodeIds: NodeId[];
  runToNodeIds: NodeId[];
};

export type EditorRunToPlan = {
  nodesToRun: NodeId[];
  preserveNodeIds: NodeId[];
  runToNodeIds: NodeId[];
};

type EditorExecutionTopology = {
  connections: NodeConnection[];
  nodeIds: NodeId[];
  nodes: ChartNode[];
};

/**
 * Editor partial-run planning must use the same authored-to-runtime topology
 * conversion as GraphProcessor. In particular, a Data Bus is not executable:
 * its channels compile into direct dependencies between ordinary nodes.
 */
function getEditorExecutionTopology(project: Project, graph: NodeGraph): EditorExecutionTopology {
  const compiledTopology = compileDataBusTopology({
    connections: graph.connections,
    graphNodes: graph.nodes.map((node) => resolveNodePrefabInstance(project, node)),
  });

  return {
    connections: compiledTopology.connections,
    nodeIds: compiledTopology.executionNodes.map((node) => node.id),
    nodes: compiledTopology.executionNodes,
  };
}

function assertEditorRunTargetIsExecutable(options: {
  graph: NodeGraph;
  nodeId: NodeId;
  project: Project;
  runKind: 'from' | 'to';
}): void {
  const node = options.graph.nodes.find((candidate) => candidate.id === options.nodeId);
  if (!node) {
    return;
  }

  const effectiveNode = resolveNodePrefabInstance(options.project, node);
  if (isDataBusTopologyNode(effectiveNode)) {
    const targetKind = options.runKind === 'from' ? 'run-from' : 'run-to';
    throw new Error(
      `Data Bus "${effectiveNode.title}" is topology-only and cannot be used as a ${targetKind} target. ` +
        'Run an ordinary provider or consumer node instead.',
    );
  }
}

export function getEditorRunFromPlan(
  project: Project,
  graphId: GraphId,
  from: NodeId,
  projectNodeRegistry: NodeRegistration<any, any>,
): EditorRunFromPlan {
  const graph = project.graphs[graphId];
  if (!graph) {
    throw new Error(`Graph ${graphId} was not found, cannot plan run-from execution`);
  }

  if (!graph.nodes.some((node) => node.id === from)) {
    throw new Error(`Node ${from} was not found in graph ${graphId}, cannot plan run-from execution`);
  }

  assertEditorRunTargetIsExecutable({ graph, nodeId: from, project, runKind: 'from' });

  const processor = new GraphProcessor(project, graphId, projectNodeRegistry, true);
  const executionTopology = getEditorExecutionTopology(project, graph);
  const graphNodeIds = executionTopology.nodeIds;
  const dependenciesByNodeId = new Map<NodeId, Set<NodeId>>();

  for (const node of executionTopology.nodes) {
    dependenciesByNodeId.set(node.id, new Set(processor.getDependencyNodesDeep(node.id)));
  }

  const asyncTriggerAncestor = executionTopology.nodes.find((effectiveNode) => {
    return (
      effectiveNode.id !== from &&
      effectiveNode.type === 'startBackgroundBranch' &&
      !effectiveNode.disabled &&
      dependenciesByNodeId.get(from)?.has(effectiveNode.id)
    );
  });
  if (asyncTriggerAncestor) {
    throw new Error(
      `Node ${from} is inside the async branch started by ${asyncTriggerAncestor.id}. ` +
        'Run from the Start Async Branch node when you intend to replay that branch.',
    );
  }

  const nodesToRunSet = new Set<NodeId>([from]);
  for (const nodeId of graphNodeIds) {
    if (dependenciesByNodeId.get(nodeId)?.has(from)) {
      nodesToRunSet.add(nodeId);
    }
  }
  const nodesToRun = graphNodeIds.filter((nodeId) => nodesToRunSet.has(nodeId));

  const preloadNodeSet = new Set<NodeId>();
  for (const connection of executionTopology.connections) {
    if (
      nodesToRunSet.has(connection.inputNodeId) &&
      !nodesToRunSet.has(connection.outputNodeId) &&
      dependenciesByNodeId.get(connection.inputNodeId)?.has(connection.outputNodeId)
    ) {
      preloadNodeSet.add(connection.outputNodeId);
    }
  }

  const runToNodeSet = new Set<NodeId>();
  for (const nodeId of nodesToRun) {
    const hasDownstreamNodeInRun = nodesToRun.some(
      (candidateNodeId) => candidateNodeId !== nodeId && dependenciesByNodeId.get(candidateNodeId)?.has(nodeId),
    );

    if (!hasDownstreamNodeInRun) {
      runToNodeSet.add(nodeId);
    }
  }

  if (runToNodeSet.size === 0) {
    runToNodeSet.add(from);
  }

  return {
    nodesToRun,
    preserveNodeIds: graphNodeIds.filter((nodeId) => !nodesToRunSet.has(nodeId)),
    preloadNodeIds: graphNodeIds.filter((nodeId) => preloadNodeSet.has(nodeId)),
    runToNodeIds: graphNodeIds.filter((nodeId) => runToNodeSet.has(nodeId)),
  };
}

export function getEditorRunToPlan(
  project: Project,
  graphId: GraphId,
  to: NodeId[],
  projectNodeRegistry: NodeRegistration<any, any>,
  options: { frozenNodeOutputs?: FrozenNodeOutputsByGraph } = {},
): EditorRunToPlan {
  const graph = project.graphs[graphId];
  if (!graph) {
    throw new Error(`Graph ${graphId} was not found, cannot plan run-to execution`);
  }

  for (const nodeId of to) {
    assertEditorRunTargetIsExecutable({ graph, nodeId, project, runKind: 'to' });
  }

  const processor = new GraphProcessor(project, graphId, projectNodeRegistry, true);
  const executionTopology = getEditorExecutionTopology(project, graph);
  const graphNodeIds = executionTopology.nodeIds;
  const graphNodeIdSet = new Set(graphNodeIds);
  const runToNodeIds = to.filter((nodeId) => graphNodeIdSet.has(nodeId));
  const nodesToRunSet = new Set<NodeId>();

  for (const nodeId of runToNodeIds) {
    nodesToRunSet.add(nodeId);
    for (const dependencyNodeId of processor.getDependencyNodesDeep(nodeId)) {
      nodesToRunSet.add(dependencyNodeId);
    }
  }

  const frozenNodeOutputsByNode = options.frozenNodeOutputs?.[graphId];
  const frozenNodeIds = new Set(
    frozenNodeOutputsByNode
      ? Object.entries(frozenNodeOutputsByNode)
          .filter(([, outputInstances]) => outputInstances?.length)
          .map(([nodeId]) => nodeId as NodeId)
      : [],
  );

  return {
    nodesToRun: graphNodeIds.filter((nodeId) => nodesToRunSet.has(nodeId)),
    preserveNodeIds: graphNodeIds.filter((nodeId) => frozenNodeIds.has(nodeId) && !nodesToRunSet.has(nodeId)),
    runToNodeIds,
  };
}

export function canPreloadEditorRunFromPlan(
  plan: EditorRunFromPlan,
  previousRunData: RunDataByNodeId,
  options: { frozenNodeOutputs?: FrozenNodeOutputsByGraph; graphId?: GraphId } = {},
): boolean {
  return getUnavailablePreloadNodeIds(plan.preloadNodeIds, previousRunData, options).length === 0;
}

export function getUnavailablePreloadNodeIds(
  preloadNodeIds: NodeId[],
  previousRunData: RunDataByNodeId,
  options: { frozenNodeOutputs?: FrozenNodeOutputsByGraph; graphId?: GraphId } = {},
): NodeId[] {
  return preloadNodeIds.filter((nodeId) => {
    if (getFrozenNodePreloadOutput(options.frozenNodeOutputs, options.graphId, nodeId)) {
      return false;
    }

    const latestExecutionWithOutput = findLatestExecutionWithOutput(previousRunData[nodeId]);
    const outputData = latestExecutionWithOutput?.data.outputData;

    return !hasStoredPortMapValues(outputData) || hasUnavailableStoredRefs(outputData, dataRefs);
  });
}

function findLatestExecutionWithOutput(executions: ProcessDataForNode[] | undefined) {
  if (!executions) {
    return undefined;
  }

  for (let index = executions.length - 1; index >= 0; index--) {
    if (hasStoredPortMapValues(executions[index]?.data.outputData)) {
      return executions[index];
    }
  }

  return undefined;
}

export function selectTestSuitesToRun<T extends { id: string; testCases: { id: string }[] }>(
  testSuites: T[],
  options: { testSuiteIds?: string[]; testCaseIds?: string[] },
): T[] {
  return options.testSuiteIds
    ? testSuites
        .filter((testSuite) => options.testSuiteIds!.includes(testSuite.id))
        .map((testSuite) => ({
          ...testSuite,
          testCases: options.testCaseIds
            ? testSuite.testCases.filter((testCase) => options.testCaseIds?.includes(testCase.id))
            : testSuite.testCases,
        }))
    : testSuites;
}

export function createProcessEventDispatcher(currentExecution: {
  onAbort: (event: ProcessEvents['abort']) => void;
  onDone: (event: ProcessEvents['done']) => void;
  onError: (event: ProcessEvents['error']) => void;
  onGraphAbort: (event: ProcessEvents['graphAbort']) => void;
  onGraphError: (event: ProcessEvents['graphError']) => void;
  onGraphFinish: (event: ProcessEvents['graphFinish']) => void;
  onGraphStart: (event: ProcessEvents['graphStart']) => void;
  onNodeError: (event: ProcessEvents['nodeError']) => void;
  onNodeExcluded: (event: ProcessEvents['nodeExcluded']) => void;
  onNodeFinish: (event: ProcessEvents['nodeFinish']) => void;
  onNodeOutputsCleared: (event: ProcessEvents['nodeOutputsCleared']) => void;
  onNodeStart: (event: ProcessEvents['nodeStart']) => void;
  onPartialOutput: (event: ProcessEvents['partialOutput']) => void;
  onLlmCallFinished: (event: ProcessEvents['llmCallFinished']) => void;
  onToolCallFinished: (event: ProcessEvents['toolCallFinished']) => void;
  onPause: () => void;
  onResume: () => void;
  onStart: (event: ProcessEvents['start']) => void;
  onUserInput: (event: ProcessEvents['userInput']) => void;
  onRunActivityEvent: <K extends keyof ProcessEventMessageMap>(message: K, data: ProcessEventMessageMap[K]) => void;
}) {
  const dispatchRunActivityEvent = <K extends keyof ProcessEventMessageMap>(
    message: K,
    data: ProcessEventMessageMap[K],
  ) => dispatchGraphExecutionEvent(`Run Activity ${message}`, () => currentExecution.onRunActivityEvent(message, data));

  const dispatchWithRunActivity = <K extends keyof ProcessEventMessageMap>(
    message: K,
    data: ProcessEventMessageMap[K],
    dispatchPrimary: () => void,
  ) => {
    // Run Activity is an observer. Its reducer must never suppress the
    // editor's existing execution-state update if the projection fails.
    dispatchRunActivityEvent(message, data);
    return dispatchGraphExecutionEvent(message, dispatchPrimary);
  };

  return {
    nodeStart: (data: unknown) =>
      dispatchWithRunActivity('nodeStart', data as ProcessEvents['nodeStart'], () =>
        currentExecution.onNodeStart(data as ProcessEvents['nodeStart']),
      ),
    nodeFinish: (data: unknown) =>
      dispatchWithRunActivity('nodeFinish', data as ProcessEvents['nodeFinish'], () =>
        currentExecution.onNodeFinish(data as ProcessEvents['nodeFinish']),
      ),
    nodeError: (data: unknown) =>
      dispatchWithRunActivity('nodeError', data as ProcessEvents['nodeError'], () =>
        currentExecution.onNodeError(data as ProcessEvents['nodeError']),
      ),
    userInput: (data: unknown) => {
      const event = data as ProcessEvents['userInput'];

      // Recording playback re-emits historical questions so Run Activity can
      // show the original wait. The recorded answer has already been applied,
      // so this is strictly an observer event, not a new modal interaction.
      if (event.isReplay) {
        return dispatchRunActivityEvent('userInput', event);
      }

      return dispatchWithRunActivity('userInput', event, () => currentExecution.onUserInput(event));
    },
    start: (data: unknown) =>
      dispatchWithRunActivity('start', data as ProcessEvents['start'], () =>
        currentExecution.onStart(data as ProcessEvents['start']),
      ),
    done: (data: unknown) =>
      dispatchWithRunActivity('done', data as ProcessEvents['done'], () =>
        currentExecution.onDone(data as ProcessEvents['done']),
      ),
    abort: (data: unknown) =>
      dispatchWithRunActivity('abort', data as ProcessEvents['abort'], () =>
        currentExecution.onAbort(data as ProcessEvents['abort']),
      ),
    graphOutputsReady: (data: unknown) =>
      dispatchRunActivityEvent('graphOutputsReady', data as ProcessEvents['graphOutputsReady']),
    graphAbort: (data: unknown) =>
      dispatchWithRunActivity('graphAbort', data as ProcessEvents['graphAbort'], () =>
        currentExecution.onGraphAbort(data as ProcessEvents['graphAbort']),
      ),
    graphError: (data: unknown) =>
      dispatchWithRunActivity('graphError', data as ProcessEvents['graphError'], () =>
        currentExecution.onGraphError(data as ProcessEvents['graphError']),
      ),
    partialOutput: (data: unknown) =>
      dispatchWithRunActivity('partialOutput', data as ProcessEvents['partialOutput'], () =>
        currentExecution.onPartialOutput(data as ProcessEvents['partialOutput']),
      ),
    llmCallFinished: (data: unknown) =>
      dispatchWithRunActivity('llmCallFinished', data as ProcessEvents['llmCallFinished'], () =>
        currentExecution.onLlmCallFinished(data as ProcessEvents['llmCallFinished']),
      ),
    toolCallFinished: (data: unknown) =>
      dispatchWithRunActivity('toolCallFinished', data as ProcessEvents['toolCallFinished'], () =>
        currentExecution.onToolCallFinished(data as ProcessEvents['toolCallFinished']),
      ),
    graphStart: (data: unknown) =>
      dispatchWithRunActivity('graphStart', data as ProcessEvents['graphStart'], () =>
        currentExecution.onGraphStart(data as ProcessEvents['graphStart']),
      ),
    graphFinish: (data: unknown) =>
      dispatchWithRunActivity('graphFinish', data as ProcessEvents['graphFinish'], () =>
        currentExecution.onGraphFinish(data as ProcessEvents['graphFinish']),
      ),
    nodeOutputsCleared: (data: unknown) =>
      dispatchWithRunActivity('nodeOutputsCleared', data as ProcessEvents['nodeOutputsCleared'], () =>
        currentExecution.onNodeOutputsCleared(data as ProcessEvents['nodeOutputsCleared']),
      ),
    progress: (data: unknown) =>
      dispatchRunActivityEvent('progress', data as ProcessEvents['progress']),
    pause: (data: unknown) => {
      const event = data as ProcessEvents['pause'];
      return event?.isReplay
        ? dispatchRunActivityEvent('pause', event)
        : dispatchWithRunActivity('pause', event, () => currentExecution.onPause());
    },
    resume: (data: unknown) => {
      const event = data as ProcessEvents['resume'];
      return event?.isReplay
        ? dispatchRunActivityEvent('resume', event)
        : dispatchWithRunActivity('resume', event, () => currentExecution.onResume());
    },
    error: (data: unknown) =>
      dispatchWithRunActivity('error', data as ProcessEvents['error'], () =>
        currentExecution.onError(data as ProcessEvents['error']),
      ),
    nodeExcluded: (data: unknown) =>
      dispatchWithRunActivity('nodeExcluded', data as ProcessEvents['nodeExcluded'], () =>
        currentExecution.onNodeExcluded(data as ProcessEvents['nodeExcluded']),
      ),
  } as const;
}

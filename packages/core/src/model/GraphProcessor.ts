import {
  type DataValue,
  type StringArrayDataValue,
  type ControlFlowExcludedDataValue,
  type ScalarOrArrayDataValue,
} from './DataValue.js';
import type { NodeInputs, NodeOutputs } from './NodeIO.js';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from './NodeBase.js';
import type { GraphId, NodeGraph } from './NodeGraph.js';
import type { NodeImpl } from './NodeImpl.js';
import PQueue from '../utils/pQueueCompat.js';
import { getError } from '../utils/errors.js';
import Emittery from 'emittery';
import { type ProjectId, type Project, type ProjectReference } from './Project.js';
import { nanoid } from 'nanoid/non-secure';
import type {
  GraphExecutionMetadata,
  GraphRunId,
  InternalProcessContext,
  ProcessContext,
  ProcessId,
  RootRunId,
  ChatV2CallTraceEvent,
  ToolCallFinishedEvent,
} from './ProcessContext.js';
import type { ExecutionRecorder } from '../recording/ExecutionRecorder.js';
import type { Tagged } from 'type-fest';
import { coerceTypeOptional } from '../utils/coerceType.js';
import type { BuiltInNodes } from './Nodes.js';
import type { NodeRegistration } from './NodeRegistration.js';
import { getPluginConfig } from '../utils/index.js';
import {
  type GraphExecutionPlan,
  type GraphPreprocessedState,
  isGraphExecutionPlan,
  preprocessGraphState,
  toReusableGraphExecutionPlan,
} from './GraphPreprocessor.js';
import { getGraphBoundary, type GraphBoundary, type GraphBoundaryCache } from './GraphBoundaryCache.js';
import { applyFrozenGraphBoundaryEffects, ensureGraphCostOutput } from './GraphBoundaryEffects.js';
import { replayExecutionRecording } from './RecordingPlayer.js';
import { didLoopControllerBreak, LOOP_NOT_BROKEN_SENTINEL } from './loopControllerBreak.js';
import { buildNodeProcessContext, type NodeProcessContextBase } from './ProcessContextBuilder.js';
import { processSplitRunNode } from './SplitRunProcessor.js';
import {
  type ExecutionState,
  getInputNodesTo,
  getMissingRequiredInputs,
  getOutputNodesFrom,
  getStartNodes,
  getWaitingForInputNode,
  hasErroredInputNode,
} from './NodeExecutionPlanner.js';
import { wireSubprocessorEvents, wireSubprocessorLifecycle } from './SubprocessorBridge.js';
import {
  createGraphAbortError,
  createGraphAbortErrorFromSignal,
  createGraphAbortReason,
  getAbortSignalReason,
  getGraphAbortReasonFromError,
  getGraphAbortReasonFromSignal,
  isAbortLikeError,
  isRaceLoserGraphAbortReason,
  isSuccessfulNonRaceGraphAbortReason,
  RACE_LOSER_EXCLUSION_REASON,
  SUCCESSFUL_GRAPH_ABORT_EXCLUSION_REASON,
} from './GraphAbortReasons.js';
import { emitDetached } from '../utils/emitDetached.js';
import { GraphRunLifecycle } from './GraphRunLifecycle.js';
import { normalizeGraphProgress, type GraphProgress } from './GraphProgress.js';
import { RIVET_WEB_APP_STATUS_FUNCTION_NAME, rivetWebAppStatusExternalFunction } from './UiGraphWebAppStatus.js';
import { RivetStoredValueController, type RivetStoredValueStore } from './StoredValueStore.js';
import {
  createExcludedNodeOutputs,
  getControlFlowExclusionDecision,
  getMissingRequiredInputExclusion,
} from './NodeExclusionPolicy.js';
import type { StreamedFunctionCall } from './chat/streamChatResponse.js';
import { resolveToolContinuationConnection } from './chat-v2/toolContinuationConnection.js';
import type { DelegateFunctionCallNode } from './nodes/DelegateFunctionCallNode.js';
import { buildDelegatedToolCallOutputs, isDelegatedToolCallRecord } from './nodes/toolCallDelegation.js';
import type { ToolCallContinuation, ToolCallContinuationResult } from './ToolCallContinuation.js';
import {
  ToolCallContinuationCoordinator,
  type ToolCallContinuationBranchRunResult,
  type ToolCallContinuationCoordinatorAdapter,
} from './ToolCallContinuationCoordinator.js';
import {
  createToolCallContinuationBranchPlanner,
  type ToolCallContinuationAsyncBranchPlan,
  type ToolCallContinuationBranchPlan,
  type ToolCallContinuationBranchPlanner,
} from './ToolCallContinuationBranchPlanner.js';
import { ManagedAsyncBranches } from './ManagedAsyncBranches.js';
import type { RivetKnowledgeStoreRegistry } from '../integrations/KnowledgeStore.js';
import { KnowledgeStoreController } from '../integrations/KnowledgeStoreProvider.js';
import { isDataBusTopologyNode } from './DataBusTopology.js';
import { resolveNodePrefabInstance } from './NodePrefabResolver.js';

// eslint-disable-next-line import/no-cycle -- There has to be a cycle because CodeRunner needs to import the entirety of Rivet
import { IsomorphicCodeRunner } from '../integrations/CodeRunner.js';

type WithExecution<T extends object> = T & { execution: GraphExecutionMetadata };
type NodeTimingStart = number | undefined;
type NodeAbortControllerEntry = AbortController | Set<AbortController>;
const graphProcessorGraphOverride = Symbol('graphProcessorGraphOverride');
const consumedAsyncBranchTriggerOverride = Symbol('consumedAsyncBranchTriggerOverride');
type ManagedAsyncBranchFailure = {
  error: Error;
  triggerNode: ChartNode;
  nodeErrors: Array<{ error: Error | string; node: ChartNode }>;
};
type ToolCallContinuationInvocation = {
  delegateNode: DelegateFunctionCallNode;
  latestOutputs: Map<NodeId, Outputs>;
  llmNodeId: NodeId;
  llmProcessId: ProcessId;
  released: boolean;
};

function createGraphOutputsOverlay(parent: GraphOutputs): { view: GraphOutputs; writes: GraphOutputs } {
  const writes: GraphOutputs = {};
  const view = new Proxy(writes, {
    get: (target, property, receiver) =>
      Reflect.has(target, property) ? Reflect.get(target, property, receiver) : Reflect.get(parent, property),
    getOwnPropertyDescriptor: (target, property) =>
      Reflect.getOwnPropertyDescriptor(target, property) ?? Reflect.getOwnPropertyDescriptor(parent, property),
    has: (target, property) => Reflect.has(target, property) || Reflect.has(parent, property),
    ownKeys: (target) => [...new Set([...Reflect.ownKeys(parent), ...Reflect.ownKeys(target)])],
  });
  return { view, writes };
}

export type NodeResultOrigin = 'executed' | 'preloaded' | 'frozen' | 'editor-cache' | 'unknown';

export type ProcessEvents = {
  /** Called when processing has started. */
  start: WithExecution<{
    project: Project;
    startGraph: NodeGraph;
    inputs: GraphInputs;
    contextValues: Record<string, DataValue>;
  }>;

  /** Called when a graph or subgraph has started. */
  graphStart: WithExecution<{ graph: NodeGraph; inputs: GraphInputs }>;

  /** Called when a graph or subgraph has errored. */
  graphError: WithExecution<{ graph: NodeGraph; error: Error | string }>;

  /** Called when a graph or a subgraph has finished. */
  graphFinish: WithExecution<{ graph: NodeGraph; outputs: GraphOutputs }>;

  /** Called when root graph outputs are ready while managed async branches are still settling. */
  graphOutputsReady: WithExecution<{ graph: NodeGraph; outputs: GraphOutputs }>;

  /** Called when a graph has been aborted. */
  graphAbort: WithExecution<{ successful: boolean; graph: NodeGraph; error?: Error | string }>;

  /** Called when a node has started processing, with the input values for the node. */
  nodeStart: WithExecution<{
    node: ChartNode;
    inputs: Inputs;
    /** Effective, value-free producer edges after Data Bus preprocessing. */
    inputConnections?: NodeConnection[];
    processId: ProcessId;
    resultOrigin?: NodeResultOrigin;
  }>;

  /** Called when a node has finished processing, with the output values for the node. */
  nodeFinish: WithExecution<{
    node: ChartNode;
    outputs: Outputs;
    processId: ProcessId;
    resultOrigin?: NodeResultOrigin;
    durationMs?: number;
    splitRunDurationMs?: Record<number, number>;
  }>;

  /** Called when a node has errored during processing. */
  nodeError: WithExecution<{
    node: ChartNode;
    error: Error | string;
    processId: ProcessId;
    resultOrigin?: NodeResultOrigin;
    durationMs?: number;
    splitRunDurationMs?: Record<number, number>;
  }>;

  /** Called when a node has been excluded from processing. */
  nodeExcluded: WithExecution<{
    node: ChartNode;
    processId: ProcessId;
    inputs: Inputs;
    outputs: Outputs;
    reason: string;
    resultOrigin?: NodeResultOrigin;
  }>;

  /** Called when a user input node requires user input. Call the callback when finished, or call userInput() on the GraphProcessor with the results. */
  userInput: WithExecution<{
    node: ChartNode;
    inputStrings: string[];

    /** @deprecated use inputStrings instead */
    inputs: Inputs;

    callback: (values: StringArrayDataValue) => void;
    processId: ProcessId;

    renderingType: 'text' | 'markdown';

    /**
     * Present only when RecordingPlayer re-emits a historical prompt. It is
     * display-only: hosts must project it to observability without asking the
     * user for input again.
     */
    isReplay?: true;
  }>;

  /** Called when a node has partially processed, with the current partial output values for the node. */
  partialOutput: WithExecution<{
    node: ChartNode;
    outputs: Outputs;
    index: number;
    processId: ProcessId;
    resultOrigin?: NodeResultOrigin;
  }>;

  /** Called when a node reports host-facing progress. */
  progress: WithExecution<{ node: ChartNode; processId: ProcessId; progress: GraphProgress }>;

  /** Privacy-bounded metadata for one physical LLM provider call. */
  llmCallFinished: WithExecution<ChatV2CallTraceEvent>;

  /** Privacy-bounded metadata for one delegated tool execution. */
  toolCallFinished: WithExecution<ToolCallFinishedEvent>;

  /** Called when the outputs of a node have been cleared entirely. If processId is present, only the one process() should be cleared. */
  nodeOutputsCleared: WithExecution<{ node: ChartNode; processId?: ProcessId }>;

  /** Called when the root graph has errored. The root graph will also throw. */
  error: { error: Error | string };

  /** Called when processing has completed. */
  done: { results: GraphOutputs };

  /** Called when processing has been aborted. */
  abort: { successful: boolean; error?: string | Error };

  /** Called when processing has finished either successfully or unsuccessfully. */
  finish: void;

  /** Called for trace level logs. */
  trace: string;

  /** Called when the graph has been paused. Historical playback pauses are display-only. */
  pause: { isReplay?: true } | undefined;

  /** Called when the graph has been resumed. Historical playback resumes are display-only. */
  resume: { isReplay?: true } | undefined;

  /** Called when a global variable has been set in a graph. */
  globalSet: WithExecution<{ id: string; value: ScalarOrArrayDataValue; processId: ProcessId }>;

  /** Called when an AbortController has been created. Used by node to increase the max event listeners. */
  newAbortController: AbortController;
} & {
  /** Listen for any user event. */
  [key: `userEvent:${string}`]: DataValue | undefined;
} & {
  [key: `globalSet:${string}`]: ScalarOrArrayDataValue | undefined;
};

export type ProcessEvent = {
  [P in keyof ProcessEvents]: { type: P } & ProcessEvents[P];
}[keyof ProcessEvents];

export type GraphOutputs = Record<string, DataValue>;
export type GraphInputs = Record<string, DataValue>;

export type NodeResults = Map<NodeId, Outputs>;
export type Inputs = NodeInputs;
export type Outputs = NodeOutputs;

export type FrozenNodeOutputsByGraph = Record<GraphId, Record<NodeId, Outputs[] | undefined> | undefined>;

export type FrozenNodeOutputResolverRequest = {
  execution: GraphExecutionMetadata;
  graphId: GraphId;
  inputs: Inputs;
  node: ChartNode;
  processId: ProcessId;
};

export type FrozenNodeOutputResolver = (request: FrozenNodeOutputResolverRequest) => Outputs | undefined;

export function cloneFrozenNodeOutputs(outputs: Outputs): Outputs {
  if (typeof structuredClone !== 'function') {
    throw new Error('Frozen node output cloning requires structuredClone support');
  }

  return structuredClone(outputs) as Outputs;
}

export function cloneFrozenNodeOutputsByGraph(outputsByGraph: FrozenNodeOutputsByGraph): FrozenNodeOutputsByGraph {
  return Object.fromEntries(
    Object.entries(outputsByGraph).map(([graphId, outputsByNode]) => [
      graphId,
      outputsByNode
        ? Object.fromEntries(
            Object.entries(outputsByNode).map(([nodeId, outputInstances]) => [
              nodeId,
              outputInstances?.map((outputs) => cloneFrozenNodeOutputs(outputs)),
            ]),
          )
        : undefined,
    ]),
  ) as FrozenNodeOutputsByGraph;
}

export function hasFrozenNodeOutputs(outputsByGraph: FrozenNodeOutputsByGraph | undefined): boolean {
  if (!outputsByGraph) {
    return false;
  }

  return Object.values(outputsByGraph).some((outputsByNode) =>
    Object.values(outputsByNode ?? {}).some((outputInstances) => (outputInstances?.length ?? 0) > 0),
  );
}

export function createFrozenNodeOutputResolver(
  outputsByGraph: FrozenNodeOutputsByGraph | undefined,
): FrozenNodeOutputResolver | undefined {
  if (!hasFrozenNodeOutputs(outputsByGraph)) {
    return undefined;
  }

  const countersByGraphRunAndNode = new Map<string, number>();

  return ({ execution, graphId, node }) => {
    const outputInstances = outputsByGraph?.[graphId]?.[node.id];
    if (!outputInstances?.length) {
      return undefined;
    }

    const counterKey = `${execution.graphRunId}:${graphId}:${node.id}`;
    const currentIndex = countersByGraphRunAndNode.get(counterKey) ?? 0;
    countersByGraphRunAndNode.set(counterKey, currentIndex + 1);

    return cloneFrozenNodeOutputs(outputInstances[Math.min(currentIndex, outputInstances.length - 1)]!);
  };
}

export type ExternalFunctionProcessContext = Omit<InternalProcessContext, 'setGlobal'>;

export type ExternalFunction = (
  context: ExternalFunctionProcessContext,
  ...args: unknown[]
) => Promise<DataValue & { cost?: number }>;

export type GraphProcessorConcurrency = {
  nodeConcurrency?: number;
  splitRunConcurrency?: number;
};

export type GraphProcessorRuntimeCache = {
  executionPlanNodePrefabs?: WeakMap<NodeGraph, Project['nodePrefabs']>;
  executionPlans?: WeakMap<NodeGraph, GraphExecutionPlan>;
  graphBoundaries?: GraphBoundaryCache;
  loadedProjects?: Record<ProjectId, Project>;
};

export type GraphProcessorExecutionPlanCacheMode = 'all' | 'subprocessors';

export type GraphProcessorScheduler = 'compatible' | 'fast-acyclic';

export type GraphProcessorRuntimeProfileBucket =
  | 'initializeGraphRun'
  | 'loadProjectReferences'
  | 'prepareNodeProcessContextBase'
  | 'preprocessGraph'
  | 'emitGraphStart'
  | 'emitPreloadedNodeResults'
  | 'waitUntilUnpaused'
  | 'processFastAcyclicGraph'
  | 'processCompatibleGraph'
  | 'drainManagedAsyncBranches'
  | 'throwIfGraphErrored'
  | 'finalizeGraphRun'
  | 'emitFinish'
  | 'fetchNodeDataAndProcessNode'
  | 'getInputNodesTo'
  | 'getInputValuesForNode'
  | 'nodeDispatch'
  | 'nodeImplementation'
  | 'createNodeProcessContext'
  | 'getOutputNodesFrom'
  | 'queueOutputNodes'
  | 'createSubProcessor'
  | 'wireSubProcessorEvents'
  | 'wireSubProcessorLifecycle';

export type GraphProcessorRuntimeProfiler = {
  addDuration: (bucket: GraphProcessorRuntimeProfileBucket, durationMs: number) => void;
};

const DEFAULT_NODE_CONCURRENCY = 8;
export const DEFAULT_SPLIT_RUN_CONCURRENCY = 4;
const DEFAULT_ISOMORPHIC_CODE_RUNNER = new IsomorphicCodeRunner();
const FAST_ACYCLIC_UNSUPPORTED_NODE_TYPES = new Set<string>([
  'loopController',
  'loopUntil',
  'raceInputs',
  'startBackgroundBranch',
  'userInput',
  'waitForEvent',
]);

function getMonotonicTimeMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

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

function normalizeConcurrencyValue(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function resolveGraphProcessorConcurrency(
  concurrency: GraphProcessorConcurrency | undefined,
): Required<GraphProcessorConcurrency> {
  return {
    nodeConcurrency: normalizeConcurrencyValue(concurrency?.nodeConcurrency, DEFAULT_NODE_CONCURRENCY),
    splitRunConcurrency: normalizeConcurrencyValue(concurrency?.splitRunConcurrency, DEFAULT_SPLIT_RUN_CONCURRENCY),
  };
}

function resolveProcessorGraph(project: Project, graphId: GraphId | undefined): NodeGraph | undefined {
  if (graphId) {
    return project.graphs[graphId];
  }

  return project.metadata.mainGraphId ? project.graphs[project.metadata.mainGraphId] : undefined;
}

function replaceRecordContents<TKey extends string, TValue>(
  target: Record<TKey, TValue>,
  source: Record<TKey, TValue>,
): void {
  if (target === source) {
    return;
  }

  for (const key of Object.keys(target) as TKey[]) {
    delete target[key];
  }

  Object.assign(target, source);
}

export type RaceId = Tagged<string, 'RaceId'>;

export type LoopInfo = AttachedNodeDataItem & {
  /** ID of the controller of the loop */
  loopControllerId: NodeId;

  /** Nodes add themselves to this as the loop processes */
  nodes: Set<NodeId>;

  iterationCount: number;
};

export type AttachedNodeDataItem = {
  propagate: boolean | ((parent: ChartNode, connections: NodeConnection[]) => boolean);
};

export type AttachedNodeData = {
  loopInfo?: LoopInfo;
  races?: {
    propagate: boolean;
    raceIds: RaceId[];

    // The race is completed by some branch
    completed: boolean;
  };

  [key: string]: AttachedNodeDataItem | undefined;
};

export class GraphProcessor {
  // Per-instance state
  readonly #graph: NodeGraph;
  readonly #project: Project;
  readonly #nodesById: Record<NodeId, ChartNode>;
  readonly #nodeInstances: Record<NodeId, NodeImpl<ChartNode>>;
  readonly #connections: Record<NodeId, NodeConnection[]>;
  readonly #emitter: Emittery<ProcessEvents> = new Emittery();
  readonly #lifecycle = new GraphRunLifecycle();
  #isSubProcessor = false;
  #externalFunctions: Record<string, ExternalFunction> = {};
  slowMode = false;
  #parent: GraphProcessor | undefined;
  #abortOwnerOverride: GraphProcessor | undefined;
  #sameGraphRunOwnerOverride: GraphProcessor | undefined;
  #suppressGraphPartialOutputs = false;
  #suppressGraphLifecycleEvents = false;
  #executionIdentityOverride: Pick<GraphExecutionMetadata, 'rootRunId' | 'graphRunId' | 'parentGraphRunId'> | undefined;
  #sharedRunStateOverride:
    | {
        attachedNodeData: Map<NodeId, AttachedNodeData>;
        graphInputNodeValues: Record<string, DataValue>;
        graphOutputs: GraphOutputs;
      }
    | undefined;
  readonly #suppressedPreloadedNodeIds = new Set<NodeId>();
  readonly #preloadedNodeResults: NodeResults = new Map();
  #toolCallContinuationInvocations = new Map<string, ToolCallContinuationInvocation>();
  #continuationCompletionOwnerByNodeId = new Map<NodeId, NodeId>();
  #effectiveConnectionsForRun: NodeConnection[] | undefined;
  #asyncBranchPlansByTriggerNodeId = new Map<NodeId, ToolCallContinuationAsyncBranchPlan>();
  readonly #consumedAsyncBranchTriggerNodeId: NodeId | undefined;
  readonly #registry: NodeRegistration<any, any>;
  readonly #concurrency: Required<GraphProcessorConcurrency>;
  readonly #executionPlanCacheMode: GraphProcessorExecutionPlanCacheMode;
  readonly #runtimeCache: GraphProcessorRuntimeCache | undefined;
  readonly #cacheLoadedProjects: boolean;
  readonly #scheduler: GraphProcessorScheduler;
  readonly #runtimeProfiler: GraphProcessorRuntimeProfiler | undefined;
  readonly #captureNodeTimings: boolean;
  #frozenNodeOutputResolver: FrozenNodeOutputResolver | undefined;
  #storedValueStore: RivetStoredValueStore | undefined;
  #knowledgeStores: RivetKnowledgeStoreRegistry | undefined;
  #useSeededExecutionPlanOnNextRun = false;
  id = nanoid();

  readonly #includeTrace?: boolean = true;

  executor?: 'nodejs' | 'browser';

  /** If set, specifies the node(s) that the graph will run TO, instead of the nodes without any dependents. */
  runToNodeIds?: NodeId[];

  /** If set, specifies the node that the graph will run FROM, instead of the start nodes. Requires preloading data. */
  runFromNodeId?: NodeId;

  /** The node that is executing this graph, almost always a subgraph node. Undefined for root. */
  #executor:
    | {
        nodeId: NodeId;
        parentGraphId: GraphId;
        index: number;
        processId: ProcessId;
      }
    | undefined;

  #rootRunId: RootRunId = undefined!;
  #graphRunId: GraphRunId = undefined!;
  #parentGraphRunId: GraphRunId | undefined = undefined;

  /** The interval between nodeFinish events when playing back a recording. I.e. how fast the playback is. */
  recordingPlaybackChatLatency = 1000;

  warnOnInvalidGraph = false;

  // Per-process state
  #erroredNodes: Map<NodeId, Error | string> = undefined!; // Values are strings in recordings
  #remainingNodes: Set<NodeId> = undefined!;
  #visitedNodes: Set<NodeId> = undefined!;
  #currentlyProcessing: Set<NodeId> = undefined!;
  #context: ProcessContext = undefined!;
  #nodeResults: NodeResults = undefined!;
  #abortController: AbortController = undefined!;
  #processingQueue: InstanceType<typeof PQueue> = undefined!;
  #graphInputs: GraphInputs = undefined!;
  #graphOutputs: GraphOutputs = undefined!;
  #executionCache: Map<string, unknown> = undefined!;
  #queuedNodes: Set<NodeId> = undefined!;
  #loopControllersSeen: Set<NodeId> = undefined!;
  #subprocessors: Set<GraphProcessor> = undefined!;
  #contextValues: Record<string, DataValue> = undefined!;
  #globals: Map<string, ScalarOrArrayDataValue> = undefined!;
  #storedValueController: RivetStoredValueController = undefined!;
  #knowledgeStoreController: KnowledgeStoreController = undefined!;
  #attachedNodeData: Map<NodeId, AttachedNodeData> = undefined!;
  #successfulAbortTerminalProcessIds: Set<ProcessId> = undefined!;
  #totalCost: number = 0;
  #ignoreNodes: Set<NodeId> = undefined!;
  #hasPreloadedData = false;
  #loadedProjects: Record<ProjectId, Project> = undefined!;
  #definitions: Record<NodeId, { inputs: NodeInputDefinition[]; outputs: NodeOutputDefinition[] }> = undefined!;
  #scc: ChartNode[][] = undefined!;
  #graphExecutionPlan: GraphExecutionPlan | undefined;
  #nodeProcessContextBase: NodeProcessContextBase = undefined!;
  #runToRelevantNodeIds: Set<NodeId> | undefined;
  #managedAsyncBranches: ManagedAsyncBranches | undefined;
  #managedAsyncBranchFailures: ManagedAsyncBranchFailure[] = [];
  #runCompletionPromise: Promise<GraphOutputs> | undefined;

  #nodesNotInCycle: ChartNode[] = undefined!;
  #executionGraphNodes: ChartNode[] = undefined!;

  #nodeAbortControllers = new Map<NodeId, NodeAbortControllerEntry>();

  #graphInputNodeValues: Record<string, DataValue> = {};

  /** User input nodes that are pending user input. */
  #pendingUserInputs: Record<
    NodeId,
    { resolve: (values: StringArrayDataValue) => void; reject: (error: unknown) => void }
  > = undefined!;
  #unsubscribeTokenizerError: (() => void) | undefined;

  get isRunning() {
    return this.#lifecycle.isRunning;
  }

  /** Waits for the current run's full lifecycle, including managed async branches. */
  async waitForRunCompletion(): Promise<GraphOutputs> {
    if (!this.#runCompletionPromise) {
      throw new Error('No graph run has been started.');
    }

    return await this.#runCompletionPromise;
  }

  #startNodeTiming(): NodeTimingStart {
    return this.#captureNodeTimings ? getMonotonicTimeMs() : undefined;
  }

  #finishNodeTiming(start: NodeTimingStart): number | undefined {
    if (start == null) {
      return undefined;
    }

    return Math.max(0, getMonotonicTimeMs() - start);
  }

  #startRuntimeProfile(): number | undefined {
    return this.#runtimeProfiler ? getMonotonicTimeMs() : undefined;
  }

  #finishRuntimeProfile(bucket: GraphProcessorRuntimeProfileBucket, start: number | undefined): void {
    if (start == null || !this.#runtimeProfiler) {
      return;
    }

    try {
      this.#runtimeProfiler.addDuration(bucket, Math.max(0, getMonotonicTimeMs() - start));
    } catch {
      // Runtime profiling is diagnostic only and must not affect graph execution.
    }
  }

  #profileRuntimeSync<T>(bucket: GraphProcessorRuntimeProfileBucket, run: () => T): T {
    const start = this.#startRuntimeProfile();
    try {
      return run();
    } finally {
      this.#finishRuntimeProfile(bucket, start);
    }
  }

  async #profileRuntimeAsync<T>(bucket: GraphProcessorRuntimeProfileBucket, run: () => Promise<T>): Promise<T> {
    const start = this.#startRuntimeProfile();
    try {
      return await run();
    } finally {
      this.#finishRuntimeProfile(bucket, start);
    }
  }

  constructor(
    project: Project,
    graphId: GraphId | undefined,
    registry: NodeRegistration<any, any>,
    includeTrace?: boolean,
    options?: {
      cacheLoadedProjects?: boolean;
      captureNodeTimings?: boolean;
      concurrency?: GraphProcessorConcurrency;
      executionPlanCacheMode?: GraphProcessorExecutionPlanCacheMode;
      initialExecutionPlan?: GraphExecutionPlan;
      runtimeCache?: GraphProcessorRuntimeCache;
      runtimeProfiler?: GraphProcessorRuntimeProfiler;
      scheduler?: GraphProcessorScheduler;
      [graphProcessorGraphOverride]?: NodeGraph;
      [consumedAsyncBranchTriggerOverride]?: NodeId;
    },
  ) {
    this.#project = project;
    const graph = options?.[graphProcessorGraphOverride] ?? resolveProcessorGraph(project, graphId);

    if (!graph) {
      throw new Error(`Graph ${graphId} not found in project`);
    }
    this.#graph = graph;

    this.#includeTrace = includeTrace;
    this.#nodeInstances = {};
    this.#connections = {};
    this.#nodesById = {};
    this.#registry = registry;
    this.#concurrency = resolveGraphProcessorConcurrency(options?.concurrency);
    this.#executionPlanCacheMode = options?.executionPlanCacheMode ?? 'all';
    this.#runtimeCache = options?.runtimeCache;
    this.#cacheLoadedProjects = options?.cacheLoadedProjects ?? false;
    this.#scheduler = options?.scheduler ?? 'compatible';
    this.#runtimeProfiler = options?.runtimeProfiler;
    this.#captureNodeTimings = options?.captureNodeTimings ?? false;
    this.#consumedAsyncBranchTriggerNodeId = options?.[consumedAsyncBranchTriggerOverride];

    this.#emitter.bindMethods(this as unknown as Record<string, unknown>, ['on', 'off', 'once', 'onAny', 'offAny']);

    this.setExternalFunction('echo', async (value) => ({ type: 'any', value }) satisfies DataValue);
    this.setExternalFunction(RIVET_WEB_APP_STATUS_FUNCTION_NAME, rivetWebAppStatusExternalFunction);

    this.#emitter.on('globalSet', ({ id, value }: ProcessEvents['globalSet']) => {
      emitDetached(this.#emitter, `globalSet:${id}`, value);
    });

    if (options?.initialExecutionPlan) {
      this.#applyPreprocessedGraph(options.initialExecutionPlan, { recreateNodeInstances: true });
      this.#useSeededExecutionPlanOnNextRun = true;
    }
  }

  #preprocessGraph(options: { allowRuntimeExecutionPlanCache?: boolean } = {}) {
    const profileStart = this.#startRuntimeProfile();

    try {
      const runtimeCache =
        options.allowRuntimeExecutionPlanCache === false || !this.#canUseRuntimeExecutionPlanCache()
          ? undefined
          : this.#runtimeCache;
      const shouldUseRuntimeCache = runtimeCache != null;
      const cachedPlan = runtimeCache?.executionPlans?.get(this.#graph);

      if (cachedPlan && runtimeCache?.executionPlanNodePrefabs?.get(this.#graph) === this.#project.nodePrefabs) {
        this.#applyPreprocessedGraph(cachedPlan, { recreateNodeInstances: true });
        return;
      }

      const preprocessedGraph = preprocessGraphState({
        graph: this.#graph,
        loadedProjects: this.#loadedProjects,
        project: this.#project,
        registry: this.#registry,
        warnOnInvalidGraph: this.warnOnInvalidGraph,
        buildExecutionPlan: shouldUseRuntimeCache,
        definitionContext: this.#runtimeCache
          ? {
              getGraphBoundary: (project, graphId) => this.#getGraphBoundary(project, graphId),
            }
          : undefined,
      });

      if (shouldUseRuntimeCache && isGraphExecutionPlan(preprocessedGraph)) {
        runtimeCache.executionPlans ??= new WeakMap();
        runtimeCache.executionPlanNodePrefabs ??= new WeakMap();
        runtimeCache.executionPlans.set(this.#graph, toReusableGraphExecutionPlan(preprocessedGraph));
        runtimeCache.executionPlanNodePrefabs.set(this.#graph, this.#project.nodePrefabs);
      }

      this.#applyPreprocessedGraph(preprocessedGraph);
    } finally {
      this.#finishRuntimeProfile('preprocessGraph', profileStart);
    }
  }

  #canUseRuntimeExecutionPlanCache(): boolean {
    return this.#canUseRuntimeExecutionPlanCacheFor(this.#project, this.#isSubProcessor);
  }

  #canUseRuntimeExecutionPlanCacheFor(project: Project, isSubProcessor: boolean): boolean {
    if (this.warnOnInvalidGraph || this.#runtimeCache == null) {
      return false;
    }

    if (this.#executionPlanCacheMode === 'subprocessors' && !isSubProcessor) {
      return false;
    }

    if (!this.#cacheLoadedProjects && (project.references?.length ?? 0) > 0) {
      return false;
    }

    return true;
  }

  #getGraphBoundary(project: Project, graphId: GraphId | undefined): GraphBoundary | undefined {
    if (!this.#runtimeCache) {
      return getGraphBoundary(project, graphId);
    }

    this.#runtimeCache.graphBoundaries ??= new WeakMap();
    return getGraphBoundary(project, graphId, this.#runtimeCache.graphBoundaries);
  }

  #applyPreprocessedGraph(
    preprocessedGraph: GraphPreprocessedState | GraphExecutionPlan,
    options: { recreateNodeInstances?: boolean } = {},
  ): void {
    const nodeInstances =
      options.recreateNodeInstances || !('nodeInstances' in preprocessedGraph)
        ? this.#createNodeInstances(preprocessedGraph.graphNodes)
        : preprocessedGraph.nodeInstances;

    replaceRecordContents(this.#nodeInstances, nodeInstances);
    replaceRecordContents(this.#nodesById, preprocessedGraph.nodesById);
    replaceRecordContents(this.#connections, preprocessedGraph.connections);
    this.#definitions = preprocessedGraph.definitions;
    this.#scc = preprocessedGraph.stronglyConnectedComponents;
    this.#nodesNotInCycle = preprocessedGraph.nodesNotInCycle;
    this.#executionGraphNodes = preprocessedGraph.graphNodes;
    this.#remainingNodes = new Set(this.#executionGraphNodes.map((node) => node.id));
    this.#graphExecutionPlan = isGraphExecutionPlan(preprocessedGraph) ? preprocessedGraph : undefined;
  }

  #seededExecutionPlanForNextRun(): GraphExecutionPlan | undefined {
    if (!this.#useSeededExecutionPlanOnNextRun || this.warnOnInvalidGraph) {
      return undefined;
    }

    return this.#graphExecutionPlan;
  }

  #createNodeInstances(nodes: ChartNode[]): Record<NodeId, NodeImpl<ChartNode>> {
    const nodeInstances: Record<NodeId, NodeImpl<ChartNode>> = {};

    for (const node of nodes) {
      nodeInstances[node.id] = this.#registry.createDynamicImpl(node);
    }

    return nodeInstances;
  }

  #emitTraceEvent(eventData: string) {
    if (this.#includeTrace) {
      emitDetached(this.#emitter, 'trace', eventData);
    }
  }

  #buildExecutionMetadata(): GraphExecutionMetadata {
    return {
      rootRunId: this.#rootRunId,
      graphRunId: this.#graphRunId,
      graphId: this.#graph.metadata!.id!,
      parentGraphRunId: this.#parentGraphRunId,
      executor: this.#executor
        ? {
            nodeId: this.#executor.nodeId,
            parentGraphId: this.#executor.parentGraphId,
            processId: this.#executor.processId,
            splitIndex: this.#executor.index,
          }
        : undefined,
    };
  }

  #withExecution<T extends object>(
    data: T,
    execution: GraphExecutionMetadata = this.#buildExecutionMetadata(),
  ): T & {
    execution: GraphExecutionMetadata;
  } {
    return {
      ...data,
      execution,
    };
  }

  on = undefined! as Emittery<ProcessEvents>['on'];
  off = undefined! as Emittery<ProcessEvents>['off'];
  once = undefined! as Emittery<ProcessEvents>['once'];
  onAny = undefined! as Emittery<ProcessEvents>['onAny'];
  offAny = undefined! as Emittery<ProcessEvents>['offAny'];

  readonly #onUserEventHandlers: Map<
    (event: DataValue | undefined) => void,
    (event: keyof ProcessEvents, value: unknown) => void
  > = new Map();

  onUserEvent(onEvent: string, listener: (event: DataValue | undefined) => void): void {
    const handler = (event: string, value: unknown) => {
      if (event === `userEvent:${onEvent}`) {
        listener(value as DataValue | undefined);
      }
    };

    this.#onUserEventHandlers.set(listener, handler);
    this.#emitter.onAny(handler);
  }

  offUserEvent(listener: (data: DataValue | undefined) => void): void {
    const internalHandler = this.#onUserEventHandlers.get(listener);
    if (internalHandler) {
      this.#emitter.offAny(internalHandler);
    }
  }

  userInput(nodeId: NodeId, values: StringArrayDataValue): void {
    const pending = this.#pendingUserInputs[nodeId];
    if (pending) {
      pending.resolve(values as StringArrayDataValue);
      delete this.#pendingUserInputs[nodeId];
    }

    for (const processor of this.#subprocessors) {
      processor.userInput(nodeId, values);
    }
  }

  setExternalFunction(name: string, fn: ExternalFunction): void {
    this.#externalFunctions[name] = fn;
  }

  setStoredValueStore(store: RivetStoredValueStore | undefined): void {
    if (this.#lifecycle.isRunning) {
      throw new Error('Cannot change the stored value store while the graph is running.');
    }
    this.#storedValueStore = store;
  }

  setKnowledgeStores(stores: RivetKnowledgeStoreRegistry | undefined): void {
    if (this.#lifecycle.isRunning) {
      throw new Error('Cannot change knowledge stores while the graph is running.');
    }
    this.#knowledgeStores = stores;
  }

  async abort(successful: boolean = false, error?: Error | string): Promise<void> {
    if (!this.#lifecycle.requestAbort(successful, error)) {
      return Promise.resolve();
    }

    const abortReason = createGraphAbortReason(successful, error);
    this.#abortController.abort(abortReason);
    this.#abortActiveNodeControllers(abortReason);

    if (!this.#suppressGraphLifecycleEvents) {
      emitDetached(this.#emitter, 'graphAbort', this.#withExecution({ successful, error, graph: this.#graph }));

      if (!this.#isSubProcessor) {
        emitDetached(this.#emitter, 'abort', { successful, error });
      }
    }

    await this.#processingQueue.onIdle();
    if (!this.#isSubProcessor) {
      await this.#managedAsyncBranches?.drain();
    }
  }

  pause(): void {
    if (this.#lifecycle.pause()) {
      emitDetached(this.#emitter, 'pause', void 0);
    }
  }

  resume(): void {
    if (this.#lifecycle.resume()) {
      emitDetached(this.#emitter, 'resume', void 0);
    }
  }

  setSlowMode(slowMode: boolean): void {
    this.slowMode = slowMode;
  }

  async #waitUntilUnpaused(): Promise<void> {
    if (!this.#lifecycle.isPaused) {
      return;
    }

    if (this.#abortController.signal.aborted) {
      throw this.#lifecycle.getAbortError();
    }

    await new Promise<void>((resolve, reject) => {
      const abortListener = () => {
        cleanup();
        reject(this.#lifecycle.getAbortError());
      };

      const unsubscribeResume = this.#emitter.on('resume', () => {
        cleanup();
        resolve();
      });

      const cleanup = () => {
        this.#abortController.signal.removeEventListener('abort', abortListener);
        unsubscribeResume();
      };

      this.#abortController.signal.addEventListener('abort', abortListener, { once: true });
    });
  }

  async *events(): AsyncGenerator<ProcessEvent> {
    for await (const [event, data] of this.#emitter.anyEvent()) {
      yield {
        type: event,
        ...(typeof data === 'object' && data != null ? data : {}),
      } as unknown as ProcessEvent;

      if (event === 'finish') {
        break;
      }
    }
  }

  preloadNodeData(nodeId: NodeId, data: Outputs): void {
    // Preloading is deliberately permitted before a run starts. Do not
    // preprocess here: referenced-project ports are loaded by processGraph,
    // and caching a plan before that point would preserve an empty boundary.
    const effectiveNode = this.#getEffectiveAuthoredNode(nodeId);
    if (isDataBusTopologyNode(effectiveNode)) {
      throw new Error(
        `Cannot preload Data Bus "${effectiveNode.title}". Data Bus channels are compiled topology, not node outputs.`,
      );
    }

    for (const value of Object.values(data)) {
      if (!value || !('type' in value) || !value.type) {
        throw new Error(`Invalid data value for node ${nodeId}, must be a DataValue`);
      }
    }

    this.#preloadedNodeResults.set(nodeId, data);
    this.#hasPreloadedData = true;

    // Preserve the historical ability to preload an idle processor as well as
    // inject a boundary into a run that has already initialized.
    if (this.#lifecycle.isRunning) {
      this.#nodeResults.set(nodeId, data);
      this.#visitedNodes.add(nodeId);
    }
  }

  setFrozenNodeOutputResolver(resolver: FrozenNodeOutputResolver | undefined): void {
    this.#frozenNodeOutputResolver = resolver;
  }

  /** Gets all node IDs that a given node ID depends on being complete before the given node ID can start. */
  getDependencyNodesDeep(nodeId: NodeId): NodeId[] {
    const effectiveNode = this.#getEffectiveAuthoredNode(nodeId);
    if (isDataBusTopologyNode(effectiveNode)) {
      throw new Error(
        `Cannot get dependencies for Data Bus "${effectiveNode.title}". Data Bus channels are compiled topology, not executable nodes.`,
      );
    }

    this.#ensureGraphPreprocessed();

    const dependencyNodes = new Set<NodeId>();
    this.#collectDependencyNodesDeep(nodeId, dependencyNodes);

    return [...dependencyNodes];
  }

  #ensureGraphPreprocessed(): void {
    if (this.#definitions != null) {
      return;
    }

    this.#loadedProjects ??= {};
    // This synchronous inspection API can be called before processGraph has
    // loaded references. Its provisional definitions must never be reused as
    // a runtime plan for a later fully loaded invocation.
    this.#preprocessGraph({ allowRuntimeExecutionPlanCache: false });
  }

  #getEffectiveAuthoredNode(nodeId: NodeId): ChartNode | undefined {
    const authoredNode = this.#graph.nodes.find((node) => node.id === nodeId);
    return authoredNode ? resolveNodePrefabInstance(this.#project, authoredNode) : undefined;
  }

  #collectDependencyNodesDeep(nodeId: NodeId, dependencyNodes: Set<NodeId>): void {
    if (dependencyNodes.has(nodeId)) {
      return;
    }

    const node = this.#nodesById[nodeId];
    if (!node) {
      return;
    }

    dependencyNodes.add(nodeId);

    const connections = this.#graphExecutionPlan?.inputConnectionsByNode[nodeId] ?? this.#connections[nodeId] ?? [];

    for (const connection of connections) {
      if (connection.inputNodeId === nodeId) {
        this.#collectDependencyNodesDeep(connection.outputNodeId, dependencyNodes);
      }
    }
  }

  async replayRecording(recorder: ExecutionRecorder): Promise<GraphOutputs> {
    // Playback is a new root run, even though its node/graph events originate
    // from a historic recording. Giving the processor a real identity here is
    // essential if the user aborts while playback is in progress: abort()
    // emits its own graph terminal outside RecordingPlayer's event adapter.
    this.#initializeExecutionIdentity();
    this.#initProcessState();
    this.#graphOutputs = await replayExecutionRecording({
      emitter: this.#emitter,
      erroredNodes: this.#erroredNodes,
      graphInputs: this.#graphInputs,
      graphOutputs: this.#graphOutputs,
      fallbackGraphId: this.#graph.metadata!.id!,
      initialReplayExecution: this.#buildExecutionMetadata(),
      isAborted: () => this.#lifecycle.isAborted,
      nodeResults: this.#nodeResults,
      project: this.#project,
      recorder,
      recordingPlaybackChatLatency: this.recordingPlaybackChatLatency,
      setContextValues: (contextValues) => {
        this.#contextValues = contextValues;
      },
      setGraphInputs: (graphInputs) => {
        this.#graphInputs = graphInputs;
      },
      setGraphOutputs: (graphOutputs) => {
        this.#graphOutputs = graphOutputs;
      },
      setRunning: (running) => {
        if (!running) this.#lifecycle.complete();
      },
      visitedNodes: this.#visitedNodes,
      waitUntilUnpaused: () => this.#waitUntilUnpaused(),
    });

    return this.#graphOutputs;
  }

  #initProcessState() {
    this.#lifecycle.begin();

    this.#nodeResults = new Map(this.#preloadedNodeResults);
    this.#visitedNodes = new Set(this.#preloadedNodeResults.keys());
    this.#hasPreloadedData = this.#preloadedNodeResults.size > 0;

    this.#erroredNodes = new Map();
    this.#currentlyProcessing = new Set();
    // A processor may be constructed with a reusable execution plan. In that
    // case preprocessing happened before this run, so retain the compiled
    // execution-node set rather than restoring the authored graph nodes (which
    // may include topology-only Data Bus nodes).
    this.#remainingNodes = new Set(this.#seededExecutionPlanForNextRun()?.nodeIds ?? []);
    this.#pendingUserInputs = {};
    this.#processingQueue = new PQueue({ concurrency: this.#concurrency.nodeConcurrency });
    this.#graphOutputs = this.#sharedRunStateOverride?.graphOutputs ?? {};
    this.#executionCache ??= new Map();
    this.#queuedNodes = new Set();
    this.#toolCallContinuationInvocations = new Map();
    this.#continuationCompletionOwnerByNodeId = new Map();
    this.#effectiveConnectionsForRun = undefined;
    this.#asyncBranchPlansByTriggerNodeId = new Map();
    this.#loopControllersSeen = new Set();
    this.#subprocessors = new Set();
    this.#attachedNodeData = this.#sharedRunStateOverride?.attachedNodeData ?? new Map();
    this.#globals ??= new Map();
    if (!this.#isSubProcessor) {
      this.#storedValueController = new RivetStoredValueController(this.#storedValueStore);
      this.#knowledgeStoreController = new KnowledgeStoreController(this.#knowledgeStores);
    }
    this.#ignoreNodes = new Set();
    this.#nodeProcessContextBase = undefined!;
    this.#runToRelevantNodeIds = undefined;

    if (!this.#isSubProcessor) {
      this.#managedAsyncBranches = new ManagedAsyncBranches();
      this.#managedAsyncBranchFailures = [];
    }

    this.#abortController = this.#newAbortController();
    this.#successfulAbortTerminalProcessIds = new Set();
    this.#totalCost = 0;
    this.#nodeAbortControllers = new Map();
    this.#loadedProjects =
      this.#cacheLoadedProjects && this.#runtimeCache?.loadedProjects ? { ...this.#runtimeCache.loadedProjects } : {};
    // Referenced projects can be reloaded per run when loaded-project caching is disabled.
    if (!this.#cacheLoadedProjects && (this.#project.references?.length ?? 0) > 0) {
      if (this.#runtimeCache) {
        this.#runtimeCache.graphBoundaries = undefined;
      }
    }
    this.#graphInputNodeValues = this.#sharedRunStateOverride?.graphInputNodeValues ?? {};
  }

  /** Main function for running a graph. Runs a graph and returns the outputs from the output nodes of the graph. */
  async processGraph(
    /** Required and optional context available to the nodes and all subgraphs. */
    context: ProcessContext,

    /** Inputs to the main graph. You should pass all inputs required by the GraphInputNodes of the graph. */
    inputs: Record<string, DataValue> = {},

    /** Contextual data available to all graphs and subgraphs. Kind of like react context, avoids drilling down data into subgraphs. Be careful when using it. */
    contextValues: Record<string, DataValue> = {},

    /** Allows callers such as web apps to receive root outputs while managed async branches continue settling. */
    options: { returnWhenGraphOutputsReady?: boolean } = {},
  ): Promise<GraphOutputs> {
    if (this.#lifecycle.isRunning) {
      throw new Error('Cannot process graph while already processing');
    }

    let resolveOutputsReady: ((outputs: GraphOutputs) => void) | undefined;
    let rejectOutputsReady: ((error: unknown) => void) | undefined;
    const outputsReadyPromise =
      options.returnWhenGraphOutputsReady === true
        ? new Promise<GraphOutputs>((resolve, reject) => {
            resolveOutputsReady = resolve;
            rejectOutputsReady = reject;
          })
        : undefined;
    let outputsWerePublishedEarly = false;

    const completionPromise = (async () => {
      try {
        try {
          this.#profileRuntimeSync('initializeGraphRun', () => this.#initializeGraphRun(context, inputs, contextValues));
          await this.#profileRuntimeAsync('loadProjectReferences', () => this.#loadProjectReferences());
          this.#profileRuntimeSync('prepareNodeProcessContextBase', () => this.#prepareNodeProcessContextBase());

          const shouldUseSeededExecutionPlan = this.#seededExecutionPlanForNextRun() != null;
          this.#useSeededExecutionPlanOnNextRun = false;
          if (!shouldUseSeededExecutionPlan) {
            this.#preprocessGraph();
          }
          this.#assertNoDataBusRunTargets();
          this.#prepareAsyncBranchTopology();
        } catch (error) {
          const normalizedError = getError(error);
          await this.#emitRootStartupError(normalizedError);
          throw normalizedError;
        }

        await this.#profileRuntimeAsync('emitGraphStart', () => this.#emitGraphStart());
        await this.#profileRuntimeAsync('emitPreloadedNodeResults', () => this.#emitPreloadedNodeResults());
        await this.#profileRuntimeAsync('waitUntilUnpaused', () => this.#waitUntilUnpaused());

        if (this.#canUseFastAcyclicScheduler()) {
          await this.#profileRuntimeAsync('processFastAcyclicGraph', () => this.#processFastAcyclicGraph());
        } else {
          await this.#profileRuntimeAsync('processCompatibleGraph', () => this.#processCompatibleGraph());
        }

        if (
          options.returnWhenGraphOutputsReady === true &&
          !this.#isSubProcessor &&
          this.#managedAsyncBranches!.hasPending
        ) {
          await this.#profileRuntimeAsync('throwIfGraphErrored', () => this.#throwIfGraphErrored(false));
          // Publish a snapshot instead of the live root output object. In particular,
          // the provisional cost must not occupy the root cost port before managed
          // async branches contribute their cost during finalization.
          const outputsReady = { ...this.#graphOutputs };
          ensureGraphCostOutput(outputsReady, this.#totalCost);
          await this.#emitter.emit(
            'graphOutputsReady',
            this.#withExecution({ graph: this.#graph, outputs: outputsReady }),
          );
          outputsWerePublishedEarly = true;
          resolveOutputsReady?.(outputsReady);
        }

        if (!this.#isSubProcessor) {
          await this.#profileRuntimeAsync('drainManagedAsyncBranches', () => this.#managedAsyncBranches!.drain());
        }

        await this.#profileRuntimeAsync('throwIfGraphErrored', () => this.#throwIfGraphErrored());
        return await this.#profileRuntimeAsync('finalizeGraphRun', () => this.#finalizeGraphRun());
      } finally {
        if (!this.#isSubProcessor) {
          await this.#managedAsyncBranches?.drain();
        }
        this.#lifecycle.complete();
        this.#cleanupTokenizerErrorListener();

        await this.#profileRuntimeAsync('emitFinish', () => this.#emitFinishIfNeeded());
      }
    })();

    this.#runCompletionPromise = completionPromise;

    if (outputsReadyPromise) {
      // Without a real early publication, preserve ordinary processGraph semantics:
      // resolve or reject only after terminal cleanup and finish listeners settle.
      // The rejection callback also observes late failures after early publication.
      void completionPromise.then(
        (outputs) => {
          if (!outputsWerePublishedEarly) resolveOutputsReady?.(outputs);
        },
        (error) => {
          if (!outputsWerePublishedEarly) rejectOutputsReady?.(error);
        },
      );
      return await outputsReadyPromise;
    }

    return await completionPromise;
  }

  async #emitFinishIfNeeded(): Promise<void> {
    if (!this.#lifecycle.claimRootFinish(this.#isSubProcessor)) {
      return;
    }

    await this.#emitter.emit('finish', undefined);
  }

  #initializeGraphRun(
    context: ProcessContext,
    inputs: Record<string, DataValue>,
    contextValues: Record<string, DataValue>,
  ): void {
    this.#initializeExecutionIdentity();

    this.#initProcessState();

    this.#context = context;
    this.#graphInputs = inputs;
    this.#contextValues = contextValues;

    this.#cleanupTokenizerErrorListener();
    const unsubscribeTokenizerError = this.#context.tokenizer.on('error', (error) => {
      emitDetached(this.#emitter, 'error', { error });
    });
    this.#unsubscribeTokenizerError =
      typeof unsubscribeTokenizerError === 'function' ? unsubscribeTokenizerError : undefined;
  }

  #initializeExecutionIdentity(): void {
    if (this.#executionIdentityOverride) {
      this.#rootRunId = this.#executionIdentityOverride.rootRunId;
      this.#graphRunId = this.#executionIdentityOverride.graphRunId;
      this.#parentGraphRunId = this.#executionIdentityOverride.parentGraphRunId;
    } else {
      this.#rootRunId = this.#parent ? this.#parent.#rootRunId : (nanoid() as RootRunId);
      this.#graphRunId = nanoid() as GraphRunId;
      this.#parentGraphRunId = this.#parent ? this.#parent.#graphRunId : undefined;
    }
  }

  async #emitRootStartupError(error: Error): Promise<void> {
    // Startup can fail before graphStart/nodeStart: initialization, reference
    // loading, process-context construction, or graph preflight. Emit the
    // same scoped graph terminal plus unscoped root confirmation as ordinary
    // runtime failures so observers can establish a truthful root lifecycle.
    if (this.#isSubProcessor || this.#suppressGraphLifecycleEvents) {
      return;
    }

    await this.#emitter.emit('graphError', this.#withExecution({ graph: this.#graph, error }));
    await this.#emitter.emit('error', { error });
  }

  #prepareNodeProcessContextBase(): void {
    // Subgraphs receive their caller's InternalProcessContext, whose observer
    // is already a GraphProcessor wrapper. Always resolve the original host
    // observer from the root run so nested LLM calls are not emitted once by
    // every ancestor before their own event is bridged to the root emitter.
    const hostChatV2Observer = this.getRootProcessor().#context.onChatV2CallFinished;
    this.#nodeProcessContextBase = {
      ...this.#context,
      abortGraph: (error) => {
        void (this.#abortOwnerOverride ?? this).abort(error === undefined, error);
      },
      codeRunner: this.#context.codeRunner ?? DEFAULT_ISOMORPHIC_CODE_RUNNER,
      contextValues: this.#contextValues,
      executionCache: this.#executionCache,
      executor: this.executor ?? 'nodejs',
      getGlobal: (id) => this.#globals.get(id),
      getCachedStoredValue: (key) => this.#storedValueController.getCached(key),
      getStoredValue: (key) => this.#storedValueController.get(key),
      getKnowledgeStore: (connectionId) =>
        this.#knowledgeStoreController.resolve(connectionId, this.#nodeProcessContextBase),
      getGraphBoundary: (project, graphId) => this.#getGraphBoundary(project, graphId),
      graphInputNodeValues: this.#graphInputNodeValues,
      graphInputs: this.#graphInputs,
      graphOutputs: this.#graphOutputs,
      onChatV2CallFinished: (event) => {
        try {
          const observerResult = hostChatV2Observer?.(event);
          if (observerResult != null && typeof (observerResult as PromiseLike<void>).then === 'function') {
            void Promise.resolve(observerResult).catch(() => undefined);
          }
        } catch {
          // Host observers must never change graph execution.
        }
        // Runtime traces carry only the normalized, provider-neutral usage
        // contract. The host observer above retains its existing raw accounting
        // callback, but provider-shaped usage never enters recordings or remote
        // trace transport.
        const { rawUsage: _rawUsage, ...traceEvent } = event;
        emitDetached(this.#emitter, 'llmCallFinished', this.#withExecution(traceEvent));
      },
      onToolCallFinished: (event) => {
        emitDetached(this.#emitter, 'toolCallFinished', this.#withExecution(event));
      },
      project: this.#project,
      raiseEvent: (event, data) => {
        this.getRootProcessor().raiseEvent(event, data as DataValue);
      },
      referencedProjects: this.#loadedProjects,
      tokenizer: this.#getTokenizer(),
      trace: (message) => {
        this.#emitTraceEvent(message);
      },
      setStoredValue: (key, value) => this.#storedValueController.set(key, value),
      waitForGlobal: async (id) => {
        if (this.#globals.has(id)) {
          return this.#globals.get(id)!;
        }
        await this.getRootProcessor().#emitter.once(`globalSet:${id}`);
        return this.#globals.get(id)!;
      },
      waitForStoredValue: (key, signal) => this.#storedValueController.waitForSet(key, signal),
    };
  }

  #cleanupTokenizerErrorListener(): void {
    const unsubscribeTokenizerError = this.#unsubscribeTokenizerError;
    this.#unsubscribeTokenizerError = undefined;

    try {
      unsubscribeTokenizerError?.();
    } catch (err) {
      emitDetached(this.#emitter, 'error', { error: getError(err) });
    }
  }

  async #emitGraphStart(): Promise<void> {
    if (this.#suppressGraphLifecycleEvents) {
      return;
    }

    if (!this.#isSubProcessor) {
      await this.#emitter.emit(
        'start',
        this.#withExecution({
          contextValues: this.#contextValues,
          inputs: this.#graphInputs,
          project: this.#project,
          startGraph: this.#graph,
        }),
      );
    }

    await this.#emitter.emit('graphStart', this.#withExecution({ graph: this.#graph, inputs: this.#graphInputs }));
  }

  async #emitPreloadedNodeResults(): Promise<void> {
    if (!this.#hasPreloadedData) {
      return;
    }

    for (const node of this.#executionGraphNodes) {
      if (!this.#nodeResults.has(node.id)) {
        continue;
      }

      if (this.#suppressedPreloadedNodeIds.has(node.id)) {
        continue;
      }

      this.#emitTraceEvent(`Node ${node.title} has preloaded data`);

      await this.#emitter.emit(
        'nodeStart',
        this.#withExecution({
          node,
          inputs: {},
          processId: 'preload' as ProcessId,
          resultOrigin: 'preloaded' as const,
        }),
      );

      await this.#emitter.emit(
        'nodeFinish',
        this.#withExecution({
          node,
          outputs: this.#nodeResults.get(node.id)!,
          processId: 'preload' as ProcessId,
          resultOrigin: 'preloaded' as const,
        }),
      );
    }
  }

  async #queueStartNodes(startNodes: ChartNode[]): Promise<void> {
    for (const startNode of startNodes) {
      void this.#processingQueue.add(async () => {
        await this.#fetchNodeDataAndProcessNode(startNode);
      });
    }
  }

  async #processCompatibleGraph(): Promise<void> {
    await this.#queueStartNodes(getStartNodes(this.#executionState, this.#executionGraphNodes, this.runToNodeIds));
    await this.#processingQueue.onIdle();
    this.#markUnqueuedNodesIgnored();
  }

  #canUseFastAcyclicScheduler(): boolean {
    if (this.#scheduler !== 'fast-acyclic') {
      return false;
    }

    if (this.#hasPreloadedData || this.runToNodeIds || this.slowMode || this.#includeTrace) {
      return false;
    }

    if (this.#nodesNotInCycle.length !== this.#executionGraphNodes.length) {
      return false;
    }

    if (this.#getEffectiveConnections().some((connection) => connection.inputNodeId === connection.outputNodeId)) {
      return false;
    }

    return this.#executionGraphNodes.every((node) => {
      if (node.isSplitRun) {
        return false;
      }

      return !FAST_ACYCLIC_UNSUPPORTED_NODE_TYPES.has(node.type);
    });
  }

  async #processFastAcyclicGraph(): Promise<void> {
    const relevantNodeIds = new Set<NodeId>();
    const nodesToVisit = [...getStartNodes(this.#executionState, this.#executionGraphNodes)];

    for (let index = 0; index < nodesToVisit.length; index += 1) {
      const node = nodesToVisit[index]!;
      if (relevantNodeIds.has(node.id)) {
        continue;
      }

      relevantNodeIds.add(node.id);
      nodesToVisit.push(...getInputNodesTo(this.#executionState, node));
    }

    const inputNodeIdsByNode = new Map<NodeId, Set<NodeId>>();
    const remainingInputsByNode = new Map<NodeId, number>();
    const readyNodes: ChartNode[] = [];
    const queuedNodeIds = new Set<NodeId>();

    for (const node of this.#executionGraphNodes) {
      if (!relevantNodeIds.has(node.id)) {
        continue;
      }

      const inputNodeIds = new Set<NodeId>();
      for (const inputNode of getInputNodesTo(this.#executionState, node)) {
        inputNodeIds.add(inputNode.id);
      }
      inputNodeIdsByNode.set(node.id, inputNodeIds);

      const inputCount = inputNodeIds.size;
      remainingInputsByNode.set(node.id, inputCount);
      if (inputCount === 0) {
        readyNodes.push(node);
        queuedNodeIds.add(node.id);
      }
    }

    await new Promise<void>((resolve, reject) => {
      let activeCount = 0;
      let settled = false;

      const queueReadyOutputs = (node: ChartNode, outputNodes: ChartNode[]) => {
        for (const outputNode of outputNodes) {
          if (!relevantNodeIds.has(outputNode.id) || !inputNodeIdsByNode.get(outputNode.id)?.has(node.id)) {
            continue;
          }

          const remainingInputs = (remainingInputsByNode.get(outputNode.id) ?? 0) - 1;
          remainingInputsByNode.set(outputNode.id, remainingInputs);

          if (remainingInputs <= 0 && !queuedNodeIds.has(outputNode.id)) {
            readyNodes.push(outputNode);
            queuedNodeIds.add(outputNode.id);
          }
        }
      };

      const settle = () => {
        if (settled) {
          return;
        }

        if (activeCount === 0 && readyNodes.length === 0) {
          settled = true;
          resolve();
        }
      };

      const pump = () => {
        if (settled) {
          return;
        }

        while (activeCount < this.#concurrency.nodeConcurrency && readyNodes.length > 0) {
          const node = readyNodes.shift()!;
          activeCount += 1;

          void this.#processNodeIfAllInputsAvailable(node, { queueOutputNodes: false })
            .then((outputNodes) => queueReadyOutputs(node, outputNodes))
            .then(() => {
              activeCount -= 1;
              pump();
              settle();
            })
            .catch((error) => {
              if (!settled) {
                settled = true;
                reject(error);
              }
            });
        }

        settle();
      };

      pump();
    });
  }

  #markUnqueuedNodesIgnored(): void {
    if (!this.runToNodeIds) {
      return;
    }

    for (const node of this.#executionGraphNodes) {
      if (this.#queuedNodes.has(node.id) === false) {
        this.#ignoreNodes.add(node.id);
      }
    }
  }

  #getUnhandledErroredNodes(): [NodeId, Error | string][] {
    return [...this.#erroredNodes.entries()].filter(([nodeId]) => {
      const erroredNodeAttachedData = this.#getAttachedDataTo(nodeId);
      return erroredNodeAttachedData.races == null || erroredNodeAttachedData.races.completed === false;
    });
  }

  #createGraphError(
    erroredNodes: [NodeId, Error | string][],
    managedAsyncFailures: ManagedAsyncBranchFailure[] = [],
  ): Error {
    if (this.#lifecycle.abortError) {
      return this.#lifecycle.getAbortError();
    }

    const errors = [
      ...erroredNodes.map(([nodeId, error]) => ({ error, node: this.#nodesById[nodeId]! })),
      ...managedAsyncFailures.flatMap((failure) =>
        failure.nodeErrors.length > 0 ? failure.nodeErrors : [{ error: failure.error, node: failure.triggerNode }],
      ),
    ];

    const message = `Graph ${this.#graph.metadata!.name} (${
      this.#graph.metadata!.id
    }) failed to process due to errors in nodes:\n${errors
      .map(({ node }) => `- ${node.title} (${node.id})`)
      .join('\n')}`;

    if (errors.length === 1) {
      return new Error(message, { cause: errors[0]!.error });
    }

    return new AggregateError(
      errors.map(({ error }) => error),
      message,
    );
  }

  async #throwIfGraphErrored(includeManagedAsyncFailures = true): Promise<void> {
    const erroredNodes = this.#getUnhandledErroredNodes();
    const managedAsyncFailures = includeManagedAsyncFailures ? this.#managedAsyncBranchFailures : [];
    if ((!erroredNodes.length && !managedAsyncFailures.length) || this.#lifecycle.abortSuccessful) {
      return;
    }

    const error = this.#createGraphError(erroredNodes, managedAsyncFailures);
    if (!this.#suppressGraphLifecycleEvents) {
      await this.#emitter.emit('graphError', this.#withExecution({ graph: this.#graph, error }));
    }

    if (!this.#isSubProcessor && !this.#suppressGraphLifecycleEvents) {
      await this.#emitter.emit('error', { error });
    }

    throw error;
  }

  async #finalizeGraphRun(): Promise<GraphOutputs> {
    const outputValues = this.#graphOutputs;
    this.#lifecycle.complete();

    if (this.#suppressGraphLifecycleEvents) {
      return outputValues;
    }

    ensureGraphCostOutput(this.#graphOutputs, this.#totalCost);

    await this.#emitter.emit('graphFinish', this.#withExecution({ graph: this.#graph, outputs: outputValues }));

    if (!this.#isSubProcessor) {
      await this.#emitter.emit('done', { results: outputValues });
      await this.#emitFinishIfNeeded();
    }

    return outputValues;
  }

  async #loadProjectReferences() {
    if ((this.#project.references?.length ?? 0) > 0) {
      if (this.#cacheLoadedProjects && this.#runtimeCache?.loadedProjects) {
        this.#loadedProjects = { ...this.#runtimeCache.loadedProjects };
        return;
      }

      if (!this.#context.projectReferenceLoader) {
        throw new Error(
          'Project references are set, but no projectReferenceLoader is set in the context. Since this project uses project references, you must provide a projectReferenceLoader in the context.',
        );
      }

      const seenProjectIds = new Set<ProjectId>();

      const loadProject = async (ref: ProjectReference) => {
        if (seenProjectIds.has(ref.id)) {
          return;
        }

        seenProjectIds.add(ref.id);

        const project = await this.#context.projectReferenceLoader!.loadProject(this.#context.projectPath, ref);

        this.#loadedProjects[project.metadata!.id!] = project;

        for (const reference of project.references ?? []) {
          await loadProject(reference);
        }
      };

      for (const reference of this.#project.references!) {
        await loadProject(reference);
      }

      if (this.#cacheLoadedProjects && this.#runtimeCache) {
        this.#runtimeCache.loadedProjects = { ...this.#loadedProjects };
      }
    }
  }

  /** Returns true if any input node has errored. Optionally emits a trace event. */
  #hasErroredInputNode(node: ChartNode, inputNodes: ChartNode[], trace = false): boolean {
    return hasErroredInputNode(
      this.#executionState,
      node,
      inputNodes,
      trace ? (message) => this.#emitTraceEvent(message) : undefined,
    );
  }

  /** Returns required inputs without connections. */
  #getMissingRequiredInputs(node: ChartNode): NodeInputDefinition[] {
    return getMissingRequiredInputs(this.#executionState, node);
  }

  /** Accumulates cost from a node's output. */
  #accumulateCost(output: Outputs): void {
    if (output['cost' as PortId]?.type === 'number') {
      this.#totalCost += coerceTypeOptional(output['cost' as PortId], 'number') ?? 0;
    }
  }

  async #fetchNodeDataAndProcessNode(node: ChartNode): Promise<void> {
    const profileStart = this.#startRuntimeProfile();

    try {
      if (this.#currentlyProcessing.has(node.id)) {
        return;
      }

      if (this.#propagateCompletedContinuationNode(node, true)) {
        return;
      }

      if (this.#queuedNodes.has(node.id)) {
        return;
      }

      if (this.#nodeResults.has(node.id) || this.#erroredNodes.has(node.id)) {
        return;
      }

      const inputNodesProfileStart = this.#startRuntimeProfile();
      const inputNodes = getInputNodesTo(this.#executionState, node);
      this.#finishRuntimeProfile('getInputNodesTo', inputNodesProfileStart);

      if (this.#hasErroredInputNode(node, inputNodes)) {
        return;
      }

      this.#emitTraceEvent(`Node ${node.title} has input nodes: ${inputNodes.map((n) => n.title).join(', ')}`);

      const attachedData = this.#getAttachedDataTo(node);

      if (node.type === 'raceInputs' || attachedData.races) {
        for (const inputNode of inputNodes) {
          const inputNodeAttachedData = this.#getAttachedDataTo(inputNode);
          const raceIds = new Set<RaceId>([...(attachedData.races?.raceIds ?? ([] as RaceId[]))]);

          if (node.type === 'raceInputs') {
            raceIds.add(`race-${node.id}` as RaceId);
          }

          inputNodeAttachedData.races = {
            propagate: false,
            raceIds: [...raceIds],
            completed: false,
          };
        }
      }

      this.#queuedNodes.add(node.id);

      void this.#processingQueue.addAll(
        inputNodes.map((inputNode) => {
          return async () => {
            this.#emitTraceEvent(`Fetching required data for node ${inputNode.title} (${inputNode.id})`);

            await this.#fetchNodeDataAndProcessNode(inputNode);
          };
        }),
      );

      await this.#processNodeIfAllInputsAvailable(node);
    } finally {
      this.#finishRuntimeProfile('fetchNodeDataAndProcessNode', profileStart);
    }
  }

  /** If all inputs are present, all conditions met, processes the node. */
  async #processNodeIfAllInputsAvailable(
    node: ChartNode,
    options: { queueOutputNodes?: boolean } = {},
  ): Promise<ChartNode[]> {
    const { queueOutputNodes = true } = options;
    const builtInNode = node as BuiltInNodes;
    const inputNodesProfileStart = this.#startRuntimeProfile();
    const inputNodes = getInputNodesTo(this.#executionState, node);
    this.#finishRuntimeProfile('getInputNodesTo', inputNodesProfileStart);

    const continuedOutputNodes = this.#propagateCompletedContinuationNode(node, queueOutputNodes);
    if (continuedOutputNodes) {
      return continuedOutputNodes;
    }

    if (this.#shouldSkipNodeProcessing(node, inputNodes)) {
      return [];
    }

    const attachedData = this.#getAttachedDataTo(node);
    if (this.#shouldSkipCompletedRaceNode(node, attachedData)) {
      return [];
    }

    const inputValuesProfileStart = this.#startRuntimeProfile();
    const inputValues = this.#getInputValuesForNode(node);
    this.#finishRuntimeProfile('getInputValuesForNode', inputValuesProfileStart);

    const loopExclusion = this.#excludedDueToControlFlow(
      node,
      inputValues,
      nanoid() as ProcessId,
      LOOP_NOT_BROKEN_SENTINEL,
      { queueOutputNodes },
    );
    if (loopExclusion) {
      this.#emitTraceEvent(`Node ${node.title} is excluded due to control flow`);
      return loopExclusion === true ? [] : loopExclusion;
    }

    const waitingForInputNode = getWaitingForInputNode(this.#executionState, node, inputNodes, inputValues);
    if (waitingForInputNode) {
      this.#emitTraceEvent(`Node ${node.title} is waiting for input node ${waitingForInputNode}`);
      return [];
    }

    const exclusion = this.#excludedDueToControlFlow(node, inputValues, nanoid() as ProcessId, undefined, {
      queueOutputNodes,
    });
    if (exclusion) {
      this.#emitTraceEvent(`Node ${node.title} is excluded due to control flow`);
      return exclusion === true ? [] : exclusion;
    }

    const missingRequiredInputs = this.#getMissingRequiredInputs(node);
    if (missingRequiredInputs.length > 0) {
      return this.#excludeNodeWithMissingRequiredInputs(node, inputValues, missingRequiredInputs, { queueOutputNodes });
    }

    if (this.#beginNodeProcessing(node, attachedData) === false) {
      return [];
    }

    const processProfileStart = this.#startRuntimeProfile();
    let processResult!: { processId: ProcessId; shouldQueueOutputNodes: boolean };
    try {
      processResult = await this.#processNode(node, inputValues);
    } finally {
      this.#finishRuntimeProfile('nodeDispatch', processProfileStart);
    }
    const { processId } = processResult;

    if (this.slowMode) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.#emitTraceEvent(`Finished processing node ${node.title} (${node.id})`);
    this.#visitedNodes.add(node.id);
    this.#currentlyProcessing.delete(node.id);
    this.#remainingNodes.delete(node.id);

    const outputNodesProfileStart = this.#startRuntimeProfile();
    const outputNodes = getOutputNodesFrom(this.#executionState, node);
    this.#finishRuntimeProfile('getOutputNodesFrom', outputNodesProfileStart);

    this.#handleLoopControllerPostProcess(node, attachedData);
    this.#handleCompletedRace(node);

    const childLoopInfoError = this.#assignChildLoopInfo(node, builtInNode, attachedData);
    if (childLoopInfoError) {
      await this.#nodeErrored(node, childLoopInfoError, processId);
      return [];
    }

    this.#propagateAttachedDataToOutputNodes(node, attachedData, outputNodes.connectionsToNodes);
    if (queueOutputNodes && processResult.shouldQueueOutputNodes) {
      const queueOutputsProfileStart = this.#startRuntimeProfile();
      if (node.type === 'startBackgroundBranch') {
        this.#startManagedAsyncBranch(node);
      } else {
        this.#queueOutputNodes(node, outputNodes.nodes);
      }
      this.#finishRuntimeProfile('queueOutputNodes', queueOutputsProfileStart);
    }

    return processResult.shouldQueueOutputNodes ? outputNodes.nodes : [];
  }

  #propagateCompletedContinuationNode(node: ChartNode, queueOutputNodes: boolean): ChartNode[] | undefined {
    const ownerLLMNodeId = this.#continuationCompletionOwnerByNodeId.get(node.id);
    if (ownerLLMNodeId == null || !this.#nodeResults.has(ownerLLMNodeId)) {
      return undefined;
    }
    this.#continuationCompletionOwnerByNodeId.delete(node.id);

    const outputNodes = getOutputNodesFrom(this.#executionState, node);
    const attachedData = this.#getAttachedDataTo(node);
    this.#registerNodeInActiveLoop(node, attachedData);
    this.#propagateAttachedDataToOutputNodes(node, attachedData, outputNodes.connectionsToNodes);
    if (queueOutputNodes && node.type !== 'startBackgroundBranch') {
      this.#queueOutputNodes(node, outputNodes.nodes);
    }
    return outputNodes.nodes;
  }

  #shouldSkipNodeProcessing(node: ChartNode, inputNodes: ChartNode[]): boolean {
    if (this.#ignoreNodes.has(node.id)) {
      this.#emitTraceEvent(`Node ${node.title} is ignored`);
      return true;
    }

    if (this.runToNodeIds) {
      const dependencyNodes = this.getDependencyNodesDeep(node.id);
      if (this.runToNodeIds.some((runTo) => runTo !== node.id && dependencyNodes.includes(runTo))) {
        this.#emitTraceEvent(`Node ${node.title} is excluded due to runToNodeIds`);
        return true;
      }
    }

    if (this.#currentlyProcessing.has(node.id)) {
      this.#emitTraceEvent(`Node ${node.title} is already being processed`);
      return true;
    }

    if (this.#visitedNodes.has(node.id) && node.type !== 'loopController') {
      this.#emitTraceEvent(`Node ${node.title} has already been processed`);
      return true;
    }

    if (this.#erroredNodes.has(node.id)) {
      this.#emitTraceEvent(`Node ${node.title} has already errored`);
      return true;
    }

    if (this.#hasErroredInputNode(node, inputNodes, true)) {
      return true;
    }

    return false;
  }

  #excludeNodeWithMissingRequiredInputs(
    node: ChartNode,
    inputValues: Inputs,
    missingRequiredInputs: NodeInputDefinition[],
    options: { queueOutputNodes?: boolean } = {},
  ): ChartNode[] {
    const exclusion = getMissingRequiredInputExclusion(node, missingRequiredInputs);
    const processId = nanoid() as ProcessId;

    this.#emitTraceEvent(exclusion.traceMessage);
    return this.#excludeNode(node, processId, inputValues, exclusion.reason, options);
  }

  #beginNodeProcessing(node: ChartNode, attachedData: AttachedNodeData): boolean {
    if (this.#shouldSkipCompletedRaceNode(node, attachedData)) {
      return false;
    }

    this.#currentlyProcessing.add(node.id);

    if (node.type === 'loopController') {
      this.#loopControllersSeen.add(node.id);
    }

    this.#registerNodeInActiveLoop(node, attachedData);

    return true;
  }

  #shouldSkipCompletedRaceNode(node: ChartNode, attachedData: AttachedNodeData): boolean {
    if (attachedData.races?.completed) {
      this.#emitTraceEvent(`Node ${node.title} is part of a race that was completed`);
      return true;
    }

    return false;
  }

  #registerNodeInActiveLoop(node: ChartNode, attachedData: AttachedNodeData): void {
    if (attachedData.loopInfo && attachedData.loopInfo.loopControllerId !== node.id) {
      attachedData.loopInfo.nodes.add(node.id);
    }
  }

  #handleLoopControllerPostProcess(node: ChartNode, attachedData: AttachedNodeData): void {
    if (node.type !== 'loopController') {
      return;
    }

    const loopControllerResults = this.#nodeResults.get(node.id)!;
    const breakValue = loopControllerResults['break' as PortId];
    const didBreak = didLoopControllerBreak(breakValue);

    if (didBreak) {
      return;
    }

    this.#emitTraceEvent(`Loop controller ${node.title} did not break, so we're looping again`);
    for (const loopNodeId of attachedData.loopInfo?.nodes ?? []) {
      const cycleNode = this.#nodesById[loopNodeId]!;
      this.#emitTraceEvent(`Clearing cycle node ${cycleNode.title} (${cycleNode.id})`);
      this.#visitedNodes.delete(cycleNode.id);
      this.#currentlyProcessing.delete(cycleNode.id);
      this.#remainingNodes.add(cycleNode.id);
      this.#nodeResults.delete(cycleNode.id);
    }
  }

  #handleCompletedRace(node: ChartNode): void {
    if (node.type !== 'raceInputs') {
      return;
    }

    const raceId = `race-${node.id}` as RaceId;
    const allNodesForRace = [...this.#attachedNodeData.entries()].filter(([, { races }]) =>
      races?.raceIds.includes(raceId),
    );

    for (const [, nodeAttachedData] of allNodesForRace) {
      if (nodeAttachedData.races?.raceIds.includes(raceId)) {
        nodeAttachedData.races.completed = true;
      }
    }

    for (const [nodeId] of allNodesForRace) {
      this.#abortNodeControllersForNode(
        nodeId,
        `Aborting node ${nodeId} because other race branch won`,
        createGraphAbortReason(true, RACE_LOSER_EXCLUSION_REASON),
      );
    }
  }

  #assignChildLoopInfo(node: ChartNode, builtInNode: BuiltInNodes, attachedData: AttachedNodeData): Error | undefined {
    if (builtInNode.type !== 'loopController') {
      return undefined;
    }

    let childLoopInfo = attachedData.loopInfo;
    if (childLoopInfo != null && childLoopInfo.loopControllerId !== builtInNode.id) {
      return new Error('Nested loops are not supported');
    }

    childLoopInfo = {
      propagate: (parent, connectionsFromParent) => {
        if (parent.type === 'loopController' && connectionsFromParent.some((c) => c.outputId === ('break' as PortId))) {
          return false;
        }
        return true;
      },
      loopControllerId: node.id,
      nodes: childLoopInfo?.nodes ?? new Set(),
      iterationCount: (childLoopInfo?.iterationCount ?? 0) + 1,
    };

    attachedData.loopInfo = childLoopInfo;
    return undefined;
  }

  #propagateAttachedDataToOutputNodes(
    node: ChartNode,
    attachedData: AttachedNodeData,
    outputConnections: { connections: NodeConnection[]; node: ChartNode }[],
  ): void {
    for (const { node: outputNode, connections: connectionsToOutputNode } of outputConnections) {
      const outputNodeAttachedData = this.#getAttachedDataTo(outputNode);
      const propagatedAttachedData = Object.entries(attachedData).filter(([, value]): boolean => {
        if (!value) {
          return false;
        }

        if (typeof value.propagate === 'boolean') {
          return value.propagate;
        }

        return value.propagate(node, connectionsToOutputNode);
      });

      for (const [key, value] of propagatedAttachedData) {
        outputNodeAttachedData[key] = value;
      }
    }
  }

  #queueOutputNodes(node: ChartNode, outputNodes: ChartNode[]): void {
    void this.#processingQueue.addAll(
      outputNodes.map((outputNode) => async () => {
        this.#emitTraceEvent(`Trying to run output node from ${node.title}: ${outputNode.title} (${outputNode.id})`);
        await this.#processNodeIfAllInputsAvailable(outputNode);
      }),
    );
  }

  #startManagedAsyncBranch(triggerNode: ChartNode): void {
    const outputs = this.#nodeResults.get(triggerNode.id);
    if (!outputs) {
      return;
    }

    const activeOutputPortIds = this.#getActiveOutputPortIds(triggerNode);
    const hasRunnableOutput = [...activeOutputPortIds].some((portId) => {
      const output = outputs[portId];
      return output != null && output.type !== 'control-flow-excluded';
    });
    if (!hasRunnableOutput) {
      return;
    }

    const plan = this.#getActiveAsyncBranchPlan(triggerNode, activeOutputPortIds);
    if (!plan) {
      return;
    }

    const root = this.getRootProcessor();
    root.#managedAsyncBranches ??= new ManagedAsyncBranches();
    const queueKey = `${this.#project.metadata?.id ?? 'project'}:${this.#graph.metadata?.id ?? 'graph'}:${triggerNode.id}`;
    let branchProcessor: GraphProcessor | undefined;

    root.#managedAsyncBranches.enqueue(
      queueKey,
      async () => {
        await this.#runManagedAsyncBranch(triggerNode, outputs, plan, (processor) => {
          branchProcessor = processor;
        });
      },
      (error) => {
        root.#recordManagedAsyncBranchFailure(triggerNode, branchProcessor, error);
      },
    );
  }

  async #runManagedAsyncBranch(
    triggerNode: ChartNode,
    triggerOutputs: Outputs,
    plan: ToolCallContinuationAsyncBranchPlan,
    onProcessorCreated: (processor: GraphProcessor) => void,
  ): Promise<void> {
    const root = this.getRootProcessor();
    const sameGraphOwner = this.#sameGraphRunOwnerOverride ?? this;
    const isRootGraphOrigin = !sameGraphOwner.#isSubProcessor;
    if (root.#abortController.signal.aborted) {
      throw createGraphAbortErrorFromSignal(root.#abortController.signal, 'Async branch aborted before it started');
    }

    const graphId = plan.graph.metadata?.id;
    if (!graphId) {
      throw new Error('Cannot start an async branch because the current graph has no ID.');
    }

    const branchRuntimeCache: GraphProcessorRuntimeCache = {
      ...this.#runtimeCache,
      graphBoundaries: undefined,
      loadedProjects: { ...this.#loadedProjects },
    };
    const processor = new GraphProcessor(this.#project, graphId, this.#registry, this.#includeTrace, {
      cacheLoadedProjects: true,
      captureNodeTimings: this.#captureNodeTimings,
      concurrency: this.#concurrency,
      executionPlanCacheMode: this.#executionPlanCacheMode,
      runtimeCache: branchRuntimeCache,
      runtimeProfiler: this.#runtimeProfiler,
      scheduler: this.#scheduler,
      [graphProcessorGraphOverride]: plan.graph,
      [consumedAsyncBranchTriggerOverride]: triggerNode.id,
    });
    onProcessorCreated(processor);

    processor.executor = this.executor;
    processor.#isSubProcessor = true;
    processor.#executionCache = this.#executionCache;
    processor.#externalFunctions = this.#externalFunctions;
    processor.#contextValues = this.#contextValues;
    processor.#parent = sameGraphOwner;
    processor.#abortOwnerOverride = root;
    processor.#suppressGraphPartialOutputs = true;
    processor.#globals = this.#globals;
    processor.#storedValueController = this.#storedValueController;
    processor.#knowledgeStoreController = this.#knowledgeStoreController;
    processor.#frozenNodeOutputResolver = this.#frozenNodeOutputResolver;
    processor.#executor = this.#executor;
    processor.#suppressGraphLifecycleEvents = isRootGraphOrigin;
    processor.#sharedRunStateOverride = {
      attachedNodeData: this.#attachedNodeData,
      graphInputNodeValues: this.#graphInputNodeValues,
      // Async branches cannot contain Graph Output nodes. Keep their synthetic
      // boundary outputs private so branch finalization cannot seed the root's
      // derived cost output before the root has accumulated every path.
      graphOutputs: {},
    };
    const branchRunToNodeIds = this.runToNodeIds?.filter((nodeId) => plan.nodeIds.has(nodeId));
    processor.runToNodeIds = branchRunToNodeIds?.length ? branchRunToNodeIds : undefined;
    processor.#executionIdentityOverride = isRootGraphOrigin
      ? {
          rootRunId: this.#rootRunId,
          graphRunId: this.#graphRunId,
          parentGraphRunId: this.#parentGraphRunId,
        }
      : {
          rootRunId: root.#rootRunId,
          graphRunId: nanoid() as GraphRunId,
          parentGraphRunId: sameGraphOwner.#graphRunId,
        };
    processor.preloadNodeData(triggerNode.id, triggerOutputs);
    processor.#suppressedPreloadedNodeIds.add(triggerNode.id);

    const unwireEvents = wireSubprocessorEvents(processor, root.#emitter, {
      autoCleanup: false,
      isPaused: () => root.#lifecycle.isPaused,
      pause: () => {
        void root.pause();
      },
      resume: () => {
        void root.resume();
      },
    });
    const unwireLifecycle = wireSubprocessorLifecycle(processor, {
      autoCleanup: false,
      signal: sameGraphOwner === root ? undefined : sameGraphOwner.#abortController.signal,
      parentAbortSignal: root.#abortController.signal,
      onParentPause: (listener) => {
        root.on('pause', listener);
        return () => {
          root.off('pause', listener);
        };
      },
      onParentResume: (listener) => {
        root.on('resume', listener);
        return () => {
          root.off('resume', listener);
        };
      },
    });
    root.#subprocessors.add(processor);

    try {
      if (root.#lifecycle.isPaused) {
        processor.pause();
      }
      await processor.processGraph(this.#context, this.#graphInputs, this.#contextValues);
    } finally {
      root.#totalCost += processor.#totalCost;
      unwireLifecycle();
      unwireEvents();
      root.#subprocessors.delete(processor);
    }
  }

  #recordManagedAsyncBranchFailure(
    triggerNode: ChartNode,
    processor: GraphProcessor | undefined,
    error: unknown,
  ): void {
    const nodeErrors =
      processor && processor.#erroredNodes
        ? [...processor.#erroredNodes.entries()].flatMap(([nodeId, nodeError]) => {
            const node = processor.#nodesById[nodeId];
            return node ? [{ error: nodeError, node }] : [];
          })
        : [];

    this.#managedAsyncBranchFailures.push({
      error: getError(error),
      nodeErrors,
      triggerNode,
    });
  }

  #getAttachedDataTo(node: ChartNode | NodeId): AttachedNodeData {
    const nodeId = typeof node === 'string' ? node : node.id;
    let nodeData = this.#attachedNodeData.get(nodeId);
    if (nodeData == null) {
      nodeData = {};
      this.#attachedNodeData.set(nodeId, nodeData);
    }
    return nodeData;
  }

  async #processNode(node: ChartNode, inputValues: Inputs) {
    const processId = nanoid() as ProcessId;

    if (this.#abortController.signal.aborted) {
      await this.#nodeErrored(node, createGraphAbortErrorFromSignal(this.#abortController.signal), processId);
      this.#successfulAbortTerminalProcessIds.delete(processId);
      return { processId, shouldQueueOutputNodes: false };
    }

    const frozenOutputs = this.#resolveFrozenNodeOutputs(node, inputValues, processId);
    if (frozenOutputs && node.type === 'startBackgroundBranch') {
      await this.#nodeErrored(
        node,
        new Error('Start Async Branch cannot use frozen outputs because replaying it could repeat async side effects.'),
        processId,
        undefined,
        undefined,
        'frozen',
      );
    } else if (frozenOutputs) {
      await this.#processFrozenNode(node, processId, inputValues, frozenOutputs);
    } else if (node.isSplitRun) {
      await this.#processSplitRunNode(node, processId);
    } else {
      await this.#processNormalNode(node, processId, inputValues);
    }

    const successfulAbortTerminal = this.#successfulAbortTerminalProcessIds.delete(processId);
    return { processId, shouldQueueOutputNodes: !successfulAbortTerminal };
  }

  async #processSplitRunNode(node: ChartNode, processId: ProcessId) {
    return processSplitRunNode(node, processId, {
      getInputValues: (n) => this.#getInputValuesForNode(n),
      getInputConnections: (n) => this.#getInputConnectionsForNode(n),
      getInputDefinitions: (n) => this.#definitions[n.id]?.inputs ?? [],
      isExcludedDueToControlFlow: (n, inputs, pid) => this.#excludedDueToControlFlow(n, inputs, pid) !== false,
      processNodeWithInputData: (n, inputs, idx, pid, partial, markResultAsEditorCacheHit) =>
        this.#processNodeWithInputData(n, inputs, idx, pid, partial, markResultAsEditorCacheHit),
      splitRunConcurrency: this.#concurrency.splitRunConcurrency,
      accumulateCost: (output) => this.#accumulateCost(output),
      setNodeResults: (nodeId, outputs) => this.#nodeResults.set(nodeId, outputs),
      markNodeVisited: (nodeId) => this.#visitedNodes.add(nodeId),
      nodeErrored: (n, err, pid, durationMs, splitRunDurationMs, resultOrigin) =>
        this.#nodeErrored(n, err, pid, durationMs, splitRunDurationMs, resultOrigin),
      isAborted: () => this.#lifecycle.isAborted,
      getAbortError: () => createGraphAbortErrorFromSignal(this.#abortController.signal),
      emit: (event, data) => {
        if (event === 'partialOutput') {
          emitDetached(this.#emitter, event, this.#withExecution(data));
          return;
        }

        return this.#emitter.emit(event, this.#withExecution(data));
      },
      startNodeTiming: this.#captureNodeTimings ? () => this.#startNodeTiming() : undefined,
      finishNodeTiming: this.#captureNodeTimings ? (start) => this.#finishNodeTiming(start) : undefined,
    });
  }

  #resolveFrozenNodeOutputs(node: ChartNode, inputValues: Inputs, processId: ProcessId): Outputs | undefined {
    return this.#frozenNodeOutputResolver?.({
      execution: this.#buildExecutionMetadata(),
      graphId: this.#graph.metadata!.id!,
      inputs: inputValues,
      node,
      processId,
    });
  }

  async #processFrozenNode(node: ChartNode, processId: ProcessId, inputValues: Inputs, outputValues: Outputs) {
    await this.#emitter.emit(
      'nodeStart',
      this.#withExecution({
        node,
        inputs: inputValues,
        inputConnections: this.#getInputConnectionsForNode(node),
        processId,
        resultOrigin: 'frozen' as const,
      }),
    );

    const timingStart = this.#startNodeTiming();
    this.#nodeResults.set(node.id, outputValues);
    this.#visitedNodes.add(node.id);
    this.#accumulateCost(outputValues);
    await this.#applyFrozenNodeDataflowEffects(node, outputValues, processId);

    await this.#emitter.emit(
      'nodeFinish',
      this.#withExecution(
        withOptionalDuration(
          {
            node,
            outputs: outputValues,
            processId,
            resultOrigin: 'frozen' as const,
          },
          this.#finishNodeTiming(timingStart),
        ),
      ),
    );
  }

  async #applyFrozenNodeDataflowEffects(node: ChartNode, outputValues: Outputs, processId: ProcessId): Promise<void> {
    const effect = applyFrozenGraphBoundaryEffects(this.#graphOutputs, node, outputValues);
    if (!effect) {
      return;
    }

    if (effect.type === 'setStoredValue') {
      await this.#storedValueController.seed(effect.key, effect.value);
      return;
    }

    this.#globals.set(effect.variableId, effect.value);
    emitDetached(
      this.#emitter,
      'globalSet',
      this.#withExecution({ id: effect.variableId, value: effect.value, processId }),
    );
  }

  async #processNormalNode(node: ChartNode, processId: ProcessId, inputValues: Inputs) {
    // Use awaited emit (not emitDetached) so that listeners can yield to the
    // macrotask queue, giving the browser a chance to repaint during execution.
    await this.#emitter.emit(
      'nodeStart',
      this.#withExecution({
        node,
        inputs: inputValues,
        inputConnections: this.#getInputConnectionsForNode(node),
        processId,
        resultOrigin: 'executed' as const,
      }),
    );

    const timingStart = this.#startNodeTiming();
    let resultOrigin: NodeResultOrigin = 'executed';

    try {
      const outputValues = await this.#processNodeWithInputData(
        node,
        inputValues,
        0,
        processId,
        (node, partialOutputs, index) => this.#emitNodePartialOutput(node, partialOutputs, index, processId),
        () => {
          resultOrigin = 'editor-cache';
        },
      );

      this.#nodeResults.set(node.id, outputValues);
      this.#visitedNodes.add(node.id);
      this.#accumulateCost(outputValues);
      await this.#emitter.emit(
        'nodeFinish',
        this.#withExecution(
          withOptionalDuration(
            {
              node,
              outputs: outputValues,
              processId,
              resultOrigin,
            },
            this.#finishNodeTiming(timingStart),
          ),
        ),
      );
    } catch (error) {
      await this.#nodeErrored(node, error, processId, this.#finishNodeTiming(timingStart), undefined, resultOrigin);
    }
  }

  async #nodeErrored(
    node: ChartNode,
    e: unknown,
    processId: ProcessId,
    durationMs?: number,
    splitRunDurationMs?: Record<number, number>,
    resultOrigin: NodeResultOrigin = 'executed',
  ): Promise<void> {
    const error = getError(e);
    const exclusionReason = this.#getErrorExclusionReason(node, error, processId);
    if (exclusionReason) {
      await this.#emitNodeExcluded(node, processId, this.#getInputValuesForNode(node), exclusionReason, resultOrigin);
      this.#emitTraceEvent(`Node ${node.title} (${node.id}-${processId}) was excluded: ${exclusionReason}`);
      return;
    }

    this.#erroredNodes.set(node.id, error);
    await this.#emitter.emit(
      'nodeError',
      this.#withExecution(
        withOptionalDuration({ node, error, processId, resultOrigin }, durationMs, splitRunDurationMs),
      ),
    );
    this.#emitTraceEvent(`Node ${node.title} (${node.id}-${processId}) errored: ${error.stack}`);
  }

  #emitNodePartialOutput(node: ChartNode, outputs: Outputs, index: number, processId: ProcessId): void {
    emitDetached(
      this.#emitter,
      'partialOutput',
      this.#withExecution({ node, outputs, index, processId, resultOrigin: 'executed' as const }),
    );
  }

  #getErrorExclusionReason(node: ChartNode, error: Error, processId: ProcessId): string | undefined {
    if (this.#getAttachedDataTo(node).races?.completed) {
      return RACE_LOSER_EXCLUSION_REASON;
    }

    const abortReason = getGraphAbortReasonFromError(error);
    if (isRaceLoserGraphAbortReason(abortReason)) {
      return RACE_LOSER_EXCLUSION_REASON;
    }

    if (isSuccessfulNonRaceGraphAbortReason(abortReason)) {
      this.#successfulAbortTerminalProcessIds.add(processId);
      return SUCCESSFUL_GRAPH_ABORT_EXCLUSION_REASON;
    }

    if (this.#lifecycle.abortSuccessful && isAbortLikeError(error)) {
      const exclusionReason =
        this.#lifecycle.abortError === RACE_LOSER_EXCLUSION_REASON
          ? RACE_LOSER_EXCLUSION_REASON
          : SUCCESSFUL_GRAPH_ABORT_EXCLUSION_REASON;
      if (exclusionReason === SUCCESSFUL_GRAPH_ABORT_EXCLUSION_REASON) {
        this.#successfulAbortTerminalProcessIds.add(processId);
      }
      return exclusionReason;
    }

    return undefined;
  }

  getRootProcessor(): GraphProcessor {
    let processor: GraphProcessor = this;
    while (processor.#parent) {
      processor = processor.#parent;
    }
    return processor;
  }

  /** Raise a user event on the processor, all subprocessors, and their children. */
  raiseEvent(event: string, data: DataValue) {
    emitDetached(this.#emitter, `userEvent:${event}`, data);

    for (const subprocessor of this.#subprocessors) {
      subprocessor.raiseEvent(event, data);
    }
  }

  #newAbortController() {
    const controller = new AbortController();
    emitDetached(this.#emitter, 'newAbortController', controller);
    return controller;
  }

  #registerNodeAbortController(nodeId: NodeId, abortController: AbortController): void {
    const existingAbortControllers = this.#nodeAbortControllers.get(nodeId);
    if (!existingAbortControllers) {
      this.#nodeAbortControllers.set(nodeId, abortController);
      return;
    }

    if (existingAbortControllers instanceof Set) {
      existingAbortControllers.add(abortController);
      return;
    }

    if (existingAbortControllers === abortController) {
      return;
    }

    this.#nodeAbortControllers.set(nodeId, new Set([existingAbortControllers, abortController]));
  }

  #unregisterNodeAbortController(nodeId: NodeId, abortController: AbortController): void {
    const existingAbortControllers = this.#nodeAbortControllers.get(nodeId);
    if (!existingAbortControllers) {
      return;
    }

    if (existingAbortControllers === abortController) {
      this.#nodeAbortControllers.delete(nodeId);
      return;
    }

    if (!(existingAbortControllers instanceof Set)) {
      return;
    }

    existingAbortControllers.delete(abortController);
    if (existingAbortControllers.size === 0) {
      this.#nodeAbortControllers.delete(nodeId);
    } else if (existingAbortControllers.size === 1) {
      this.#nodeAbortControllers.set(nodeId, existingAbortControllers.values().next().value!);
    }
  }

  #abortNodeControllersForNode(nodeId: NodeId, traceMessage?: string, reason?: unknown): void {
    const abortControllerEntry = this.#nodeAbortControllers.get(nodeId);
    if (!abortControllerEntry) {
      return;
    }

    if (!(abortControllerEntry instanceof Set)) {
      if (traceMessage) {
        this.#emitTraceEvent(traceMessage);
      }
      abortControllerEntry.abort(reason);
      return;
    }

    for (const abortController of abortControllerEntry) {
      if (traceMessage) {
        this.#emitTraceEvent(traceMessage);
      }
      abortController.abort(reason);
    }
  }

  #abortActiveNodeControllers(reason?: unknown): void {
    for (const nodeId of [...this.#nodeAbortControllers.keys()]) {
      this.#abortNodeControllersForNode(nodeId, undefined, reason);
    }
  }

  async #processNodeWithInputData(
    node: ChartNode,
    inputValues: Inputs,
    index: number,
    processId: ProcessId,
    partialOutput?: (node: ChartNode, partialOutputs: Outputs, index: number) => void,
    markResultAsEditorCacheHit?: () => void,
  ) {
    const instance = this.#nodeInstances[node.id]!;
    const nodeAbortController = this.#newAbortController();
    this.#registerNodeAbortController(node.id, nodeAbortController);
    if (this.#abortController.signal.aborted) {
      nodeAbortController.abort(getAbortSignalReason(this.#abortController.signal));
    }
    let continuationFinalized = false;
    try {
      const createContextProfileStart = this.#startRuntimeProfile();
      let context: InternalProcessContext;
      try {
        context = this.#createNodeProcessContext(
          node,
          inputValues,
          index,
          processId,
          nodeAbortController,
          partialOutput,
          undefined,
          markResultAsEditorCacheHit,
        );
      } finally {
        this.#finishRuntimeProfile('createNodeProcessContext', createContextProfileStart);
      }

      await this.#waitUntilUnpaused();
      const implementationProfileStart = this.#startRuntimeProfile();
      let results: Outputs;
      try {
        results = await instance.process(inputValues, context);
      } finally {
        this.#finishRuntimeProfile('nodeImplementation', implementationProfileStart);
      }

      const abortReason = getGraphAbortReasonFromSignal(nodeAbortController.signal);
      if (nodeAbortController.signal.aborted) {
        if (isSuccessfulNonRaceGraphAbortReason(abortReason)) {
          this.#successfulAbortTerminalProcessIds.add(processId);
          return results;
        } else {
          throw createGraphAbortError(abortReason, 'Aborted');
        }
      }

      this.#finalizeToolCallContinuation(processId, index, results);
      continuationFinalized = true;
      return results;
    } finally {
      if (!continuationFinalized) {
        this.#discardToolCallContinuation(processId, index);
      }
      this.#unregisterNodeAbortController(node.id, nodeAbortController);
    }
  }

  #getTokenizer() {
    return this.#context.tokenizer;
  }

  #createNodeProcessContext(
    node: ChartNode,
    inputValues: Inputs,
    index: number,
    processId: ProcessId,
    nodeAbortController: AbortController,
    partialOutput?: (node: ChartNode, partialOutputs: Outputs, index: number) => void,
    toolCallTraceSource?: InternalProcessContext['toolCallTraceSource'],
    markResultAsEditorCacheHit?: InternalProcessContext['markResultAsEditorCacheHit'],
  ): InternalProcessContext {
    const plugin = this.#registry.getPluginFor(node.type);
    const toolCallContinuation = this.#getToolCallContinuationContext(
      node,
      nodeAbortController.signal,
      processId,
      index,
    );

    return buildNodeProcessContext({
      activeOutputPortIds: this.#getActiveOutputPortIds(node),
      attachedData: this.#getAttachedDataTo(node),
      base: this.#nodeProcessContextBase,
      createSubProcessor: (subGraphId, options = {}) =>
        this.#createSubProcessor(node, index, processId, subGraphId, options),
      execution: this.#buildExecutionMetadata(),
      externalFunctions: this.#externalFunctions,
      getPluginConfig: (name) => getPluginConfig(plugin, this.#context.settings, name),
      isDirectRunTarget: this.runToNodeIds?.includes(node.id) ?? false,
      markResultAsEditorCacheHit,
      node,
      nodeAbortController,
      onPartialOutputs: (partialOutputs) => {
        partialOutput?.(node, partialOutputs, index);
        this.#emitGraphPartialOutputIfNeeded(node, partialOutputs);
      },
      processId,
      requestUserInput: async (inputStrings, renderingType) =>
        this.#requestUserInput(node, inputStrings, inputValues, renderingType, processId),
      reportProgress: (progress) => {
        const normalized = normalizeGraphProgress(progress);
        if (normalized) {
          emitDetached(this.#emitter, 'progress', this.#withExecution({ node, processId, progress: normalized }));
        }
      },
      setGlobal: (id, value) => {
        this.#globals.set(id, value);
        emitDetached(this.#emitter, 'globalSet', this.#withExecution({ id, value, processId }));
      },
      toolCallContinuation,
      toolCallTraceSource,
      waitEvent: async (event) => {
        return new Promise((resolve, reject) => {
          const abortListener = () => {
            reject(createGraphAbortErrorFromSignal(nodeAbortController.signal, 'Process aborted'));
          };

          this.#emitter
            .once(`userEvent:${event}`)
            .then(resolve)
            .catch(reject)
            .finally(() => {
              nodeAbortController.signal.removeEventListener('abort', abortListener);
            });
          nodeAbortController.signal.addEventListener('abort', abortListener, { once: true });
        });
      },
    });
  }

  #getToolCallContinuationContext(
    node: ChartNode,
    llmSignal: AbortSignal,
    processId: ProcessId,
    index: number,
  ): ToolCallContinuation | undefined {
    if (node.type !== 'llmChatV2') {
      return undefined;
    }

    const connections = this.#getEffectiveConnections();
    const resolution = resolveToolContinuationConnection(
      {
        connections,
        nodes: Object.values(this.#nodesById),
      },
      node.id,
    );

    if (resolution.kind === 'none') {
      return undefined;
    }

    if (resolution.kind === 'ambiguous') {
      throw new Error(
        `LLM Chat "${node.title}" has ${resolution.candidates.length} connected Delegate Tool Call nodes. Auto-continue requires exactly one Delegate Tool Call connection.`,
      );
    }

    const delegateNode = resolution.delegateNode as DelegateFunctionCallNode;
    const invocationKey = this.#getToolCallContinuationInvocationKey(processId, index);
    const invocation: ToolCallContinuationInvocation = {
      delegateNode,
      latestOutputs: new Map(),
      llmNodeId: node.id,
      llmProcessId: processId,
      released: false,
    };
    this.#toolCallContinuationInvocations.set(invocationKey, invocation);

    return {
      run: (toolCalls, assistantMessage) =>
        this.#runToolCallContinuationRound(node, invocation, toolCalls, assistantMessage, llmSignal),
      release: () => {
        invocation.released = true;
      },
    };
  }

  #getToolCallContinuationInvocationKey(processId: ProcessId, index: number): string {
    return `${processId}:${index}`;
  }

  #finalizeToolCallContinuation(processId: ProcessId, index: number, nodeOutputs: Outputs): void {
    const invocationKey = this.#getToolCallContinuationInvocationKey(processId, index);
    const invocation = this.#toolCallContinuationInvocations.get(invocationKey);
    this.#toolCallContinuationInvocations.delete(invocationKey);
    if (!invocation || invocation.released) {
      return;
    }

    if (invocation.latestOutputs.size === 0) {
      const replayedCalls = nodeOutputs['function-calls' as PortId];
      if (
        replayedCalls?.type === 'object[]' &&
        replayedCalls.value.length > 0 &&
        replayedCalls.value.every(isDelegatedToolCallRecord)
      ) {
        invocation.latestOutputs.set(invocation.delegateNode.id, buildDelegatedToolCallOutputs(replayedCalls.value));
      }
    }

    for (const [nodeId, outputs] of invocation.latestOutputs) {
      this.#nodeResults.set(nodeId, outputs);
      this.#visitedNodes.add(nodeId);
      this.#remainingNodes.delete(nodeId);
      this.#continuationCompletionOwnerByNodeId.set(nodeId, invocation.llmNodeId);
    }
  }

  #discardToolCallContinuation(processId: ProcessId, index: number): void {
    this.#toolCallContinuationInvocations.delete(this.#getToolCallContinuationInvocationKey(processId, index));
  }

  async #runToolCallContinuationRound(
    llmNode: ChartNode,
    invocation: ToolCallContinuationInvocation,
    toolCalls: StreamedFunctionCall[],
    assistantMessage: string,
    llmSignal: AbortSignal,
  ): Promise<ToolCallContinuationResult[]> {
    const round = await new ToolCallContinuationCoordinator(
      this.#createToolCallContinuationCoordinatorAdapter(llmNode.id, invocation.llmProcessId),
    ).run({
      assistantMessage,
      delegateNode: invocation.delegateNode,
      llmNode,
      llmSignal,
      toolCalls,
    });

    for (const result of round.invocations) {
      invocation.latestOutputs.set(invocation.delegateNode.id, result.outputs);
      for (const branch of [result.preToolBranch, result.finalBranch]) {
        this.#commitContinuationGraphOutputs(branch.graphOutputWrites);
        for (const [nodeId, outputs] of branch.nodeOutputs) {
          invocation.latestOutputs.set(nodeId, outputs);
        }
      }
    }

    return [...round.results];
  }

  #createToolCallContinuationCoordinatorAdapter(
    sourceNodeId: NodeId,
    sourceProcessId: ProcessId,
  ): ToolCallContinuationCoordinatorAdapter {
    return {
      accumulateCost: (outputs) => this.#accumulateCost(outputs),
      createBranchAdapter: () => {
        const branchPlanner = this.#createToolCallContinuationBranchPlanner();
        return {
          canRunContinuationBranches: (llmNode, delegateNode) =>
            !branchPlanner.unsafeNodeIds.has(llmNode.id) && !branchPlanner.unsafeNodeIds.has(delegateNode.id),
          runOutputBranch: (request) =>
            this.#runContinuationOutputBranch(
              request.sourceNode,
              request.sourceOutputs,
              request.activeOutputPortIds,
              request.signal,
              request.availableNodeOutputs,
              request.excludedNodeIds,
              branchPlanner,
              request.failOnUnsafeReadyNode,
              request.deferGraphOutputCommit,
            ),
          validatePreToolBranch: (request) => {
            this.#planToolCallContinuationBranch(
              request.sourceNode,
              request.sourceOutputs,
              request.activeOutputPortIds,
              new Map(),
              request.excludedNodeIds,
              branchPlanner,
              true,
            );
          },
        };
      },
      createDelegateProcessContext: (node, inputs, processId, nodeAbortController) =>
        this.#createNodeProcessContext(
          node,
          inputs,
          0,
          processId,
          nodeAbortController,
          (partialNode, partialOutputs, index) =>
            this.#emitNodePartialOutput(partialNode, partialOutputs, index, processId),
          { nodeId: sourceNodeId, processId: sourceProcessId },
        ),
      createNodeAbortController: () => this.#newAbortController(),
      emitDelegateError: (node, error, processId, timingStart) =>
        this.#nodeErrored(node, error, processId, this.#finishNodeTiming(timingStart)),
      emitDelegateFinish: async (node, outputs, processId, timingStart) => {
        await this.#emitter.emit(
          'nodeFinish',
          this.#withExecution(
            withOptionalDuration(
              {
                node,
                outputs,
                processId,
                resultOrigin: 'executed' as const,
              },
              this.#finishNodeTiming(timingStart),
            ),
          ),
        );
      },
      emitDelegatePartialOutput: (node, outputs, processId) => this.#emitNodePartialOutput(node, outputs, 0, processId),
      emitDelegateStart: (node, inputs, processId) =>
        this.#emitter.emit(
          'nodeStart',
          this.#withExecution({
            node,
            inputs,
            inputConnections: this.#getInputConnectionsForNode(node),
            processId,
            resultOrigin: 'executed' as const,
          }),
        ),
      getActiveOutputPortIds: (node) => this.#getActiveOutputPortIds(node),
      getContinuationBranchBoundaryNodeIds: (llmNode) => new Set<NodeId>([llmNode.id, ...this.#currentlyProcessing]),
      hasPreloadedOrFrozenDelegateOutput: (node, inputs, processId) =>
        this.#nodeResults.has(node.id) || this.#resolveFrozenNodeOutputs(node, inputs, processId) != null,
      registerNodeAbortController: (nodeId, controller) => this.#registerNodeAbortController(nodeId, controller),
      rootAbortSignal: this.#abortController.signal,
      unregisterNodeAbortController: (nodeId, controller) => this.#unregisterNodeAbortController(nodeId, controller),
      startNodeTiming: () => this.#startNodeTiming(),
      waitUntilUnpaused: () => this.#waitUntilUnpaused(),
    };
  }
  async #runContinuationOutputBranch(
    sourceNode: ChartNode,
    sourceOutputs: Outputs,
    activeOutputPortIds: ReadonlySet<PortId>,
    signal: AbortSignal,
    availableNodeOutputs: ReadonlyMap<NodeId, Outputs>,
    excludedNodeIds: ReadonlySet<NodeId>,
    branchPlanner: ToolCallContinuationBranchPlanner,
    failOnUnsafeReadyNode = false,
    deferGraphOutputCommit = false,
  ): Promise<ToolCallContinuationBranchRunResult> {
    if (signal.aborted) {
      throw createGraphAbortErrorFromSignal(signal, 'Tool continuation branch aborted');
    }

    const branchPlan = this.#planToolCallContinuationBranch(
      sourceNode,
      sourceOutputs,
      activeOutputPortIds,
      availableNodeOutputs,
      excludedNodeIds,
      branchPlanner,
      failOnUnsafeReadyNode,
    );
    if (!branchPlan) {
      return { graphOutputWrites: {}, nodeOutputs: new Map() };
    }

    const graphId = branchPlan.graph.metadata?.id;
    if (!graphId) {
      throw new Error('Cannot execute a tool continuation branch because the current graph has no ID.');
    }

    const branchRuntimeCache: GraphProcessorRuntimeCache = {
      ...this.#runtimeCache,
      graphBoundaries: undefined,
      loadedProjects: { ...this.#loadedProjects },
    };
    const branchGraphOutputs = createGraphOutputsOverlay(this.#graphOutputs);
    const processor = new GraphProcessor(this.#project, graphId, this.#registry, this.#includeTrace, {
      cacheLoadedProjects: true,
      captureNodeTimings: this.#captureNodeTimings,
      concurrency: this.#concurrency,
      executionPlanCacheMode: this.#executionPlanCacheMode,
      runtimeCache: branchRuntimeCache,
      runtimeProfiler: this.#runtimeProfiler,
      scheduler: this.#scheduler,
      [graphProcessorGraphOverride]: branchPlan.graph,
    });

    processor.executor = this.executor;
    processor.#isSubProcessor = true;
    processor.#executionCache = this.#executionCache;
    processor.#externalFunctions = this.#externalFunctions;
    processor.#contextValues = this.#contextValues;
    processor.#parent = this;
    processor.#abortOwnerOverride = this.#abortOwnerOverride ?? this;
    processor.#sameGraphRunOwnerOverride = this.#sameGraphRunOwnerOverride ?? this;
    processor.#globals = this.#globals;
    processor.#storedValueController = this.#storedValueController;
    processor.#knowledgeStoreController = this.#knowledgeStoreController;
    processor.#frozenNodeOutputResolver = this.#frozenNodeOutputResolver;
    processor.#executor = this.#executor;
    processor.#suppressGraphLifecycleEvents = true;
    processor.#sharedRunStateOverride = {
      attachedNodeData: this.#attachedNodeData,
      graphInputNodeValues: this.#graphInputNodeValues,
      graphOutputs: branchGraphOutputs.view,
    };
    const branchNodeIds = new Set(branchPlan.graph.nodes.map((node) => node.id));
    const branchRunToNodeIds = this.runToNodeIds?.filter((nodeId) => branchNodeIds.has(nodeId));
    processor.runToNodeIds = branchRunToNodeIds?.length ? branchRunToNodeIds : undefined;
    processor.#executionIdentityOverride = {
      rootRunId: this.#rootRunId,
      graphRunId: this.#graphRunId,
      parentGraphRunId: this.#parentGraphRunId,
    };

    for (const [nodeId, outputs] of branchPlan.preloadedOutputs) {
      processor.preloadNodeData(nodeId, outputs);
      processor.#suppressedPreloadedNodeIds.add(nodeId);
    }

    const unwireEvents = wireSubprocessorEvents(processor, this.#emitter, {
      autoCleanup: false,
      isPaused: () => this.#lifecycle.isPaused,
      pause: () => {
        void this.pause();
      },
      resume: () => {
        void this.resume();
      },
    });
    const unwireLifecycle = wireSubprocessorLifecycle(processor, {
      autoCleanup: false,
      signal,
      parentAbortSignal: this.#abortController.signal,
      onParentPause: (listener) => {
        this.on('pause', listener);
        return () => {
          this.off('pause', listener);
        };
      },
      onParentResume: (listener) => {
        this.on('resume', listener);
        return () => {
          this.off('resume', listener);
        };
      },
    });
    this.#subprocessors.add(processor);

    try {
      if (signal.aborted) {
        throw createGraphAbortErrorFromSignal(signal, 'Tool continuation branch aborted');
      }
      await processor.processGraph(this.#context, this.#graphInputs, this.#contextValues);
      if (!deferGraphOutputCommit) {
        this.#commitContinuationGraphOutputs(branchGraphOutputs.writes);
      }
      return {
        graphOutputWrites: branchGraphOutputs.writes,
        nodeOutputs: this.#getContinuationBranchResults(processor, branchPlan),
      };
    } finally {
      this.#totalCost += processor.#totalCost;
      unwireLifecycle();
      unwireEvents();
      this.#subprocessors.delete(processor);
    }
  }

  #commitContinuationGraphOutputs(writes: GraphOutputs): void {
    for (const [outputId, value] of Object.entries(writes)) {
      const existingValue = this.#graphOutputs[outputId];
      if (existingValue == null || existingValue.type === 'control-flow-excluded') {
        this.#graphOutputs[outputId] = value;
      }
    }
  }

  #getContinuationBranchResults(
    processor: GraphProcessor,
    branchPlan: ToolCallContinuationBranchPlan,
  ): Map<NodeId, Outputs> {
    const results = new Map<NodeId, Outputs>();
    for (const [nodeId, outputs] of processor.#nodeResults) {
      if (branchPlan.preloadedOutputs.has(nodeId) || !processor.#visitedNodes.has(nodeId)) {
        continue;
      }
      results.set(nodeId, outputs);
    }
    return results;
  }

  #planToolCallContinuationBranch(
    sourceNode: ChartNode,
    sourceOutputs: Outputs,
    activeOutputPortIds: ReadonlySet<PortId>,
    availableNodeOutputs: ReadonlyMap<NodeId, Outputs>,
    excludedNodeIds: ReadonlySet<NodeId>,
    branchPlanner: ToolCallContinuationBranchPlanner,
    failOnUnsafeReadyNode = false,
  ): ToolCallContinuationBranchPlan | undefined {
    return branchPlanner.plan({
      activeOutputPortIds,
      availableNodeOutputs,
      excludedNodeIds,
      failOnUnsafeReadyNode,
      sourceNode,
      sourceOutputs,
      state: {
        erroredNodeIds: new Set(this.#erroredNodes.keys()),
        nodeOutputs: this.#nodeResults,
        runToRelevantNodeIds: this.#getRunToRelevantNodeIds(),
        visitedNodeIds: this.#visitedNodes,
      },
    });
  }

  #createToolCallContinuationBranchPlanner(): ToolCallContinuationBranchPlanner {
    return createToolCallContinuationBranchPlanner({
      asyncBranchPlansByTriggerNodeId: this.#asyncBranchPlansByTriggerNodeId,
      attachedNodeDataByNodeId: this.#attachedNodeData,
      effectiveConnections: this.#getEffectiveConnections(),
      graph: this.#getExecutionGraph(),
      isDefinitionValidConnection: (connection) => this.#isDefinitionValidConnection(connection),
      nodesById: this.#nodesById,
      stronglyConnectedComponents: this.#scc,
    });
  }

  /**
   * Graph-owned metadata is retained, but every scheduler-facing consumer
   * receives the preprocessed topology. In particular, a Data Bus is not an
   * executable intermediate node for tool-continuation discovery.
   */
  #getExecutionGraph(): NodeGraph {
    return {
      metadata: this.#graph.metadata ? { ...this.#graph.metadata } : undefined,
      nodes: this.#executionGraphNodes,
      // Keep every preprocessed connection here, rather than the scheduler's
      // one-provider-per-input execution projection. The continuation planner
      // needs to see otherwise-shadowed valid edges to reject unsafe cycles
      // before it starts a pre-tool branch.
      connections: [...new Set(Object.values(this.#connections).flat())],
    };
  }
  #getEffectiveConnections(): NodeConnection[] {
    if (this.#effectiveConnectionsForRun) {
      return this.#effectiveConnectionsForRun;
    }

    const plannedConnections = this.#graphExecutionPlan?.inputConnectionByNodeAndPort;
    if (plannedConnections) {
      this.#effectiveConnectionsForRun = Object.values(plannedConnections).flatMap((connectionsByPort) =>
        Object.values(connectionsByPort).filter((connection): connection is NodeConnection => connection != null),
      );
      return this.#effectiveConnectionsForRun;
    }

    this.#effectiveConnectionsForRun = Object.values(this.#nodesById).flatMap((node) => {
      const seenInputIds = new Set<PortId>();
      return (this.#connections[node.id] ?? []).filter((connection) => {
        if (connection.inputNodeId !== node.id || seenInputIds.has(connection.inputId)) {
          return false;
        }
        seenInputIds.add(connection.inputId);
        return true;
      });
    });
    return this.#effectiveConnectionsForRun;
  }

  #prepareAsyncBranchTopology(): void {
    const connections = this.#getEffectiveConnections().filter((connection) =>
      this.#isDefinitionValidConnection(connection),
    );
    const outgoingByNodeId = new Map<NodeId, NodeConnection[]>();
    const incomingByNodeId = new Map<NodeId, NodeConnection[]>();
    const runToRelevantNodeIds = this.#getRunToRelevantNodeIds();
    const isRunToRelevant = (nodeId: NodeId) => !runToRelevantNodeIds || runToRelevantNodeIds.has(nodeId);

    for (const connection of connections) {
      const outgoing = outgoingByNodeId.get(connection.outputNodeId) ?? [];
      outgoing.push(connection);
      outgoingByNodeId.set(connection.outputNodeId, outgoing);

      const incoming = incomingByNodeId.get(connection.inputNodeId) ?? [];
      incoming.push(connection);
      incomingByNodeId.set(connection.inputNodeId, incoming);
    }

    for (const triggerNode of Object.values(this.#nodesById)) {
      if (triggerNode.type !== 'startBackgroundBranch' || triggerNode.disabled || !isRunToRelevant(triggerNode.id)) {
        continue;
      }
      if (triggerNode.id !== this.#consumedAsyncBranchTriggerNodeId && this.#nodeResults.has(triggerNode.id)) {
        throw new Error(
          `Start Async Branch "${triggerNode.title}" cannot use preloaded outputs because replaying it could repeat async side effects.`,
        );
      }

      const nodeIds = new Set<NodeId>();
      const pendingNodeIds = (outgoingByNodeId.get(triggerNode.id) ?? [])
        .map((connection) => connection.inputNodeId)
        .filter(isRunToRelevant);

      while (pendingNodeIds.length > 0) {
        const nodeId = pendingNodeIds.pop()!;
        if (nodeId === triggerNode.id) {
          throw new Error(
            `Start Async Branch "${triggerNode.title}" cannot be part of a cycle or reconnect to its own inputs.`,
          );
        }
        if (nodeIds.has(nodeId)) {
          continue;
        }

        const node = this.#nodesById[nodeId];
        if (!node) {
          continue;
        }
        if (node.disabled) {
          continue;
        }
        if (node.type === 'graphOutput') {
          throw new Error(
            `Start Async Branch "${triggerNode.title}" cannot contain Graph Output node "${node.title}". Async branches are side-effect-only.`,
          );
        }

        nodeIds.add(nodeId);
        for (const connection of outgoingByNodeId.get(nodeId) ?? []) {
          if (isRunToRelevant(connection.inputNodeId)) {
            pendingNodeIds.push(connection.inputNodeId);
          }
        }
      }

      for (const nodeId of nodeIds) {
        const externalInput = (incomingByNodeId.get(nodeId) ?? []).find(
          (connection) => connection.outputNodeId !== triggerNode.id && !nodeIds.has(connection.outputNodeId),
        );
        if (externalInput) {
          const node = this.#nodesById[nodeId]!;
          const externalNode = this.#nodesById[externalInput.outputNodeId];
          throw new Error(
            `Start Async Branch "${triggerNode.title}" cannot run "${node.title}" because it also depends on ` +
              `"${externalNode?.title ?? externalInput.outputNodeId}" outside the async branch. Assemble all required values before the async trigger.`,
          );
        }
      }

      if (nodeIds.size === 0) {
        continue;
      }

      const preloadedNodeId = [...nodeIds].find((nodeId) => this.#nodeResults.has(nodeId));
      if (preloadedNodeId) {
        const preloadedNode = this.#nodesById[preloadedNodeId]!;
        throw new Error(
          `Start Async Branch "${triggerNode.title}" cannot contain preloaded node "${preloadedNode.title}". Preloading an async descendant would bypass the trigger boundary.`,
        );
      }

      // The node derives its variadic output definitions from connected inputs.
      // Retain shallow input anchors in the slice even though the trigger itself is preloaded.
      const triggerInputConnections = connections.filter((connection) => connection.inputNodeId === triggerNode.id);
      const inputAnchorNodeIds = new Set(triggerInputConnections.map((connection) => connection.outputNodeId));
      const includedNodeIds = new Set<NodeId>([triggerNode.id, ...nodeIds, ...inputAnchorNodeIds]);
      const graph: NodeGraph = {
        metadata: this.#graph.metadata ? { ...this.#graph.metadata } : undefined,
        nodes: this.#executionGraphNodes.filter((node) => includedNodeIds.has(node.id)),
        connections: connections.filter(
          (connection) =>
            connection.inputNodeId === triggerNode.id ||
            (nodeIds.has(connection.inputNodeId) &&
              (connection.outputNodeId === triggerNode.id || nodeIds.has(connection.outputNodeId))),
        ),
      };
      this.#asyncBranchPlansByTriggerNodeId.set(triggerNode.id, { graph, nodeIds });

      if (triggerNode.id !== this.#consumedAsyncBranchTriggerNodeId) {
        for (const nodeId of nodeIds) {
          this.#ignoreNodes.add(nodeId);
        }
      }
    }
  }

  #isDefinitionValidConnection(connection: NodeConnection): boolean {
    const outputDefinitions = this.#definitions[connection.outputNodeId]?.outputs ?? [];
    const inputDefinitions = this.#definitions[connection.inputNodeId]?.inputs ?? [];
    return (
      outputDefinitions.some((definition) => definition.id === connection.outputId) &&
      inputDefinitions.some((definition) => definition.id === connection.inputId)
    );
  }

  #getActiveAsyncBranchPlan(
    triggerNode: ChartNode,
    activeOutputPortIds: ReadonlySet<PortId>,
  ): ToolCallContinuationAsyncBranchPlan | undefined {
    const plan = this.#asyncBranchPlansByTriggerNodeId.get(triggerNode.id);
    if (!plan || activeOutputPortIds.size === 0) {
      return undefined;
    }

    const outgoingByNodeId = new Map<NodeId, NodeConnection[]>();
    for (const connection of plan.graph.connections) {
      const outgoing = outgoingByNodeId.get(connection.outputNodeId) ?? [];
      outgoing.push(connection);
      outgoingByNodeId.set(connection.outputNodeId, outgoing);
    }

    const activeNodeIds = new Set<NodeId>();
    const pendingNodeIds = (outgoingByNodeId.get(triggerNode.id) ?? [])
      .filter((connection) => activeOutputPortIds.has(connection.outputId))
      .map((connection) => connection.inputNodeId);
    while (pendingNodeIds.length > 0) {
      const nodeId = pendingNodeIds.pop()!;
      if (activeNodeIds.has(nodeId)) {
        continue;
      }
      activeNodeIds.add(nodeId);
      for (const connection of outgoingByNodeId.get(nodeId) ?? []) {
        pendingNodeIds.push(connection.inputNodeId);
      }
    }

    if (activeNodeIds.size === 0) {
      return undefined;
    }

    const triggerInputConnections = plan.graph.connections.filter(
      (connection) => connection.inputNodeId === triggerNode.id,
    );
    const inputAnchorNodeIds = new Set(triggerInputConnections.map((connection) => connection.outputNodeId));
    const includedNodeIds = new Set<NodeId>([triggerNode.id, ...activeNodeIds, ...inputAnchorNodeIds]);
    return {
      nodeIds: activeNodeIds,
      graph: {
        metadata: plan.graph.metadata ? { ...plan.graph.metadata } : undefined,
        nodes: plan.graph.nodes.filter((node) => includedNodeIds.has(node.id)),
        connections: plan.graph.connections.filter(
          (connection) =>
            connection.inputNodeId === triggerNode.id ||
            (activeNodeIds.has(connection.inputNodeId) &&
              (connection.outputNodeId === triggerNode.id || activeNodeIds.has(connection.outputNodeId)) &&
              (connection.outputNodeId !== triggerNode.id || activeOutputPortIds.has(connection.outputId))),
        ),
      },
    };
  }

  #getActiveOutputPortIds(node: ChartNode): ReadonlySet<PortId> {
    if (this.#sameGraphRunOwnerOverride) {
      return this.#sameGraphRunOwnerOverride.#getActiveOutputPortIds(node);
    }

    const outputConnections = getOutputNodesFrom(this.#executionState, node).connectionsToNodes;
    if (outputConnections.length === 0) {
      return new Set();
    }

    const runToRelevantNodeIds = this.#getRunToRelevantNodeIds();
    const activeOutputPortIds = new Set<PortId>();

    for (const { node: outputNode, connections } of outputConnections) {
      if (outputNode.disabled) {
        continue;
      }

      if (runToRelevantNodeIds && !runToRelevantNodeIds.has(outputNode.id)) {
        continue;
      }

      for (const connection of connections) {
        activeOutputPortIds.add(connection.outputId);
      }
    }

    return activeOutputPortIds;
  }

  #assertNoDataBusRunTargets(): void {
    for (const nodeId of this.runToNodeIds ?? []) {
      if (this.#nodesById[nodeId]) {
        continue;
      }

      const effectiveNode = this.#getEffectiveAuthoredNode(nodeId);
      if (isDataBusTopologyNode(effectiveNode)) {
        throw new Error(
          `Cannot run to Data Bus "${effectiveNode.title}". Data Bus channels are compiled topology, not executable nodes.`,
        );
      }
    }
  }

  #getRunToRelevantNodeIds(): Set<NodeId> | undefined {
    if (!this.runToNodeIds) {
      return undefined;
    }

    if (this.#runToRelevantNodeIds) {
      return this.#runToRelevantNodeIds;
    }

    const relevantNodeIds = new Set<NodeId>();
    for (const runToNodeId of this.runToNodeIds) {
      for (const dependencyNodeId of this.getDependencyNodesDeep(runToNodeId)) {
        relevantNodeIds.add(dependencyNodeId);
      }
    }

    this.#runToRelevantNodeIds = relevantNodeIds;
    return relevantNodeIds;
  }

  #emitGraphPartialOutputIfNeeded(node: ChartNode, partialOutputs: Outputs): void {
    if (this.#suppressGraphPartialOutputs) {
      return;
    }
    if (this.#sameGraphRunOwnerOverride) {
      this.#sameGraphRunOwnerOverride.#emitGraphPartialOutputIfNeeded(node, partialOutputs);
      return;
    }

    const { useAsGraphPartialOutput } = (node.data as { useAsGraphPartialOutput?: boolean } | undefined) ?? {};
    if (!(useAsGraphPartialOutput && this.#executor && this.#parent)) {
      return;
    }

    const executorNode = this.#parent.#nodesById[this.#executor.nodeId];
    if (!executorNode) {
      return;
    }

    const parentExecution = this.#parent.#buildExecutionMetadata();

    emitDetached(this.#emitter, 'partialOutput', {
      index: this.#executor.index,
      node: executorNode,
      outputs: partialOutputs,
      processId: this.#executor.processId,
      resultOrigin: 'executed' as const,
      execution: parentExecution,
    });
  }

  #createSubProcessor(
    node: ChartNode,
    index: number,
    processId: ProcessId,
    subGraphId: GraphId | undefined,
    { signal, project }: { signal?: AbortSignal; project?: Project } = {},
  ): GraphProcessor {
    const subprocessorProject = project ?? this.#project;
    const subprocessorGraph = resolveProcessorGraph(subprocessorProject, subGraphId);
    const initialExecutionPlan =
      subprocessorGraph && this.#canUseRuntimeExecutionPlanCacheFor(subprocessorProject, true)
        ? this.#runtimeCache?.executionPlans?.get(subprocessorGraph)
        : undefined;

    const createProfileStart = this.#startRuntimeProfile();
    let processor!: GraphProcessor;
    try {
      processor = new GraphProcessor(subprocessorProject, subGraphId, this.#registry, this.#includeTrace, {
        cacheLoadedProjects: this.#cacheLoadedProjects,
        captureNodeTimings: this.#captureNodeTimings,
        concurrency: this.#concurrency,
        executionPlanCacheMode: this.#executionPlanCacheMode,
        initialExecutionPlan,
        runtimeCache: this.#runtimeCache,
        runtimeProfiler: this.#runtimeProfiler,
        scheduler: this.#scheduler,
      });
    } finally {
      this.#finishRuntimeProfile('createSubProcessor', createProfileStart);
    }

    processor.executor = this.executor;
    processor.#isSubProcessor = true;
    processor.#executionCache = this.#executionCache;
    processor.#externalFunctions = this.#externalFunctions;
    processor.#contextValues = this.#contextValues;
    processor.#parent = this;
    processor.#globals = this.#globals;
    processor.#storedValueController = this.#storedValueController;
    processor.#knowledgeStoreController = this.#knowledgeStoreController;
    processor.#frozenNodeOutputResolver = this.#frozenNodeOutputResolver;
    processor.#executor = {
      nodeId: node.id,
      parentGraphId: this.#graph.metadata!.id!,
      index,
      processId,
    };

    const wireEventsProfileStart = this.#startRuntimeProfile();
    try {
      wireSubprocessorEvents(processor, this.#emitter, {
        isPaused: () => this.#lifecycle.isPaused,
        pause: () => {
          void this.pause();
        },
        resume: () => {
          void this.resume();
        },
      });
    } finally {
      this.#finishRuntimeProfile('wireSubProcessorEvents', wireEventsProfileStart);
    }
    this.#subprocessors.add(processor);

    const wireLifecycleProfileStart = this.#startRuntimeProfile();
    try {
      wireSubprocessorLifecycle(processor, {
        signal,
        parentAbortSignal: this.#abortController.signal,
        onParentPause: (listener) => {
          this.on('pause', listener);
          return () => {
            this.off('pause', listener);
          };
        },
        onParentResume: (listener) => {
          this.on('resume', listener);
          return () => {
            this.off('resume', listener);
          };
        },
      });
    } finally {
      this.#finishRuntimeProfile('wireSubProcessorLifecycle', wireLifecycleProfileStart);
    }

    return processor;
  }

  async #requestUserInput(
    node: ChartNode,
    inputStrings: string[],
    inputValues: Inputs,
    renderingType: 'text' | 'markdown',
    processId: ProcessId,
  ): Promise<StringArrayDataValue> {
    return await new Promise<StringArrayDataValue>((resolve, reject) => {
      const abortListener = () => {
        delete this.#pendingUserInputs[node.id];
        reject(createGraphAbortErrorFromSignal(this.#abortController.signal));
      };

      this.#pendingUserInputs[node.id] = {
        resolve,
        reject,
      };

      this.#abortController.signal.addEventListener('abort', abortListener, { once: true });

      emitDetached(
        this.#emitter,
        'userInput',
        this.#withExecution({
          node,
          inputStrings,
          inputs: inputValues,
          renderingType,
          callback: (results: StringArrayDataValue) => {
            this.#abortController.signal.removeEventListener('abort', abortListener);
            resolve(results);
            delete this.#pendingUserInputs[node.id];
          },
          processId,
        }),
      );
    });
  }

  #excludedDueToControlFlow(
    node: ChartNode,
    inputValues: Inputs,
    processId: ProcessId,
    typeOfExclusion?: ControlFlowExcludedDataValue['value'],
    options: { queueOutputNodes?: boolean } = {},
  ): false | true | ChartNode[] {
    const exclusion = getControlFlowExclusionDecision({ node, inputValues, typeOfExclusion });

    if (exclusion.action === 'continue') {
      return false;
    }

    if (exclusion.action === 'exclude') {
      this.#emitTraceEvent(exclusion.traceMessage);
      return this.#excludeNode(node, processId, inputValues, exclusion.reason, options);
    }

    return true;
  }

  #excludeNode(
    node: ChartNode,
    processId: ProcessId,
    inputValues: Inputs,
    reason: string,
    options: { queueOutputNodes?: boolean } = {},
  ): ChartNode[] {
    const { queueOutputNodes = true } = options;
    const attachedData = this.#getAttachedDataTo(node);
    this.#registerNodeInActiveLoop(node, attachedData);

    this.#visitedNodes.add(node.id);
    this.#markAsExcluded(node, processId, inputValues, reason);
    this.#currentlyProcessing.delete(node.id);
    this.#remainingNodes.delete(node.id);

    const outputNodes = getOutputNodesFrom(this.#executionState, node);
    this.#propagateAttachedDataToOutputNodes(node, attachedData, outputNodes.connectionsToNodes);
    if (queueOutputNodes) {
      this.#queueOutputNodes(node, outputNodes.nodes);
    }

    return outputNodes.nodes;
  }

  #markAsExcluded(node: ChartNode, processId: ProcessId, inputValues: Inputs, reason: string) {
    emitDetached(this.#emitter, 'nodeExcluded', this.#createNodeExcludedEvent(node, processId, inputValues, reason));
  }

  async #emitNodeExcluded(
    node: ChartNode,
    processId: ProcessId,
    inputValues: Inputs,
    reason: string,
    resultOrigin: NodeResultOrigin = 'executed',
  ): Promise<void> {
    await this.#emitter.emit(
      'nodeExcluded',
      this.#createNodeExcludedEvent(node, processId, inputValues, reason, resultOrigin),
    );
  }

  #createNodeExcludedEvent(
    node: ChartNode,
    processId: ProcessId,
    inputValues: Inputs,
    reason: string,
    resultOrigin: NodeResultOrigin = 'executed',
  ) {
    const outputs = createExcludedNodeOutputs(node, this.#definitions[node.id]!.outputs);

    this.#nodeResults.set(node.id, outputs);

    return this.#withExecution({
      node,
      processId,
      inputs: inputValues,
      outputs,
      reason,
      resultOrigin,
    });
  }

  #getInputValuesForNode(node: ChartNode): Inputs {
    const connections = this.#connections[node.id];
    return this.#definitions[node.id]!.inputs.reduce(
      (values, input) => {
        const connection =
          this.#graphExecutionPlan?.inputConnectionByNodeAndPort[node.id]?.[input.id] ??
          connections?.find((conn) => conn.inputId === input.id && conn.inputNodeId === node.id);
        if (connection) {
          const outputNode = this.#nodeInstances[connection.outputNodeId]!.chartNode;
          const outputNodeOutputs = this.#nodeResults.get(outputNode.id);
          const outputResult = outputNodeOutputs?.[connection.outputId];

          values[input.id] = outputResult;
        }
        return values;
      },
      {} as Record<string, any>,
    );
  }

  #getInputConnectionsForNode(node: ChartNode): NodeConnection[] {
    return this.#getEffectiveConnections()
      .filter((connection) => connection.inputNodeId === node.id)
      .map(({ outputNodeId, outputId, inputNodeId, inputId }) => ({
        outputNodeId,
        outputId,
        inputNodeId,
        inputId,
      }));
  }

  get #executionState(): ExecutionState {
    return {
      connections: this.#connections,
      definitions: this.#definitions,
      erroredNodes: this.#erroredNodes,
      executionPlan: this.#graphExecutionPlan,
      loopControllersSeen: this.#loopControllersSeen,
      nodesById: this.#nodesById,
      stronglyConnectedComponents: this.#scc,
      visitedNodes: this.#visitedNodes,
    };
  }
}

import type { DataValue, StringArrayDataValue, ScalarOrArrayDataValue } from './DataValue.js';
import type { NodeId } from './NodeBase.js';
import type { Project, ProjectId } from './Project.js';
import type { ProcessContext, ProcessId, RootRunId, GraphRunId } from './ProcessContext.js';
import type {
  AttachedNodeData,
  GraphProcessor,
  GraphInputs,
  GraphOutputs,
  NodeResults,
  Outputs,
  NodeAbortControllerEntry,
} from './GraphProcessor.js';
import type PQueue from '../utils/pQueueCompat.js';
import type { NodeProcessContextBase } from './ProcessContextBuilder.js';
import type { GraphOutputSelection } from './GraphOutputSelection.js';
import type { RivetStoredValueController } from './StoredValueStore.js';
import type { KnowledgeStoreController } from '../integrations/KnowledgeStoreProvider.js';
import type { ResolvedSubgraphProject } from './SubgraphProjectTarget.js';

/** Invocation-owned fields; GraphProcessor resets them at the established initialization boundaries. */
export class GraphInvocationState {
  rootRunId: RootRunId = undefined!;
  graphRunId: GraphRunId = undefined!;
  parentGraphRunId: GraphRunId | undefined = undefined;
  erroredNodes: Map<NodeId, Error | string> = undefined!; // Values are strings in recordings
  failureOutputsByProcessId: Map<ProcessId, Map<number, Outputs>> = undefined!;
  remainingNodes: Set<NodeId> = undefined!;
  visitedNodes: Set<NodeId> = undefined!;
  currentlyProcessing: Set<NodeId> = undefined!;
  context: ProcessContext = undefined!;
  nodeResults: NodeResults = undefined!;
  abortController: AbortController = undefined!;
  processingQueue: InstanceType<typeof PQueue> = undefined!;
  graphInputs: GraphInputs = undefined!;
  graphOutputs: GraphOutputs = undefined!;
  queuedNodes: Set<NodeId> = undefined!;
  /** Run To quiescence may defer nodes that a later streaming Stop resumes. */
  deferredRunToIgnoredNodes: Set<NodeId> = undefined!;
  loopControllersSeen: Set<NodeId> = undefined!;
  subprocessors: Set<GraphProcessor> = undefined!;
  attachedNodeData: Map<NodeId, AttachedNodeData> = undefined!;
  successfulAbortTerminalProcessIds: Set<ProcessId> = undefined!;
  totalCost: number = 0;
  ignoreNodes: Set<NodeId> = undefined!;
  hasPreloadedData = false;
  loadedProjects: Record<ProjectId, Project> = undefined!;
  nodeProcessContextBase: NodeProcessContextBase = undefined!;
  runToRelevantNodeIds: Set<NodeId> | undefined;
  graphOutputSelection: GraphOutputSelection | undefined;
  nodeAbortControllers = new Map<NodeId, NodeAbortControllerEntry>();
  graphInputNodeValues: Record<string, DataValue> = {};
  /** User input nodes awaiting interactive input for this invocation. */
  pendingUserInputs: Record<NodeId, { resolve: (values: StringArrayDataValue) => void }> = undefined!;

  /** Mutate the owner in place: late child cost/events still address this invocation. */
  initialize(options: {
    preloadedNodeResults: NodeResults;
    remainingNodeIds: Iterable<NodeId>;
    processingQueue: InstanceType<typeof PQueue>;
    createAbortController: () => AbortController;
    loadedProjects: Record<ProjectId, Project>;
    sharedOverride?: Pick<GraphInvocationState, 'graphOutputs' | 'attachedNodeData' | 'graphInputNodeValues'>;
  }): void {
    this.nodeResults = new Map(options.preloadedNodeResults);
    this.visitedNodes = new Set(options.preloadedNodeResults.keys());
    this.hasPreloadedData = options.preloadedNodeResults.size > 0;
    this.erroredNodes = new Map();
    this.failureOutputsByProcessId = new Map();
    this.currentlyProcessing = new Set();
    this.remainingNodes = new Set(options.remainingNodeIds);
    this.pendingUserInputs = {};
    this.processingQueue = options.processingQueue;
    this.graphOutputs = options.sharedOverride?.graphOutputs ?? {};
    this.queuedNodes = new Set();
    this.deferredRunToIgnoredNodes = new Set();
    this.loopControllersSeen = new Set();
    this.subprocessors = new Set();
    this.attachedNodeData = options.sharedOverride?.attachedNodeData ?? new Map();
    this.ignoreNodes = new Set();
    this.nodeProcessContextBase = undefined!;
    this.runToRelevantNodeIds = undefined;
    this.graphOutputSelection = undefined;
    this.abortController = options.createAbortController();
    this.successfulAbortTerminalProcessIds = new Set();
    this.totalCost = 0;
    this.nodeAbortControllers = new Map();
    this.loadedProjects = options.loadedProjects;
    this.graphInputNodeValues = options.sharedOverride?.graphInputNodeValues ?? {};
    // Execution identity, context and inputs are rebound by initializeGraphRun.
  }
}

/** Shared by every child kind; retained caches/globals deliberately keep existing reuse semantics. */
export class GraphSharedExecutionState {
  globals: Map<string, ScalarOrArrayDataValue> = undefined!;
  executionCache: Map<string, unknown> = undefined!;
  storedValueController: RivetStoredValueController = undefined!;
  knowledgeStoreController: KnowledgeStoreController = undefined!;
  subgraphTargetCache = new Map<ProjectId, ResolvedSubgraphProject>();

  nextRootRun(): GraphSharedExecutionState {
    const next = new GraphSharedExecutionState();
    // Latest/Published targets are resolved afresh; old children keep their scope.
    next.globals = this.globals;
    next.executionCache = this.executionCache;
    return next;
  }
}

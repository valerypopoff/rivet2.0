import type { Opaque } from 'type-fest';
import {
  type RuntimeSettings,
  type NativeApi,
  type Project,
  type DataValue,
  type ExternalFunction,
  type Outputs,
  type GraphId,
  type GraphProcessor,
  type ScalarOrArrayDataValue,
  type DatasetProvider,
  type ChartNode,
  type NodeId,
  type PortId,
  type AttachedNodeData,
  type AudioProvider,
  type StringArrayDataValue,
  type ProjectId,
  type MCPProvider,
} from '../index.js';
import type { Tokenizer } from '../integrations/Tokenizer.js';
import type { CodeRunner } from '../integrations/CodeRunner.js';
import type { ProjectReferenceLoader } from './ProjectReferenceLoader.js';
import type { GraphBoundary } from './GraphBoundaryCache.js';
import type { GraphProgress } from './GraphProgress.js';
import type {
  RivetStoredValue,
  RivetStoredValueCacheResult,
  RivetStoredValueReadResult,
  RivetStoredValueSetResult,
} from './StoredValueStore.js';
import type { ToolCallContinuation } from './ToolCallContinuation.js';
import type { KnowledgeStoreConnectionId, RivetKnowledgeStore } from '../integrations/KnowledgeStore.js';
import type { ChatV2Provider } from './chat-v2/chatV2ProviderTypes.js';

export type ChatV2CallId = Opaque<string, 'ChatV2CallId'>;

export type ChatV2CallOutcome = 'success' | 'provider-failure' | 'aborted';

/**
 * Usage fields reported by the provider SDK for one physical Chat V2 call.
 * The observer deliberately copies only usage data and never forwards provider
 * metadata, request data, or authentication.
 */
export type ChatV2CallRawUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    noCacheTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
    textTokens?: number;
  };
};

/**
 * Rivet's provider-neutral names for usage reported by one physical call.
 * Missing provider fields remain absent rather than being represented as zero.
 */
export type ChatV2CallNormalizedUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
};

export type ChatV2CallPricing = {
  status: 'known' | 'unknown';
  costUsd?: number;
};

/**
 * Privacy-bounded accounting event for a single physical Chat V2 provider call.
 */
export type ChatV2CallFinishedEvent = {
  callId: ChatV2CallId;
  /** Zero-based attempt index within this Chat V2 pipeline request. */
  attemptIndex: number;
  /** Zero-based profile index when LLM Chat is using a profile fallback chain. */
  profileIndex?: number;
  /** Zero-based model round within one auto-continued LLM Chat invocation. */
  roundIndex?: number;
  nodeId: NodeId;
  processId: ProcessId;
  provider: ChatV2Provider;
  model: string;
  outcome: ChatV2CallOutcome;
  finishReason?: string;
  rawUsage?: ChatV2CallRawUsage;
  normalizedUsage?: ChatV2CallNormalizedUsage;
  pricing: ChatV2CallPricing;
  /** Epoch milliseconds when the physical provider attempt started. */
  startedAt?: number;
  /** Wall-clock duration of this physical provider attempt. */
  durationMs?: number;
};

export type ChatV2CallFinishedObserver = (event: ChatV2CallFinishedEvent) => void;

/**
 * Portable, privacy-bounded subset of a completed physical Chat V2 call.
 * Provider-shaped raw usage is intentionally retained only by the host observer
 * and cannot enter processor events, recordings, or remote transport.
 */
export type ChatV2CallTraceEvent = Omit<ChatV2CallFinishedEvent, 'rawUsage'>;

export type ToolCallFinishedEvent = {
  toolCallId?: string;
  toolName: string;
  sourceNodeId: NodeId;
  sourceProcessId: ProcessId;
  /**
   * Exact node invocation that owns the persisted tool-result output, when
   * delegation ran through a Delegate Tool Call node. This is intentionally a
   * pointer only: execution traces never copy tool arguments or result text.
   */
  resultOwner?: {
    nodeId: NodeId;
    processId: ProcessId;
    outputPortId: PortId;
  };
  handlerKind: 'graph' | 'external' | 'unknown';
  handlerGraphId?: GraphId;
  handlerName?: string;
  outcome: 'success' | 'passthrough-error' | 'failure' | 'aborted';
  startedAt?: number;
  durationMs?: number;
};

export type ProcessContext = {
  settings: RuntimeSettings;
  nativeApi?: NativeApi;

  /** Sets the dataset provider to be used for all dataset node calls. */
  datasetProvider?: DatasetProvider;

  /** Provider for all MCP node functionality */
  mcpProvider?: MCPProvider;

  /** The provider responsible for being able to play audio. Undefined if unsupported in this context. */
  audioProvider?: AudioProvider;

  /** The tokenizer that will be used for all nodes. */
  tokenizer: Tokenizer;

  /** The provider for running arbitrary code in Code-family nodes. */
  codeRunner?: CodeRunner;

  /** The loader for loading project references. */
  projectReferenceLoader?: ProjectReferenceLoader;

  /** The path to the current project. Required if project references are being used. */
  projectPath?: string;

  /**
   * Optional editor-owned cache that can outlive a single graph run while the app is open.
   * Runtime/library callers normally omit this; editor-only nodes/features can opt into it.
   */
  editorExecutionCache?: Map<string, unknown>;

  /**
   * Host-only accounting hook invoked once after every physical LLM Chat
   * provider attempt. Observer failures are isolated from graph execution.
   */
  onChatV2CallFinished?: ChatV2CallFinishedObserver;

  /**
   * If implemented, chat nodes will first call this to resolve their configured endpoint to a final endpoint.
   * You can use this for adding auth headers, or to load balance between multiple endpoints.
   */
  getChatNodeEndpoint?: (
    configuredEndpoint: string,
    configuredModel: string,
  ) => ChatNodeEndpointInfo | Promise<ChatNodeEndpointInfo>;
};

export type ChatNodeEndpointInfo = {
  endpoint: string;
  headers: Record<string, string>;
};

export type ProcessId = Opaque<string, 'ProcessId'>;

export type RootRunId = Opaque<string, 'RootRunId'>;

export type GraphRunId = Opaque<string, 'GraphRunId'>;

export type SubgraphExecutorMetadata = {
  nodeId: NodeId;
  parentGraphId: GraphId;
  processId: ProcessId;
  splitIndex?: number;
};

export type GraphExecutionMetadata = {
  rootRunId: RootRunId;
  graphRunId: GraphRunId;
  graphId: GraphId;
  parentGraphRunId?: GraphRunId;
  executor?: SubgraphExecutorMetadata;
};

export type InternalProcessContext<T extends ChartNode = ChartNode> = ProcessContext & {
  /** The executor that is running the current processor. */
  executor: 'nodejs' | 'browser';

  /** The project being executed. */
  project: Project;

  /** All referenced (and deep referenced) projects from the current project. */
  referencedProjects: Record<ProjectId, Project>;

  /** A signal that can be used when abort() is called on the GraphProcessor to abort the node's execution. */
  signal: AbortSignal;

  /** A unique ID for this specific execution of the node. */
  processId: ProcessId;

  /** Output ports with at least one active immediate downstream consumer in this graph run. */
  activeOutputPortIds: ReadonlySet<PortId>;

  /**
   * Executes the uniquely connected Delegate Tool Call node for one LLM tool round.
   * Present only for an auto-continuing LLM Chat node with one eligible continuation connection.
   */
  toolCallContinuation?: ToolCallContinuation;

  /** True when this exact node is the direct terminal selected by run-to execution. */
  isDirectRunTarget: boolean;

  /** Stable execution lineage for the current graph invocation. */
  execution: GraphExecutionMetadata;

  /**
   * Marks this invocation's terminal result as an editor-cache replay.
   * Cache-aware node implementations call this only after confirming a hit.
   */
  markResultAsEditorCacheHit?: () => void;

  /** Emits privacy-bounded metadata after a delegated tool execution settles. */
  onToolCallFinished?: (event: ToolCallFinishedEvent) => void;

  /** LLM invocation that owns a connected Delegate Tool Call execution. */
  toolCallTraceSource?: { nodeId: NodeId; processId: ProcessId };

  /** Context values that are accessible on graphs and all subgraphs. */
  contextValues: Record<string, DataValue>;

  /** Inputs that were passed to the curent graph. Used for GraphInputNode. */
  graphInputs: Record<string, DataValue>;

  /** Outputs from the graph. A GraphOutputNode will set these. */
  graphOutputs: Record<string, DataValue>;

  /** Stores the resolved output values of GraphInput nodes during execution, keyed by the node's data.id. */
  graphInputNodeValues: Record<string, DataValue>;

  /** The tokenizer to use to tokenize all strings.s */
  tokenizer: Tokenizer;

  /** The current node being executed. */
  node: T;

  /** For internal and advanced cases, gets the arbitrary data attached to the node during graph execution. */
  attachedData: AttachedNodeData;

  /** Raises a user event that can be listened for on the GraphProcessor. */
  raiseEvent: (eventName: string, data: DataValue | undefined) => void;

  /** Reports sanitized public progress to progress-aware graph hosts. */
  reportProgress: (progress: GraphProgress) => void;

  waitEvent: (eventName: string) => Promise<DataValue | undefined>;

  /** External functions that have been defined on the GraphProcessor (or its parent). */
  externalFunctions: Record<string, ExternalFunction>;

  /** Global cache shared by all nodes, is present for the entire execution of a graph (and shared in subgraphs). */
  executionCache: Map<string, unknown>;

  /** Resolves graph input/output boundary metadata through the processor/runner runtime cache when available. */
  getGraphBoundary?: (project: Project, graphId: GraphId | undefined) => GraphBoundary | undefined;

  /** Call when the node has partial data but has not finished execution yet. */
  onPartialOutputs?: (outputs: Outputs) => void;

  /** Creates a subprocessor, for executing subgraphs. */
  createSubProcessor: (
    subGraphId: GraphId | undefined,
    options?: { signal?: AbortSignal; project?: Project },
  ) => GraphProcessor;

  /** Like context, but variables that are set during the run of the graph and can be read during the graph. Shared among all graphs and subgraphs. */
  getGlobal: (id: string) => ScalarOrArrayDataValue | undefined;

  /** Like context, but variables that are set during the run of the graph and can be read during the graph. Shared among all graphs and subgraphs. */
  setGlobal: (id: string, value: ScalarOrArrayDataValue) => void;

  waitForGlobal: (id: string) => Promise<ScalarOrArrayDataValue>;

  /** Reads through the root run's stored-value cache and optional persistence store. */
  getStoredValue: (key: string) => Promise<RivetStoredValueReadResult>;

  /** Returns only the current root run's synchronous stored-value cache state. */
  getCachedStoredValue: (key: string) => RivetStoredValueCacheResult;

  /** Writes through the root run's cache and optional persistence store. */
  setStoredValue: (key: string, value: RivetStoredValue) => Promise<RivetStoredValueSetResult>;

  /** Waits only for a successful Set Stored Value in this root run. */
  waitForStoredValue: (key: string, signal?: AbortSignal) => Promise<RivetStoredValue>;

  /** Resolves a named project or host-provided knowledge store for this execution. */
  getKnowledgeStore: (connectionId: KnowledgeStoreConnectionId) => Promise<RivetKnowledgeStore>;

  /** Logs to GraphProcessor's trace event. */
  trace: (message: string) => void;

  /** Aborts the current graph, if there is an error, the graph is error aborted, and if undefined, then it is simply early-exited. */
  abortGraph: (error?: Error | string) => void;

  /** Gets a string plugin config value from the settings, falling back to a specified environment variable if set. */
  getPluginConfig(name: string): string | undefined;

  /** Requests that the user input some text in response to the specified prompt. */
  requestUserInput(inputs: string[], renderingType: 'text' | 'markdown'): Promise<StringArrayDataValue>;

  /** The object used for running arbitrary code with Code-family nodes. */
  codeRunner: CodeRunner;
};

import { produce } from 'immer';
import {
  AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS,
  AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS,
  type AgentModelCallTrace,
  type AgentToolCallTrace,
  type ChartNode,
  type GraphExecutionMetadata,
  type GraphId,
  type GraphRunId,
  type NodeGraph,
  type NodeId,
  type PortId,
  type ProcessEvents,
  type ProcessId,
  type ProjectId,
  type GraphProgress,
  type RootRunId,
} from '@valerypopoff/rivet2-core';

export type RunActivityRootStatus = 'running' | 'outputs-ready' | 'completed' | 'error' | 'aborted';
export type RunActivityGraphStatus = 'unknown' | 'running' | 'completed' | 'error' | 'aborted';
export type RunActivityNodeStatus = 'unknown' | 'waiting' | 'running' | 'completed' | 'error' | 'aborted' | 'excluded';
export type RunActivityResultOrigin = 'executed' | 'preloaded' | 'frozen' | 'editor-cache' | 'unknown';

export type RunActivityNodeKey = string & { readonly __runActivityNodeKey: unique symbol };

export type RunActivityModelCall = AgentModelCallTrace & {
  sequence: number;
};

export type RunActivityToolCall = AgentToolCallTrace & {
  sequence: number;
};

export type RunActivityNodeInvocation = {
  key: RunActivityNodeKey;
  sequence: number;
  rootRunId: RootRunId;
  graphRunId: GraphRunId;
  graphId: GraphId;
  nodeId: NodeId;
  processId: ProcessId;
  graphName?: string;
  nodeTitle?: string;
  nodeType?: string;
  status: RunActivityNodeStatus;
  resultOrigin: RunActivityResultOrigin;
  startedAt?: number;
  firstOutputAt?: number;
  latestOutputAt?: number;
  finishedAt?: number;
  durationMs?: number;
  splitRunDurationMs?: Record<number, number>;
  errorSummary?: string;
  terminalEventMissing?: boolean;
  exclusionReason?: string;
  waitingForUserInput?: { questionCount: number; renderingType: 'text' | 'markdown' };
  progress?: GraphProgress;
  inputPortIds: PortId[];
  outputPortIds: PortId[];
  splitOutputPortIds: Record<number, PortId[]>;
  splitOutputIndices: number[];
  partialOutputCount: number;
  outputRevision: number;
  outputsAvailable: boolean;
  outputsClearedAt?: number;
  modelCalls: RunActivityModelCall[];
  toolCalls: RunActivityToolCall[];
  modelCallCount: number;
  toolCallCount: number;
  omittedModelCallCount: number;
  omittedToolCallCount: number;
};

export type RunActivityGraphRun = {
  sequence: number;
  rootRunId: RootRunId;
  graphRunId: GraphRunId;
  graphId: GraphId;
  graphName?: string;
  parentGraphRunId?: GraphRunId;
  executor?: GraphExecutionMetadata['executor'];
  status: RunActivityGraphStatus;
  startedAt?: number;
  finishedAt?: number;
  errorSummary?: string;
  terminalEventMissing?: boolean;
};

export type RunActivityRoot = {
  sequence: number;
  rootRunId: RootRunId;
  rootGraphId?: GraphId;
  rootGraphName?: string;
  projectId?: ProjectId;
  projectTitle?: string;
  status: RunActivityRootStatus;
  startedAt?: number;
  graphOutputsReadyAt?: number;
  finishedAt?: number;
  paused: boolean;
  isPartial: boolean;
  terminalErrorSummary?: string;
  graphRunsById: Record<string, RunActivityGraphRun>;
  graphRunOrder: GraphRunId[];
  nodeInvocationsByKey: Record<string, RunActivityNodeInvocation>;
  nodeInvocationOrder: RunActivityNodeKey[];
  omittedNodeInvocationCount: number;
  omittedLegacyEventCount: number;
};

export type RunActivityJournalLimits = {
  completedRootCount: number;
  nodeInvocationsPerRoot: number;
  modelCallsPerInvocation: number;
  toolCallsPerInvocation: number;
};

export type RunActivityJournal = {
  nextSequence: number;
  rootsById: Record<string, RunActivityRoot>;
  rootOrder: RootRunId[];
  activeRootRunIds: RootRunId[];
  latestCompletedRootRunId?: RootRunId;
  /**
   * Exact root-graph terminal events are followed by an unscoped processor
   * done/error/abort event. Keep their confirmations separate so a terminal
   * event from one concurrent root can never settle another active root.
   */
  pendingUnscopedTerminalConfirmations: number;
  ignoredLegacyEventCount: number;
  limits: RunActivityJournalLimits;
};

type WithOptionalExecution<T> = T extends { execution: infer TExecution }
  ? Omit<T, 'execution'> & { execution?: TExecution }
  : T;

type ProcessEventName =
  | 'start'
  | 'graphStart'
  | 'graphOutputsReady'
  | 'graphFinish'
  | 'graphError'
  | 'graphAbort'
  | 'nodeStart'
  | 'userInput'
  | 'progress'
  | 'partialOutput'
  | 'nodeFinish'
  | 'nodeError'
  | 'nodeExcluded'
  | 'nodeOutputsCleared'
  | 'llmCallFinished'
  | 'toolCallFinished'
  | 'done'
  | 'abort'
  | 'error'
  | 'pause'
  | 'resume';

type RunActivityEventByName = {
  [K in ProcessEventName]: {
    type: K;
    data: WithOptionalExecution<ProcessEvents[K]>;
    /** Supplied by the event boundary so reduction stays deterministic. */
    occurredAt: number;
    resultOrigin?: RunActivityResultOrigin;
  };
};

export type RunActivityEvent = RunActivityEventByName[ProcessEventName];

export const DEFAULT_RUN_ACTIVITY_JOURNAL_LIMITS: RunActivityJournalLimits = {
  completedRootCount: 1,
  nodeInvocationsPerRoot: 2_000,
  modelCallsPerInvocation: AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS,
  toolCallsPerInvocation: AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS,
};

export function createRunActivityJournal(limits: Partial<RunActivityJournalLimits> = {}): RunActivityJournal {
  return {
    nextSequence: 0,
    rootsById: {},
    rootOrder: [],
    activeRootRunIds: [],
    pendingUnscopedTerminalConfirmations: 0,
    ignoredLegacyEventCount: 0,
    limits: normalizeLimits(limits),
  };
}

/**
 * Selects the root run that represents the editor's current activity surface.
 * A newer active run wins; once no run is active, the newest completed run is
 * retained. Keep this policy outside the drawer so compact runtime surfaces
 * and the full activity view cannot disagree about which run they describe.
 */
export function selectCurrentRunActivityRoot(journal: RunActivityJournal): RunActivityRoot | undefined {
  const newestActive = journal.activeRootRunIds
    .map((rootRunId) => journal.rootsById[rootRunId])
    .filter((root): root is RunActivityRoot => root != null)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);

  if (newestActive) return newestActive;
  if (journal.latestCompletedRootRunId != null) return journal.rootsById[journal.latestCompletedRootRunId];
  return undefined;
}

export function reduceRunActivityJournal(journal: RunActivityJournal, event: RunActivityEvent): RunActivityJournal {
  return produce(journal, (draft) => {
    applyEvent(draft, event, event.occurredAt);
  });
}

export function reduceRunActivityEvents(
  journal: RunActivityJournal,
  events: readonly RunActivityEvent[],
): RunActivityJournal {
  return events.reduce(reduceRunActivityJournal, journal);
}

export function createRunActivityNodeKey(identity: {
  rootRunId: RootRunId;
  graphRunId: GraphRunId;
  nodeId: NodeId;
  processId: ProcessId;
}): RunActivityNodeKey {
  return JSON.stringify([
    identity.rootRunId,
    identity.graphRunId,
    identity.nodeId,
    identity.processId,
  ]) as RunActivityNodeKey;
}

function applyEvent(journal: RunActivityJournal, event: RunActivityEvent, occurredAt: number): void {
  switch (event.type) {
    case 'start':
      applyStart(journal, event.data, occurredAt);
      return;
    case 'graphStart':
      applyGraphStart(journal, event.data, occurredAt);
      return;
    case 'graphOutputsReady':
      applyGraphOutputsReady(journal, event.data, occurredAt);
      return;
    case 'graphFinish':
      applyGraphTerminal(journal, event.data, occurredAt, 'completed');
      return;
    case 'graphError':
      applyGraphTerminal(journal, event.data, occurredAt, 'error');
      return;
    case 'graphAbort':
      applyGraphTerminal(journal, event.data, occurredAt, 'aborted');
      return;
    case 'nodeStart':
      applyNodeStart(journal, event.data, occurredAt, event.resultOrigin);
      return;
    case 'userInput':
      applyUserInput(journal, event.data, occurredAt);
      return;
    case 'progress':
      applyProgress(journal, event.data, occurredAt);
      return;
    case 'partialOutput':
      applyPartialOutput(journal, event.data, occurredAt, event.resultOrigin);
      return;
    case 'nodeFinish':
      applyNodeFinish(journal, event.data, occurredAt, event.resultOrigin);
      return;
    case 'nodeError':
      applyNodeError(journal, event.data, occurredAt, event.resultOrigin);
      return;
    case 'nodeExcluded':
      applyNodeExcluded(journal, event.data, occurredAt, event.resultOrigin);
      return;
    case 'nodeOutputsCleared':
      applyNodeOutputsCleared(journal, event.data, occurredAt);
      return;
    case 'llmCallFinished':
      applyLlmCallFinished(journal, event.data, occurredAt);
      return;
    case 'toolCallFinished':
      applyToolCallFinished(journal, event.data, occurredAt);
      return;
    case 'done':
      applyUnscopedRootTerminal(journal, 'completed', occurredAt);
      return;
    case 'abort':
      applyUnscopedRootTerminal(journal, 'aborted', occurredAt, event.data?.error);
      return;
    case 'error':
      applyUnscopedRootTerminal(journal, 'error', occurredAt, event.data?.error);
      return;
    case 'pause':
      applyUnscopedPause(journal, true);
      return;
    case 'resume':
      applyUnscopedPause(journal, false);
      return;
  }
}

function applyStart(journal: RunActivityJournal, data: RunActivityEventByName['start']['data'], at: number): void {
  const execution = getExactExecution(journal, 'start', data.execution);
  if (execution == null) return;

  const root = ensureRoot(journal, execution, at, data.startGraph, false);
  root.projectId = data.project.metadata.id;
  root.projectTitle = data.project.metadata.title;
  root.rootGraphId = data.startGraph.metadata?.id ?? execution.graphId;
  root.rootGraphName = data.startGraph.metadata?.name ?? root.rootGraphName;
  root.startedAt = minDefined(root.startedAt, at);
  root.isPartial = false;

  // Transport/replay delivery can surface a duplicate start after the exact
  // root terminal event. Enrich the already-recorded root, but never reopen
  // it: that would make a completed run look live without adding it back to
  // the active-root index.
  if (isTerminalRootStatus(root.status)) return;
}

function applyGraphStart(
  journal: RunActivityJournal,
  data: RunActivityEventByName['graphStart']['data'],
  at: number,
): void {
  const execution = getExactExecution(journal, 'graphStart', data.execution);
  if (execution == null) return;

  const root = ensureRoot(journal, execution, at, data.graph);
  const graph = ensureGraphRun(journal, root, execution, data.graph, at);
  if (isTerminalRootStatus(root.status)) {
    markGraphRunTerminalFromRoot(root, graph);
    return;
  }
  if (isTerminalGraphStatus(graph.status) || graph.terminalEventMissing) return;
  graph.status = 'running';
  graph.startedAt = minDefined(graph.startedAt, at);
}

function applyGraphOutputsReady(
  journal: RunActivityJournal,
  data: RunActivityEventByName['graphOutputsReady']['data'],
  at: number,
): void {
  const execution = getExactExecution(journal, 'graphOutputsReady', data.execution);
  if (execution == null) return;

  const root = ensureRoot(journal, execution, at, data.graph);
  const graph = ensureGraphRun(journal, root, execution, data.graph, at);
  if (isTerminalRootStatus(root.status)) {
    markGraphRunTerminalFromRoot(root, graph);
    return;
  }
  if (execution.parentGraphRunId == null) {
    root.graphOutputsReadyAt ??= at;
    if (!isTerminalRootStatus(root.status)) root.status = 'outputs-ready';
  }
}

function applyGraphTerminal(
  journal: RunActivityJournal,
  data:
    | RunActivityEventByName['graphFinish']['data']
    | RunActivityEventByName['graphError']['data']
    | RunActivityEventByName['graphAbort']['data'],
  at: number,
  status: 'completed' | 'error' | 'aborted',
): void {
  const execution = getExactExecution(journal, `graph-${status}`, data.execution);
  if (execution == null) return;

  const root = ensureRoot(journal, execution, at, data.graph);
  const graph = ensureGraphRun(journal, root, execution, data.graph, at);
  graph.status = status;
  graph.finishedAt = at;
  graph.terminalEventMissing = undefined;
  const error = 'error' in data ? data.error : undefined;
  if (error != null) graph.errorSummary = serializeErrorMessage(error);

  if (execution.parentGraphRunId == null) {
    const wasTerminal = isTerminalRootStatus(root.status);
    finishRoot(journal, root, status, at, error);
    if (!wasTerminal) {
      journal.pendingUnscopedTerminalConfirmations = (journal.pendingUnscopedTerminalConfirmations ?? 0) + 1;
    }
  }
}

function applyNodeStart(
  journal: RunActivityJournal,
  data: RunActivityEventByName['nodeStart']['data'],
  at: number,
  resultOrigin: RunActivityResultOrigin | undefined,
): void {
  const invocation = getOrCreateNodeInvocation(journal, 'nodeStart', data, at, resultOrigin);
  if (invocation == null) return;

  if (isTerminalNodeStatus(invocation.status) || invocation.terminalEventMissing) return;
  invocation.status = 'running';
  invocation.startedAt = minDefined(invocation.startedAt, at);
  invocation.inputPortIds = mergePortIds(invocation.inputPortIds, Object.keys(data.inputs) as PortId[]);
  invocation.waitingForUserInput = undefined;
}

function applyUserInput(
  journal: RunActivityJournal,
  data: RunActivityEventByName['userInput']['data'],
  at: number,
): void {
  const invocation = getOrCreateNodeInvocation(journal, 'userInput', data, at, 'executed');
  if (invocation == null) return;
  if (isTerminalNodeStatus(invocation.status) || invocation.terminalEventMissing) return;

  invocation.status = 'waiting';
  invocation.startedAt = minDefined(invocation.startedAt, at);
  invocation.inputPortIds = mergePortIds(invocation.inputPortIds, Object.keys(data.inputs) as PortId[]);
  invocation.waitingForUserInput = {
    questionCount: data.inputStrings.length,
    renderingType: data.renderingType,
  };
}

function applyProgress(
  journal: RunActivityJournal,
  data: RunActivityEventByName['progress']['data'],
  at: number,
): void {
  const invocation = getOrCreateNodeInvocation(journal, 'progress', data, at, 'executed');
  if (invocation == null) return;

  if (isTerminalNodeStatus(invocation.status) || invocation.terminalEventMissing) return;
  invocation.status = invocation.status === 'unknown' ? 'running' : invocation.status;
  invocation.startedAt = minDefined(invocation.startedAt, at);
  invocation.progress = data.progress;
}

function applyPartialOutput(
  journal: RunActivityJournal,
  data: RunActivityEventByName['partialOutput']['data'],
  at: number,
  resultOrigin: RunActivityResultOrigin | undefined,
): void {
  const invocation = getOrCreateNodeInvocation(journal, 'partialOutput', data, at, resultOrigin);
  if (invocation == null) return;

  if (invocation.status === 'unknown') invocation.status = 'running';
  invocation.firstOutputAt ??= at;
  invocation.latestOutputAt = at;
  invocation.partialOutputCount += 1;
  invocation.outputRevision += 1;
  invocation.outputsAvailable = true;
  invocation.outputsClearedAt = undefined;

  const outputPortIds = Object.keys(data.outputs) as PortId[];
  if (data.node.isSplitRun) {
    invocation.splitOutputPortIds[data.index] = mergePortIds(
      invocation.splitOutputPortIds[data.index] ?? [],
      outputPortIds,
    );
    if (!invocation.splitOutputIndices.includes(data.index)) {
      invocation.splitOutputIndices.push(data.index);
      invocation.splitOutputIndices.sort((a, b) => a - b);
    }
  } else {
    invocation.outputPortIds = mergePortIds(invocation.outputPortIds, outputPortIds);
  }
}

function applyNodeFinish(
  journal: RunActivityJournal,
  data: RunActivityEventByName['nodeFinish']['data'],
  at: number,
  resultOrigin: RunActivityResultOrigin | undefined,
): void {
  const invocation = getOrCreateNodeInvocation(journal, 'nodeFinish', data, at, resultOrigin);
  if (invocation == null) return;

  invocation.status = 'completed';
  invocation.waitingForUserInput = undefined;
  invocation.finishedAt = at;
  invocation.terminalEventMissing = undefined;
  invocation.durationMs = normalizeDuration(data.durationMs, invocation.startedAt, at);
  invocation.splitRunDurationMs = data.splitRunDurationMs;
  invocation.latestOutputAt = at;
  invocation.firstOutputAt ??= at;
  invocation.outputRevision += 1;
  invocation.outputsAvailable = true;
  invocation.outputsClearedAt = undefined;
  invocation.outputPortIds = mergePortIds(invocation.outputPortIds, Object.keys(data.outputs) as PortId[]);
}

function applyNodeError(
  journal: RunActivityJournal,
  data: RunActivityEventByName['nodeError']['data'],
  at: number,
  resultOrigin: RunActivityResultOrigin | undefined,
): void {
  const invocation = getOrCreateNodeInvocation(journal, 'nodeError', data, at, resultOrigin);
  if (invocation == null) return;

  invocation.status = 'error';
  invocation.waitingForUserInput = undefined;
  invocation.finishedAt = at;
  invocation.terminalEventMissing = undefined;
  invocation.durationMs = normalizeDuration(data.durationMs, invocation.startedAt, at);
  invocation.splitRunDurationMs = data.splitRunDurationMs;
  invocation.errorSummary = serializeErrorMessage(data.error);
}

function applyNodeExcluded(
  journal: RunActivityJournal,
  data: RunActivityEventByName['nodeExcluded']['data'],
  at: number,
  resultOrigin: RunActivityResultOrigin | undefined,
): void {
  const invocation = getOrCreateNodeInvocation(journal, 'nodeExcluded', data, at, resultOrigin);
  if (invocation == null) return;

  invocation.status = 'excluded';
  invocation.waitingForUserInput = undefined;
  invocation.startedAt ??= at;
  invocation.finishedAt = at;
  invocation.terminalEventMissing = undefined;
  invocation.exclusionReason = data.reason;
  invocation.inputPortIds = mergePortIds(invocation.inputPortIds, Object.keys(data.inputs) as PortId[]);
  invocation.outputPortIds = mergePortIds(invocation.outputPortIds, Object.keys(data.outputs) as PortId[]);
  invocation.outputsAvailable = true;
  invocation.outputRevision += 1;
}

function applyNodeOutputsCleared(
  journal: RunActivityJournal,
  data: RunActivityEventByName['nodeOutputsCleared']['data'],
  at: number,
): void {
  const execution = getExactExecution(journal, 'nodeOutputsCleared', data.execution);
  if (execution == null) return;

  const root = journal.rootsById[execution.rootRunId];
  if (root == null) return;

  for (const key of root.nodeInvocationOrder) {
    const invocation = root.nodeInvocationsByKey[key];
    if (
      invocation == null ||
      invocation.graphRunId !== execution.graphRunId ||
      invocation.nodeId !== data.node.id ||
      (data.processId != null && invocation.processId !== data.processId)
    ) {
      continue;
    }

    invocation.outputsAvailable = false;
    invocation.outputsClearedAt = at;
    invocation.outputRevision += 1;
  }
}

function applyLlmCallFinished(
  journal: RunActivityJournal,
  data: RunActivityEventByName['llmCallFinished']['data'],
  at: number,
): void {
  const invocation = getOrCreateTraceInvocation(
    journal,
    'llmCallFinished',
    data.execution,
    data.nodeId,
    data.processId,
    data.startedAt ?? at,
  );
  if (invocation == null) return;

  invocation.modelCallCount += 1;
  const existingIndex = invocation.modelCalls.findIndex((call) => call.callId === data.callId);
  const call: RunActivityModelCall = {
    callId: data.callId,
    nodeId: data.nodeId,
    processId: data.processId,
    provider: data.provider,
    model: data.model,
    outcome: data.outcome,
    attemptIndex: data.attemptIndex,
    pricing: data.pricing,
    ...(data.profileIndex == null ? {} : { profileIndex: data.profileIndex }),
    ...(data.roundIndex == null ? {} : { roundIndex: data.roundIndex }),
    ...(data.startedAt == null ? {} : { startedAt: data.startedAt }),
    ...(data.durationMs == null ? {} : { durationMs: data.durationMs }),
    ...(data.finishReason == null ? {} : { finishReason: data.finishReason }),
    ...(data.normalizedUsage == null ? {} : { usage: data.normalizedUsage }),
    sequence: existingIndex < 0 ? takeSequence(journal) : invocation.modelCalls[existingIndex]!.sequence,
  };

  if (existingIndex >= 0) {
    invocation.modelCallCount -= 1;
    invocation.modelCalls[existingIndex] = call;
    return;
  }

  if (invocation.modelCalls.length < journal.limits.modelCallsPerInvocation) {
    invocation.modelCalls.push(call);
  } else {
    invocation.omittedModelCallCount += 1;
  }
}

function applyToolCallFinished(
  journal: RunActivityJournal,
  data: RunActivityEventByName['toolCallFinished']['data'],
  at: number,
): void {
  const invocation = getOrCreateTraceInvocation(
    journal,
    'toolCallFinished',
    data.execution,
    data.sourceNodeId,
    data.sourceProcessId,
    data.startedAt ?? at,
  );
  if (invocation == null) return;

  const existingIndex =
    data.toolCallId == null ? -1 : invocation.toolCalls.findIndex((call) => call.toolCallId === data.toolCallId);
  const existingCall = existingIndex < 0 ? undefined : invocation.toolCalls[existingIndex];
  const resultOwner =
    data.outcome === 'success' || data.outcome === 'passthrough-error'
      ? data.resultOwner ?? existingCall?.resultOwner
      : undefined;
  const call: RunActivityToolCall = {
    ...(data.toolCallId == null ? {} : { toolCallId: data.toolCallId }),
    toolName: data.toolName,
    sourceNodeId: data.sourceNodeId,
    sourceProcessId: data.sourceProcessId,
    ...(resultOwner == null ? {} : { resultOwner }),
    handlerKind: data.handlerKind,
    ...(data.handlerGraphId == null ? {} : { handlerGraphId: data.handlerGraphId }),
    ...(data.handlerName == null ? {} : { handlerName: data.handlerName }),
    outcome: data.outcome,
    ...(data.startedAt == null ? {} : { startedAt: data.startedAt }),
    ...(data.durationMs == null ? {} : { durationMs: data.durationMs }),
    sequence: existingIndex < 0 ? takeSequence(journal) : existingCall!.sequence,
  };

  if (existingIndex >= 0) {
    invocation.toolCalls[existingIndex] = call;
    return;
  }

  invocation.toolCallCount += 1;
  if (invocation.toolCalls.length < journal.limits.toolCallsPerInvocation) {
    invocation.toolCalls.push(call);
  } else {
    invocation.omittedToolCallCount += 1;
  }
}

function getOrCreateNodeInvocation(
  journal: RunActivityJournal,
  eventType: string,
  data: {
    execution?: GraphExecutionMetadata;
    node: ChartNode;
    processId: ProcessId;
  },
  at: number,
  resultOrigin: RunActivityResultOrigin | undefined,
): RunActivityNodeInvocation | undefined {
  const execution = getExactExecution(journal, eventType, data.execution);
  if (execution == null) return undefined;

  const root = ensureRoot(journal, execution, at);
  const graph = ensureGraphRun(journal, root, execution, undefined, at);
  const invocation = ensureNodeInvocation(journal, root, execution, data.node.id, data.processId, at);
  if (invocation == null) return undefined;

  markGraphRunTerminalFromRoot(root, graph);
  markNodeInvocationTerminalFromRoot(root, invocation);

  invocation.graphName = graph.graphName ?? invocation.graphName;
  invocation.nodeTitle = data.node.title;
  invocation.nodeType = data.node.type;
  invocation.resultOrigin = resultOrigin ?? invocation.resultOrigin;
  return invocation;
}

function getOrCreateTraceInvocation(
  journal: RunActivityJournal,
  eventType: string,
  execution: GraphExecutionMetadata | undefined,
  nodeId: NodeId,
  processId: ProcessId,
  at: number,
): RunActivityNodeInvocation | undefined {
  const exactExecution = getExactExecution(journal, eventType, execution);
  if (exactExecution == null) return undefined;

  const root = ensureRoot(journal, exactExecution, at);
  const graph = ensureGraphRun(journal, root, exactExecution, undefined, at);
  const invocation = ensureNodeInvocation(journal, root, exactExecution, nodeId, processId, at);
  if (invocation == null) return undefined;

  markGraphRunTerminalFromRoot(root, graph);
  markNodeInvocationTerminalFromRoot(root, invocation);
  return invocation;
}

function ensureRoot(
  journal: RunActivityJournal,
  execution: GraphExecutionMetadata,
  at: number,
  graph?: NodeGraph,
  isPartial = true,
): RunActivityRoot {
  let root = journal.rootsById[execution.rootRunId];
  if (root != null) {
    if (execution.parentGraphRunId == null) {
      root.rootGraphId = execution.graphId;
      root.rootGraphName = graph?.metadata?.name ?? root.rootGraphName;
    }
    return root;
  }

  root = {
    sequence: takeSequence(journal),
    rootRunId: execution.rootRunId,
    rootGraphId: execution.parentGraphRunId == null ? execution.graphId : undefined,
    rootGraphName: execution.parentGraphRunId == null ? graph?.metadata?.name : undefined,
    status: 'running',
    startedAt: at,
    paused: false,
    isPartial,
    graphRunsById: {},
    graphRunOrder: [],
    nodeInvocationsByKey: {},
    nodeInvocationOrder: [],
    omittedNodeInvocationCount: 0,
    omittedLegacyEventCount: 0,
  };
  journal.rootsById[execution.rootRunId] = root;
  journal.rootOrder.push(execution.rootRunId);
  addActiveRoot(journal, execution.rootRunId);
  return root;
}

function ensureGraphRun(
  journal: RunActivityJournal,
  root: RunActivityRoot,
  execution: GraphExecutionMetadata,
  graph: NodeGraph | undefined,
  at: number,
): RunActivityGraphRun {
  let graphRun = root.graphRunsById[execution.graphRunId];
  if (graphRun == null) {
    graphRun = {
      sequence: takeSequence(journal),
      rootRunId: execution.rootRunId,
      graphRunId: execution.graphRunId,
      graphId: execution.graphId,
      graphName: graph?.metadata?.name,
      parentGraphRunId: execution.parentGraphRunId,
      executor: execution.executor,
      status: 'running',
      startedAt: at,
    };
    root.graphRunsById[execution.graphRunId] = graphRun;
    root.graphRunOrder.push(execution.graphRunId);
  } else {
    graphRun.graphName = graph?.metadata?.name ?? graphRun.graphName;
    graphRun.parentGraphRunId = execution.parentGraphRunId ?? graphRun.parentGraphRunId;
    graphRun.executor = execution.executor ?? graphRun.executor;
    graphRun.startedAt = minDefined(graphRun.startedAt, at);
  }

  return graphRun;
}

function ensureNodeInvocation(
  journal: RunActivityJournal,
  root: RunActivityRoot,
  execution: GraphExecutionMetadata,
  nodeId: NodeId,
  processId: ProcessId,
  at: number,
): RunActivityNodeInvocation | undefined {
  const key = createRunActivityNodeKey({
    rootRunId: execution.rootRunId,
    graphRunId: execution.graphRunId,
    nodeId,
    processId,
  });
  let invocation = root.nodeInvocationsByKey[key];
  if (invocation != null) return invocation;

  if (root.nodeInvocationOrder.length >= journal.limits.nodeInvocationsPerRoot) {
    root.omittedNodeInvocationCount += 1;
    return undefined;
  }

  invocation = {
    key,
    sequence: takeSequence(journal),
    rootRunId: execution.rootRunId,
    graphRunId: execution.graphRunId,
    graphId: execution.graphId,
    nodeId,
    processId,
    graphName: root.graphRunsById[execution.graphRunId]?.graphName,
    status: 'unknown',
    resultOrigin: 'unknown',
    startedAt: at,
    inputPortIds: [],
    outputPortIds: [],
    splitOutputPortIds: {},
    splitOutputIndices: [],
    partialOutputCount: 0,
    outputRevision: 0,
    outputsAvailable: false,
    modelCalls: [],
    toolCalls: [],
    modelCallCount: 0,
    toolCallCount: 0,
    omittedModelCallCount: 0,
    omittedToolCallCount: 0,
  };
  root.nodeInvocationsByKey[key] = invocation;
  root.nodeInvocationOrder.push(key);
  return invocation;
}

function finishRoot(
  journal: RunActivityJournal,
  root: RunActivityRoot,
  status: Exclude<RunActivityRootStatus, 'running' | 'outputs-ready'>,
  at: number,
  error?: unknown,
): void {
  root.status = status;
  root.finishedAt = at;
  root.paused = false;
  if (error != null) root.terminalErrorSummary = serializeErrorMessage(error);

  for (const graphRunId of root.graphRunOrder) {
    const graphRun = root.graphRunsById[graphRunId];
    if (graphRun == null || graphRun.status !== 'running') continue;
    graphRun.status = status === 'completed' ? 'unknown' : 'aborted';
    graphRun.finishedAt = at;
    graphRun.terminalEventMissing = true;
  }
  for (const key of root.nodeInvocationOrder) {
    const invocation = root.nodeInvocationsByKey[key];
    if (invocation == null || (invocation.status !== 'running' && invocation.status !== 'unknown')) continue;
    invocation.status = status === 'completed' ? 'unknown' : 'aborted';
    invocation.finishedAt = at;
    invocation.durationMs = normalizeDuration(invocation.durationMs, invocation.startedAt, at);
    invocation.terminalEventMissing = true;
  }

  journal.activeRootRunIds = journal.activeRootRunIds.filter((rootRunId) => rootRunId !== root.rootRunId);
  journal.latestCompletedRootRunId = root.rootRunId;
  pruneCompletedRoots(journal);
}

/**
 * A root terminal event may arrive before a delayed child graph event. Keep
 * that late graph visible, but mark it as terminally incomplete instead of
 * incorrectly presenting it as still running.
 */
function markGraphRunTerminalFromRoot(root: RunActivityRoot, graphRun: RunActivityGraphRun): void {
  if (!isTerminalRootStatus(root.status) || isTerminalGraphStatus(graphRun.status) || graphRun.terminalEventMissing) {
    return;
  }

  graphRun.status = root.status === 'completed' ? 'unknown' : 'aborted';
  graphRun.finishedAt = root.finishedAt ?? graphRun.finishedAt;
  graphRun.terminalEventMissing = true;
}

/**
 * Late node starts, waits, and progress updates must not resurrect an
 * invocation that the root already closed. A later exact node terminal event
 * is still allowed to replace this conservative missing-terminal marker.
 */
function markNodeInvocationTerminalFromRoot(root: RunActivityRoot, invocation: RunActivityNodeInvocation): void {
  if (
    !isTerminalRootStatus(root.status) ||
    isTerminalNodeStatus(invocation.status) ||
    invocation.terminalEventMissing
  ) {
    return;
  }

  invocation.status = root.status === 'completed' ? 'unknown' : 'aborted';
  const finishedAt = root.finishedAt ?? invocation.finishedAt;
  invocation.finishedAt = finishedAt;
  if (finishedAt != null) {
    invocation.durationMs = normalizeDuration(invocation.durationMs, invocation.startedAt, finishedAt);
  }
  invocation.terminalEventMissing = true;
}

function applyUnscopedRootTerminal(
  journal: RunActivityJournal,
  status: Exclude<RunActivityRootStatus, 'running' | 'outputs-ready'>,
  at: number,
  error?: unknown,
): void {
  if ((journal.pendingUnscopedTerminalConfirmations ?? 0) > 0) {
    journal.pendingUnscopedTerminalConfirmations -= 1;
    return;
  }

  const root = getSingleActiveRoot(journal);
  if (root == null) {
    noteLegacyEvent(journal);
    return;
  }
  finishRoot(journal, root, status, at, error);
}

function applyUnscopedPause(journal: RunActivityJournal, paused: boolean): void {
  const root = getSingleActiveRoot(journal);
  if (root == null) {
    noteLegacyEvent(journal);
    return;
  }
  root.paused = paused;
}

function getExactExecution(
  journal: RunActivityJournal,
  _eventType: string,
  execution: GraphExecutionMetadata | undefined,
): GraphExecutionMetadata | undefined {
  if (
    execution == null ||
    !isNonEmptyString(execution.rootRunId) ||
    !isNonEmptyString(execution.graphRunId) ||
    !isNonEmptyString(execution.graphId)
  ) {
    noteLegacyEvent(journal);
    return undefined;
  }
  return execution;
}

function noteLegacyEvent(journal: RunActivityJournal): void {
  const root = getSingleActiveRoot(journal);
  if (root == null) journal.ignoredLegacyEventCount += 1;
  else root.omittedLegacyEventCount += 1;
}

function getSingleActiveRoot(journal: RunActivityJournal): RunActivityRoot | undefined {
  if (journal.activeRootRunIds.length !== 1) return undefined;
  return journal.rootsById[journal.activeRootRunIds[0]!];
}

function addActiveRoot(journal: RunActivityJournal, rootRunId: RootRunId): void {
  if (!journal.activeRootRunIds.includes(rootRunId)) journal.activeRootRunIds.push(rootRunId);
}

function pruneCompletedRoots(journal: RunActivityJournal): void {
  const completedRoots = journal.rootOrder.filter((rootRunId) => {
    const root = journal.rootsById[rootRunId];
    return root != null && isTerminalRootStatus(root.status);
  });
  const rootsToRemove = completedRoots.slice(0, Math.max(0, completedRoots.length - journal.limits.completedRootCount));
  if (rootsToRemove.length === 0) return;

  const rootsToRemoveSet = new Set(rootsToRemove);
  for (const rootRunId of rootsToRemove) delete journal.rootsById[rootRunId];
  journal.rootOrder = journal.rootOrder.filter((rootRunId) => !rootsToRemoveSet.has(rootRunId));
  if (journal.latestCompletedRootRunId != null && journal.rootsById[journal.latestCompletedRootRunId] == null) {
    journal.latestCompletedRootRunId = [...journal.rootOrder]
      .reverse()
      .find((rootRunId) => isTerminalRootStatus(journal.rootsById[rootRunId]!.status));
  }
}

function normalizeLimits(limits: Partial<RunActivityJournalLimits>): RunActivityJournalLimits {
  return {
    completedRootCount: normalizeLimit(
      limits.completedRootCount,
      DEFAULT_RUN_ACTIVITY_JOURNAL_LIMITS.completedRootCount,
    ),
    nodeInvocationsPerRoot: normalizeLimit(
      limits.nodeInvocationsPerRoot,
      DEFAULT_RUN_ACTIVITY_JOURNAL_LIMITS.nodeInvocationsPerRoot,
    ),
    modelCallsPerInvocation: normalizeLimit(
      limits.modelCallsPerInvocation,
      DEFAULT_RUN_ACTIVITY_JOURNAL_LIMITS.modelCallsPerInvocation,
    ),
    toolCallsPerInvocation: normalizeLimit(
      limits.toolCallsPerInvocation,
      DEFAULT_RUN_ACTIVITY_JOURNAL_LIMITS.toolCallsPerInvocation,
    ),
  };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return value == null || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

function takeSequence(journal: RunActivityJournal): number {
  const sequence = journal.nextSequence;
  journal.nextSequence += 1;
  return sequence;
}

function mergePortIds(current: PortId[], incoming: PortId[]): PortId[] {
  if (incoming.length === 0) return current;
  const seen = new Set(current);
  const next = [...current];
  for (const portId of incoming) {
    if (seen.has(portId)) continue;
    seen.add(portId);
    next.push(portId);
  }
  return next;
}

function serializeErrorMessage(error: unknown): string {
  // `errorSummary` is a historic field name. Unlike ordinary output previews,
  // failure diagnostics must remain complete so the expanded activity row can
  // be used to diagnose the original provider or runtime failure.
  return error instanceof Error ? error.message : String(error);
}

function normalizeDuration(
  durationMs: number | undefined,
  startedAt: number | undefined,
  finishedAt: number,
): number | undefined {
  if (durationMs != null && Number.isFinite(durationMs)) return Math.max(0, durationMs);
  return startedAt == null ? undefined : Math.max(0, finishedAt - startedAt);
}

function minDefined(current: number | undefined, candidate: number): number {
  return current == null ? candidate : Math.min(current, candidate);
}

function isTerminalRootStatus(status: RunActivityRootStatus): boolean {
  return status === 'completed' || status === 'error' || status === 'aborted';
}

function isTerminalGraphStatus(status: RunActivityGraphStatus): boolean {
  return status === 'completed' || status === 'error' || status === 'aborted';
}

function isTerminalNodeStatus(status: RunActivityNodeStatus): boolean {
  return status === 'completed' || status === 'error' || status === 'aborted' || status === 'excluded';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

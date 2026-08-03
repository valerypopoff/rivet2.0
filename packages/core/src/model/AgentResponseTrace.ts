import type {
  ChatV2CallTraceEvent,
  GraphExecutionMetadata,
  GraphRunId,
  ProcessId,
  RootRunId,
  ToolCallFinishedEvent,
} from './ProcessContext.js';
import type { GraphId } from './NodeGraph.js';
import type { NodeId } from './NodeBase.js';
import type { GraphProcessor } from './GraphProcessor.js';

export const AGENT_RESPONSE_TRACE_SCHEMA_VERSION = 1 as const;
export const AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS = 250;
export const AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS = 500;

export type AgentModelCallTrace = {
  callId: string;
  nodeId: NodeId;
  processId: ProcessId;
  provider: string;
  model: string;
  outcome: ChatV2CallTraceEvent['outcome'];
  attemptIndex: number;
  profileIndex?: number;
  roundIndex?: number;
  startedAt?: number;
  durationMs?: number;
  finishReason?: string;
  usage?: ChatV2CallTraceEvent['normalizedUsage'];
  pricing: ChatV2CallTraceEvent['pricing'];
};

export type AgentToolCallTrace = {
  toolCallId?: string;
  toolName: string;
  sourceNodeId: NodeId;
  sourceProcessId: ProcessId;
  /** Pointer to the pre-existing Delegate Tool Call output, never copied result text. */
  resultOwner?: ToolCallFinishedEvent['resultOwner'];
  handlerKind: ToolCallFinishedEvent['handlerKind'];
  handlerGraphId?: GraphId;
  handlerName?: string;
  outcome: ToolCallFinishedEvent['outcome'];
  startedAt?: number;
  durationMs?: number;
};

export type AgentResponseTrace = {
  schemaVersion: typeof AGENT_RESPONSE_TRACE_SCHEMA_VERSION;
  traceId: RootRunId;
  scope: 'response' | 'llm-invocation';
  rootRunId: RootRunId;
  graphRunId: GraphRunId;
  graphId: GraphId;
  nodeId?: NodeId;
  processId?: ProcessId;
  startedAt?: number;
  responseReadyAt?: number;
  finishedAt?: number;
  durationMs?: number;
  status: 'running' | 'response-ready' | 'completed' | 'error' | 'aborted' | 'unavailable';
  backgroundWorkPending?: boolean;
  summary: {
    modelCallCount: number;
    toolCallCount: number;
    retryCount: number;
    fallbackCount: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
    knownCostUsd: number;
    costStatus: 'known' | 'partial' | 'unknown';
  };
  modelCalls: AgentModelCallTrace[];
  toolCalls: AgentToolCallTrace[];
  omittedModelCallCount: number;
  omittedToolCallCount: number;
};

export type AgentTraceEvent =
  | ({ type: 'llm-call-finished'; execution: GraphExecutionMetadata } & ChatV2CallTraceEvent)
  | ({ type: 'tool-call-finished'; execution: GraphExecutionMetadata } & ToolCallFinishedEvent);

export type BuildAgentResponseTraceOptions = {
  scope: AgentResponseTrace['scope'];
  execution: GraphExecutionMetadata;
  events: readonly AgentTraceEvent[];
  nodeId?: NodeId;
  processId?: ProcessId;
  startedAt?: number;
  responseReadyAt?: number;
  finishedAt?: number;
  status: AgentResponseTrace['status'];
  backgroundWorkPending?: boolean;
};

export function buildAgentResponseTrace(options: BuildAgentResponseTraceOptions): AgentResponseTrace {
  const matchingEvents = deduplicateAgentTraceEvents(
    options.events.filter((event) => {
      if (event.execution.rootRunId !== options.execution.rootRunId) return false;
      if (options.scope === 'response') return true;
      if (event.execution.graphRunId !== options.execution.graphRunId) return false;
      if (event.type === 'llm-call-finished') {
        return event.nodeId === options.nodeId && event.processId === options.processId;
      }
      return event.sourceNodeId === options.nodeId && event.sourceProcessId === options.processId;
    }),
  );
  const allModelCalls = matchingEvents
    .filter(
      (event): event is Extract<AgentTraceEvent, { type: 'llm-call-finished' }> => event.type === 'llm-call-finished',
    )
    .map(toModelCallTrace);
  const allToolCalls = matchingEvents
    .filter(
      (event): event is Extract<AgentTraceEvent, { type: 'tool-call-finished' }> => event.type === 'tool-call-finished',
    )
    .map(toToolCallTrace);
  const summary = summarizeAgentCalls(allModelCalls, allToolCalls);
  const terminalAt = options.responseReadyAt ?? options.finishedAt;

  return {
    schemaVersion: AGENT_RESPONSE_TRACE_SCHEMA_VERSION,
    traceId: options.execution.rootRunId,
    scope: options.scope,
    rootRunId: options.execution.rootRunId,
    graphRunId: options.execution.graphRunId,
    graphId: options.execution.graphId,
    ...(options.nodeId == null ? {} : { nodeId: options.nodeId }),
    ...(options.processId == null ? {} : { processId: options.processId }),
    ...(options.startedAt == null ? {} : { startedAt: options.startedAt }),
    ...(options.responseReadyAt == null ? {} : { responseReadyAt: options.responseReadyAt }),
    ...(options.finishedAt == null ? {} : { finishedAt: options.finishedAt }),
    ...(options.startedAt == null || terminalAt == null
      ? {}
      : { durationMs: Math.max(0, terminalAt - options.startedAt) }),
    status: options.status,
    ...(options.backgroundWorkPending == null ? {} : { backgroundWorkPending: options.backgroundWorkPending }),
    summary,
    modelCalls: allModelCalls.slice(0, AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS),
    toolCalls: allToolCalls.slice(0, AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS),
    omittedModelCallCount: Math.max(0, allModelCalls.length - AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS),
    omittedToolCallCount: Math.max(0, allToolCalls.length - AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS),
  };
}

/**
 * Trace transport is observational and may redeliver an event. Keep the
 * projection idempotent so repeated delivery cannot inflate call counts,
 * tokens, or cost. Physical model calls and identified tool calls carry stable
 * IDs; anonymous tool events remain distinct because they cannot be matched
 * safely.
 */
function deduplicateAgentTraceEvents(events: readonly AgentTraceEvent[]): AgentTraceEvent[] {
  const deduplicated: AgentTraceEvent[] = [];
  const indexByIdentity = new Map<string, number>();

  for (const event of events) {
    const identity = getAgentTraceEventIdentity(event);
    if (identity == null) {
      deduplicated.push(event);
      continue;
    }

    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex == null) {
      indexByIdentity.set(identity, deduplicated.length);
      deduplicated.push(event);
    } else {
      // Preserve first-seen order while retaining the latest terminal metadata.
      deduplicated[existingIndex] = mergeAgentTraceEvent(deduplicated[existingIndex]!, event);
    }
  }

  return deduplicated;
}

export function getAgentTraceEventIdentity(event: AgentTraceEvent): string | undefined {
  if (event.type === 'llm-call-finished') {
    return `model\u0000${event.execution.rootRunId}\u0000${event.execution.graphRunId}\u0000${event.nodeId}\u0000${event.processId}\u0000${event.callId}`;
  }

  return event.toolCallId == null
    ? undefined
    : `tool\u0000${event.execution.rootRunId}\u0000${event.execution.graphRunId}\u0000${event.sourceNodeId}\u0000${event.sourceProcessId}\u0000${event.toolCallId}`;
}

/**
 * Redelivery is allowed to omit newly added optional observability fields. Keep
 * an exact Delegate result pointer once it was observed instead of making a
 * later legacy-shaped copy erase result navigation.
 */
export function mergeAgentTraceEvent(existing: AgentTraceEvent, incoming: AgentTraceEvent): AgentTraceEvent {
  if (
    existing.type === 'tool-call-finished' &&
    incoming.type === 'tool-call-finished' &&
    existing.resultOwner != null &&
    incoming.resultOwner == null &&
    isAgentToolResultOutcome(incoming.outcome)
  ) {
    return { ...incoming, resultOwner: existing.resultOwner };
  }

  return incoming;
}

function toModelCallTrace(event: Extract<AgentTraceEvent, { type: 'llm-call-finished' }>): AgentModelCallTrace {
  return {
    callId: event.callId,
    nodeId: event.nodeId,
    processId: event.processId,
    provider: event.provider,
    model: event.model,
    outcome: event.outcome,
    attemptIndex: event.attemptIndex,
    ...(event.profileIndex == null ? {} : { profileIndex: event.profileIndex }),
    ...(event.roundIndex == null ? {} : { roundIndex: event.roundIndex }),
    ...(event.startedAt == null ? {} : { startedAt: event.startedAt }),
    ...(event.durationMs == null ? {} : { durationMs: event.durationMs }),
    ...(event.finishReason == null ? {} : { finishReason: event.finishReason }),
    ...(event.normalizedUsage == null ? {} : { usage: event.normalizedUsage }),
    pricing: event.pricing,
  };
}

function toToolCallTrace(event: Extract<AgentTraceEvent, { type: 'tool-call-finished' }>): AgentToolCallTrace {
  return {
    ...(event.toolCallId == null ? {} : { toolCallId: event.toolCallId }),
    toolName: event.toolName,
    sourceNodeId: event.sourceNodeId,
    sourceProcessId: event.sourceProcessId,
    ...(event.resultOwner == null ? {} : { resultOwner: event.resultOwner }),
    handlerKind: event.handlerKind,
    ...(event.handlerGraphId == null ? {} : { handlerGraphId: event.handlerGraphId }),
    ...(event.handlerName == null ? {} : { handlerName: event.handlerName }),
    outcome: event.outcome,
    ...(event.startedAt == null ? {} : { startedAt: event.startedAt }),
    ...(event.durationMs == null ? {} : { durationMs: event.durationMs }),
  };
}

function summarizeAgentCalls(modelCalls: AgentModelCallTrace[], toolCalls: AgentToolCallTrace[]) {
  const usageKeys = ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens'] as const;
  const usage = Object.fromEntries(
    usageKeys.flatMap((key) => {
      const values = modelCalls.map((call) => call.usage?.[key]).filter((value): value is number => value != null);
      return values.length === 0 ? [] : [[key, values.reduce((sum, value) => sum + value, 0)]];
    }),
  );
  const knownCosts = modelCalls
    .map((call) => call.pricing.costUsd)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const unknownCostCount = modelCalls.filter(
    (call) => call.pricing.status === 'unknown' || !Number.isFinite(call.pricing.costUsd),
  ).length;
  const profileTransitions = countProfileFallbacks(modelCalls);

  return {
    modelCallCount: modelCalls.length,
    toolCallCount: toolCalls.length,
    retryCount: modelCalls.filter((call) => call.attemptIndex > 0).length,
    fallbackCount: profileTransitions,
    ...usage,
    knownCostUsd: knownCosts.reduce((sum, value) => sum + value, 0),
    costStatus:
      modelCalls.length === 0 || unknownCostCount === modelCalls.length
        ? ('unknown' as const)
        : unknownCostCount > 0
          ? ('partial' as const)
          : ('known' as const),
  };
}

/**
 * Counts forward profile advances per physical node invocation. The fallback
 * runner starts at profile zero and stays on or advances from its selected
 * profile across continuation rounds. Using that invariant also accounts for
 * configuration-failed profiles that never produced a physical-call event.
 */
function countProfileFallbacks(modelCalls: readonly AgentModelCallTrace[]): number {
  const highestProfileByInvocation = new Map<string, number>();
  let count = 0;

  for (const call of modelCalls) {
    if (call.profileIndex == null) continue;
    const key = `${call.nodeId}\u0000${call.processId}`;
    const highestProfile = highestProfileByInvocation.get(key) ?? 0;
    if (call.profileIndex <= highestProfile) continue;
    count += call.profileIndex - highestProfile;
    highestProfileByInvocation.set(key, call.profileIndex);
  }

  return count;
}

export function isAgentResponseTrace(value: unknown): value is AgentResponseTrace {
  if (!isRecord(value) || value.schemaVersion !== AGENT_RESPONSE_TRACE_SCHEMA_VERSION) return false;
  if (
    !hasOnlyKeys(value, [
      'schemaVersion',
      'traceId',
      'scope',
      'rootRunId',
      'graphRunId',
      'graphId',
      'nodeId',
      'processId',
      'startedAt',
      'responseReadyAt',
      'finishedAt',
      'durationMs',
      'status',
      'backgroundWorkPending',
      'summary',
      'modelCalls',
      'toolCalls',
      'omittedModelCallCount',
      'omittedToolCallCount',
    ])
  )
    return false;
  if (typeof value.traceId !== 'string' || typeof value.rootRunId !== 'string') return false;
  if (typeof value.graphRunId !== 'string' || typeof value.graphId !== 'string') return false;
  if (value.scope !== 'response' && value.scope !== 'llm-invocation') return false;
  if (!isRecord(value.summary) || !Array.isArray(value.modelCalls) || !Array.isArray(value.toolCalls)) return false;
  if (value.modelCalls.length > AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS) return false;
  if (value.toolCalls.length > AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS) return false;
  return (
    isOptionalString(value.nodeId) &&
    isOptionalString(value.processId) &&
    isOptionalNonNegativeFiniteNumber(value.startedAt) &&
    isOptionalNonNegativeFiniteNumber(value.responseReadyAt) &&
    isOptionalNonNegativeFiniteNumber(value.finishedAt) &&
    isOptionalNonNegativeFiniteNumber(value.durationMs) &&
    isOptionalBoolean(value.backgroundWorkPending) &&
    ['running', 'response-ready', 'completed', 'error', 'aborted', 'unavailable'].includes(String(value.status)) &&
    isNonNegativeInteger(value.omittedModelCallCount) &&
    isNonNegativeInteger(value.omittedToolCallCount) &&
    isAgentTraceSummary(value.summary) &&
    value.modelCalls.every(isAgentModelCallTrace) &&
    value.toolCalls.every(isAgentToolCallTrace)
  );
}

/**
 * Collects privacy-bounded response metadata for one root processor run.
 * Listener failures are isolated by GraphProcessor; callers should dispose the
 * collector after the processor and any asynchronous branches settle.
 */
export class AgentResponseTraceCollector {
  readonly #events: AgentTraceEvent[] = [];
  readonly #cleanups: Array<() => void> = [];
  readonly #startedAt = Date.now();
  #execution?: GraphExecutionMetadata;
  #responseReadyAt?: number;
  #finishedAt?: number;
  #status: AgentResponseTrace['status'] = 'running';
  #backgroundWorkPending = false;

  constructor(processor: GraphProcessor) {
    this.#cleanups.push(
      processor.on('start', ({ execution }) => {
        this.#execution = execution;
      }),
      processor.on('llmCallFinished', (event) => {
        this.#execution ??= event.execution;
        this.#events.push({ type: 'llm-call-finished', ...event });
      }),
      processor.on('toolCallFinished', (event) => {
        this.#execution ??= event.execution;
        this.#events.push({ type: 'tool-call-finished', ...event });
      }),
      processor.on('graphOutputsReady', ({ execution }) => {
        if (execution.parentGraphRunId != null) return;
        this.#execution ??= execution;
        this.#responseReadyAt ??= Date.now();
        this.#status = 'response-ready';
        this.#backgroundWorkPending = processor.isRunning;
      }),
      processor.on('graphFinish', ({ execution }) => {
        if (execution.parentGraphRunId != null) return;
        this.#execution ??= execution;
        this.#finishedAt = Date.now();
        this.#responseReadyAt ??= this.#finishedAt;
        this.#status = 'completed';
        this.#backgroundWorkPending = false;
      }),
      processor.on('graphError', ({ execution }) => {
        if (execution.parentGraphRunId != null) return;
        this.#execution ??= execution;
        this.#finishedAt = Date.now();
        this.#status = 'error';
        this.#backgroundWorkPending = false;
      }),
      processor.on('graphAbort', ({ execution }) => {
        if (execution.parentGraphRunId != null) return;
        this.#execution ??= execution;
        this.#finishedAt = Date.now();
        this.#status = 'aborted';
        this.#backgroundWorkPending = false;
      }),
    );
  }

  build(): AgentResponseTrace | undefined {
    if (this.#execution == null) return undefined;
    return buildAgentResponseTrace({
      scope: 'response',
      execution: this.#execution,
      events: this.#events,
      startedAt: this.#startedAt,
      ...(this.#responseReadyAt == null ? {} : { responseReadyAt: this.#responseReadyAt }),
      ...(this.#finishedAt == null ? {} : { finishedAt: this.#finishedAt }),
      status: this.#status,
      backgroundWorkPending: this.#backgroundWorkPending,
    });
  }

  dispose(): void {
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
  }
}

function isAgentModelCallTrace(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'callId',
      'nodeId',
      'processId',
      'provider',
      'model',
      'outcome',
      'attemptIndex',
      'profileIndex',
      'roundIndex',
      'startedAt',
      'durationMs',
      'finishReason',
      'usage',
      'pricing',
    ]) &&
    typeof value.callId === 'string' &&
    typeof value.nodeId === 'string' &&
    typeof value.processId === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    (value.outcome === 'success' || value.outcome === 'provider-failure' || value.outcome === 'aborted') &&
    isNonNegativeInteger(value.attemptIndex) &&
    isOptionalNonNegativeInteger(value.profileIndex) &&
    isOptionalNonNegativeInteger(value.roundIndex) &&
    isOptionalNonNegativeFiniteNumber(value.startedAt) &&
    isOptionalNonNegativeFiniteNumber(value.durationMs) &&
    isOptionalString(value.finishReason) &&
    (value.usage === undefined || isAgentTraceUsage(value.usage)) &&
    isAgentTracePricing(value.pricing)
  );
}

function isAgentToolCallTrace(value: unknown): boolean {
  const hasKnownOutcome =
    isRecord(value) &&
    (value.outcome === 'success' ||
      value.outcome === 'passthrough-error' ||
      value.outcome === 'failure' ||
      value.outcome === 'aborted');

  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'toolCallId',
      'toolName',
      'sourceNodeId',
      'sourceProcessId',
      'resultOwner',
      'handlerKind',
      'handlerGraphId',
      'handlerName',
      'outcome',
      'startedAt',
      'durationMs',
    ]) &&
    isOptionalString(value.toolCallId) &&
    typeof value.toolName === 'string' &&
    typeof value.sourceNodeId === 'string' &&
    typeof value.sourceProcessId === 'string' &&
    (value.resultOwner === undefined ||
      (isAgentToolResultOutcome(value.outcome) && isAgentToolResultOwner(value.resultOwner))) &&
    (value.handlerKind === 'graph' || value.handlerKind === 'external' || value.handlerKind === 'unknown') &&
    isOptionalString(value.handlerGraphId) &&
    isOptionalString(value.handlerName) &&
    hasKnownOutcome &&
    isOptionalNonNegativeFiniteNumber(value.startedAt) &&
    isOptionalNonNegativeFiniteNumber(value.durationMs)
  );
}

function isAgentToolResultOutcome(value: unknown): value is 'success' | 'passthrough-error' {
  return value === 'success' || value === 'passthrough-error';
}

function isAgentToolResultOwner(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['nodeId', 'processId', 'outputPortId']) &&
    typeof value.nodeId === 'string' &&
    typeof value.processId === 'string' &&
    typeof value.outputPortId === 'string'
  );
}

function isAgentTraceSummary(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      'modelCallCount',
      'toolCallCount',
      'retryCount',
      'fallbackCount',
      'promptTokens',
      'completionTokens',
      'totalTokens',
      'cachedTokens',
      'reasoningTokens',
      'knownCostUsd',
      'costStatus',
    ]) &&
    isNonNegativeInteger(value.modelCallCount) &&
    isNonNegativeInteger(value.toolCallCount) &&
    isNonNegativeInteger(value.retryCount) &&
    isNonNegativeInteger(value.fallbackCount) &&
    isOptionalNonNegativeFiniteNumber(value.promptTokens) &&
    isOptionalNonNegativeFiniteNumber(value.completionTokens) &&
    isOptionalNonNegativeFiniteNumber(value.totalTokens) &&
    isOptionalNonNegativeFiniteNumber(value.cachedTokens) &&
    isOptionalNonNegativeFiniteNumber(value.reasoningTokens) &&
    isNonNegativeFiniteNumber(value.knownCostUsd) &&
    (value.costStatus === 'known' || value.costStatus === 'partial' || value.costStatus === 'unknown')
  );
}

function isAgentTraceUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens']) &&
    Object.values(value).every(isNonNegativeFiniteNumber)
  );
}

function isAgentTracePricing(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['status', 'costUsd']) &&
    (value.status === 'known' || value.status === 'unknown') &&
    isOptionalNonNegativeFiniteNumber(value.costUsd)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isOptionalNonNegativeFiniteNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeFiniteNumber(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

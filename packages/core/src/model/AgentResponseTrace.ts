import type {
  ChatV2CallTraceEvent,
  GraphExecutionMetadata,
  GraphRunId,
  LLMProfileAttemptTraceEvent,
  ProcessId,
  RootRunId,
  ToolCallFinishedEvent,
} from './ProcessContext.js';
import type { GraphId } from './NodeGraph.js';
import type { NodeId } from './NodeBase.js';
import type { GraphProcessor } from './GraphProcessor.js';

export const AGENT_RESPONSE_TRACE_SCHEMA_VERSION = 1 as const;
export const AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS = 250;
export const AGENT_RESPONSE_TRACE_MAX_PROFILE_ATTEMPTS = 1_000;
export const AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS = 500;

export type AgentModelCallTrace = {
  callId: string;
  nodeId: NodeId;
  processId: ProcessId;
  provider: string;
  model: string;
  customProviderApi?: ChatV2CallTraceEvent['customProviderApi'];
  outcome: ChatV2CallTraceEvent['outcome'];
  attemptIndex: number;
  profileIndex?: number;
  profileName?: string;
  profileHealthKey?: string;
  profileHealthState?: ChatV2CallTraceEvent['profileHealthState'];
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

export type AgentLLMProfileAttemptTrace = Omit<LLMProfileAttemptTraceEvent, 'eventId'> & {
  eventId: string;
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
  /** Additive in schema v1; absent in traces produced before profile-health observability. */
  profileAttempts?: AgentLLMProfileAttemptTrace[];
  toolCalls: AgentToolCallTrace[];
  omittedModelCallCount: number;
  /** Additive in schema v1; absent in older traces. */
  omittedProfileAttemptCount?: number;
  omittedToolCallCount: number;
};

export type AgentTraceEvent =
  | ({ type: 'llm-call-finished'; execution: GraphExecutionMetadata } & ChatV2CallTraceEvent)
  | ({ type: 'llm-profile-attempt'; execution: GraphExecutionMetadata } & LLMProfileAttemptTraceEvent)
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
      if (event.type === 'llm-profile-attempt') {
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
  const allProfileAttempts = matchingEvents
    .filter(
      (event): event is Extract<AgentTraceEvent, { type: 'llm-profile-attempt' }> =>
        event.type === 'llm-profile-attempt',
    )
    .map(toProfileAttemptTrace);
  const allToolCalls = matchingEvents
    .filter(
      (event): event is Extract<AgentTraceEvent, { type: 'tool-call-finished' }> => event.type === 'tool-call-finished',
    )
    .map(toToolCallTrace);
  const summary = summarizeAgentCalls(allModelCalls, allProfileAttempts, allToolCalls);
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
    profileAttempts: allProfileAttempts.slice(0, AGENT_RESPONSE_TRACE_MAX_PROFILE_ATTEMPTS),
    toolCalls: allToolCalls.slice(0, AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS),
    omittedModelCallCount: Math.max(0, allModelCalls.length - AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS),
    omittedProfileAttemptCount: Math.max(
      0,
      allProfileAttempts.length - AGENT_RESPONSE_TRACE_MAX_PROFILE_ATTEMPTS,
    ),
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

  if (event.type === 'llm-profile-attempt') {
    return `profile-attempt\u0000${event.execution.rootRunId}\u0000${event.execution.graphRunId}\u0000${event.nodeId}\u0000${event.processId}\u0000${event.eventId}`;
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
  if (existing.type === 'llm-call-finished' && incoming.type === 'llm-call-finished') {
    return {
      ...incoming,
      ...(incoming.profileName == null && existing.profileName != null
        ? { profileName: existing.profileName }
        : {}),
      ...(incoming.profileHealthKey == null && existing.profileHealthKey != null
        ? { profileHealthKey: existing.profileHealthKey }
        : {}),
      ...(incoming.profileHealthState == null && existing.profileHealthState != null
        ? { profileHealthState: existing.profileHealthState }
        : {}),
    };
  }

  if (existing.type === 'llm-profile-attempt' && incoming.type === 'llm-profile-attempt') {
    return {
      ...incoming,
      ...(incoming.profileName == null && existing.profileName != null
        ? { profileName: existing.profileName }
        : {}),
    };
  }

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
    ...(event.customProviderApi == null ? {} : { customProviderApi: event.customProviderApi }),
    outcome: event.outcome,
    attemptIndex: event.attemptIndex,
    ...(event.profileIndex == null ? {} : { profileIndex: event.profileIndex }),
    ...(event.profileName == null ? {} : { profileName: event.profileName }),
    ...(event.profileHealthKey == null ? {} : { profileHealthKey: event.profileHealthKey }),
    ...(event.profileHealthState == null ? {} : { profileHealthState: event.profileHealthState }),
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

function toProfileAttemptTrace(
  event: Extract<AgentTraceEvent, { type: 'llm-profile-attempt' }>,
): AgentLLMProfileAttemptTrace {
  const { type: _type, execution: _execution, ...trace } = event;
  return trace;
}

function summarizeAgentCalls(
  modelCalls: AgentModelCallTrace[],
  profileAttempts: AgentLLMProfileAttemptTrace[],
  toolCalls: AgentToolCallTrace[],
) {
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
  const profileTransitions = countProfileFallbacks(modelCalls, profileAttempts);

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
function countProfileFallbacks(
  modelCalls: readonly AgentModelCallTrace[],
  profileAttempts: readonly AgentLLMProfileAttemptTrace[],
): number {
  const highestProfileByInvocation = new Map<string, number>();
  let count = 0;

  const candidates = [
    ...modelCalls.flatMap((call) =>
      call.profileIndex == null
        ? []
        : [{ nodeId: call.nodeId, processId: call.processId, profileIndex: call.profileIndex }],
    ),
    ...profileAttempts.flatMap((attempt) =>
      attempt.profileIndex == null
        ? []
        : [{ nodeId: attempt.nodeId, processId: attempt.processId, profileIndex: attempt.profileIndex }],
    ),
  ];

  for (const candidate of candidates) {
    const key = `${candidate.nodeId}\u0000${candidate.processId}`;
    const highestProfile = highestProfileByInvocation.get(key) ?? 0;
    if (candidate.profileIndex <= highestProfile) continue;
    count += candidate.profileIndex - highestProfile;
    highestProfileByInvocation.set(key, candidate.profileIndex);
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
      'profileAttempts',
      'toolCalls',
      'omittedModelCallCount',
      'omittedProfileAttemptCount',
      'omittedToolCallCount',
    ])
  )
    return false;
  if (typeof value.traceId !== 'string' || typeof value.rootRunId !== 'string') return false;
  if (typeof value.graphRunId !== 'string' || typeof value.graphId !== 'string') return false;
  if (value.scope !== 'response' && value.scope !== 'llm-invocation') return false;
  if (!isRecord(value.summary) || !Array.isArray(value.modelCalls) || !Array.isArray(value.toolCalls)) return false;
  if (value.profileAttempts !== undefined && !Array.isArray(value.profileAttempts)) return false;
  if (value.modelCalls.length > AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS) return false;
  if (
    Array.isArray(value.profileAttempts) &&
    value.profileAttempts.length > AGENT_RESPONSE_TRACE_MAX_PROFILE_ATTEMPTS
  )
    return false;
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
    (value.omittedProfileAttemptCount === undefined || isNonNegativeInteger(value.omittedProfileAttemptCount)) &&
    isNonNegativeInteger(value.omittedToolCallCount) &&
    isAgentTraceSummary(value.summary) &&
    value.modelCalls.every(isAgentModelCallTrace) &&
    (value.profileAttempts === undefined || value.profileAttempts.every(isAgentLLMProfileAttemptTrace)) &&
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
      processor.on('llmProfileAttempt', (event) => {
        this.#execution ??= event.execution;
        this.#events.push({ type: 'llm-profile-attempt', ...event });
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
      'customProviderApi',
      'outcome',
      'attemptIndex',
      'profileIndex',
      'profileName',
      'profileHealthKey',
      'profileHealthState',
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
    (value.customProviderApi === undefined ||
      value.customProviderApi === 'completions' ||
      value.customProviderApi === 'responses') &&
    (value.outcome === 'success' || value.outcome === 'provider-failure' || value.outcome === 'aborted') &&
    isNonNegativeInteger(value.attemptIndex) &&
    isOptionalNonNegativeInteger(value.profileIndex) &&
    isOptionalString(value.profileName) &&
    isOptionalString(value.profileHealthKey) &&
    (value.profileHealthState === undefined ||
      value.profileHealthState === 'closed' ||
      value.profileHealthState === 'open' ||
      value.profileHealthState === 'half-open') &&
    isOptionalNonNegativeInteger(value.roundIndex) &&
    isOptionalNonNegativeFiniteNumber(value.startedAt) &&
    isOptionalNonNegativeFiniteNumber(value.durationMs) &&
    isOptionalString(value.finishReason) &&
    (value.usage === undefined || isAgentTraceUsage(value.usage)) &&
    isAgentTracePricing(value.pricing)
  );
}

function isAgentLLMProfileAttemptTrace(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'eventId',
      'roundIndex',
      'profileIndex',
      'profileName',
      'nodeId',
      'processId',
      'provider',
      'model',
      'customProviderApi',
      'stage',
      'outcome',
      'attemptIndex',
      'status',
      'error',
      'profileHealthKey',
      'healthState',
      'healthDisposition',
      'healthOutcome',
      'retryAt',
      'timeoutKind',
    ]) &&
    typeof value.eventId === 'string' &&
    isNonNegativeInteger(value.roundIndex) &&
    isOptionalNonNegativeInteger(value.profileIndex) &&
    isOptionalString(value.profileName) &&
    typeof value.nodeId === 'string' &&
    typeof value.processId === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    (value.customProviderApi === undefined ||
      value.customProviderApi === 'completions' ||
      value.customProviderApi === 'responses') &&
    ['configuration', 'request', 'response-validation', 'health-gate', 'health-update'].includes(
      String(value.stage),
    ) &&
    ['success', 'failure', 'aborted', 'skipped'].includes(String(value.outcome)) &&
    isOptionalNonNegativeInteger(value.attemptIndex) &&
    isOptionalNonNegativeFiniteNumber(value.status) &&
    isOptionalString(value.error) &&
    isOptionalString(value.profileHealthKey) &&
    (value.healthState === undefined ||
      value.healthState === 'closed' ||
      value.healthState === 'open' ||
      value.healthState === 'half-open') &&
    (value.healthDisposition === undefined ||
      value.healthDisposition === 'allow' ||
      value.healthDisposition === 'deny' ||
      value.healthDisposition === 'fail-open') &&
    (value.healthOutcome === undefined ||
      value.healthOutcome === 'healthy' ||
      value.healthOutcome === 'unhealthy' ||
      value.healthOutcome === 'ignored') &&
    isOptionalNonNegativeFiniteNumber(value.retryAt) &&
    (value.timeoutKind === undefined ||
      value.timeoutKind === 'first-output' ||
      value.timeoutKind === 'stream-inactivity')
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

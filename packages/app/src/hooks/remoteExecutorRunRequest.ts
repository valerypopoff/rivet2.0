import type {
  GraphOutputs,
  GraphProgress,
  OutgoingMessageMap,
  ProcessEventMessageMap,
  RemoteRunRequestId,
  RootRunId,
  ProjectId,
} from '@valerypopoff/rivet2-core';
import type { ExecutorSessionRuntime } from './executorSession.js';

export type ActiveRemoteRunRequestRef = {
  current: RemoteRunRequestId | null;
};

export type RemoteRunPayloadWithoutRequestId = Omit<OutgoingMessageMap['run'], 'requestId'>;

export type RemoteRunRequestSender = (payload: OutgoingMessageMap['run']) => boolean;

export type UnscopedRemoteExecutionRoutingState = {
  acceptedRootRunIds: Set<RootRunId>;
  completedRootRunDecisions: Array<{ accepted: boolean; rootRunId: RootRunId }>;
  ignoredRootRunIds: Set<RootRunId>;
  lastRunAccepted: boolean | undefined;
  recentlyCompletedRootRunDecisions: Map<RootRunId, boolean>;
};

export type RemoteExecutionEventDispatchDecision = {
  reason:
    | 'active-request-matched'
    | 'active-request-mismatched'
    | 'active-root-accepted'
    | 'active-root-ignored'
    | 'completed-terminal-accepted'
    | 'completed-terminal-ignored'
    | 'legacy-unscoped-default-accepted'
    | 'recent-root-accepted'
    | 'recent-root-ignored'
    | 'unscoped-start-accepted'
    | 'unscoped-start-ignored'
    | 'unscoped-last-decision-accepted'
    | 'unscoped-last-decision-ignored';
  rootRunId?: RootRunId;
  shouldDispatch: boolean;
};

export type ActiveRemoteRunRequestResult =
  | {
      requestId: RemoteRunRequestId;
      type: 'sent';
    }
  | {
      requestId: RemoteRunRequestId;
      type: 'send-failed';
    };

export function createUnscopedRemoteExecutionRoutingState(): UnscopedRemoteExecutionRoutingState {
  return {
    acceptedRootRunIds: new Set(),
    completedRootRunDecisions: [],
    ignoredRootRunIds: new Set(),
    lastRunAccepted: undefined,
    recentlyCompletedRootRunDecisions: new Map(),
  };
}

export function resetUnscopedRemoteExecutionRoutingState(state: UnscopedRemoteExecutionRoutingState): void {
  state.acceptedRootRunIds.clear();
  state.completedRootRunDecisions = [];
  state.ignoredRootRunIds.clear();
  state.lastRunAccepted = undefined;
  state.recentlyCompletedRootRunDecisions.clear();
}

export function shouldDispatchRemoteExecutionEvent<K extends keyof ProcessEventMessageMap>(options: {
  activeRequestId: RemoteRunRequestId | null;
  currentProjectId: ProjectId | undefined;
  data: ProcessEventMessageMap[K];
  message: K;
  requestId: RemoteRunRequestId | undefined;
  unscopedRoutingState: UnscopedRemoteExecutionRoutingState;
}): boolean {
  return getRemoteExecutionEventDispatchDecision(options).shouldDispatch;
}

export function getRemoteExecutionEventDispatchDecision<K extends keyof ProcessEventMessageMap>(options: {
  activeRequestId: RemoteRunRequestId | null;
  currentProjectId: ProjectId | undefined;
  data: ProcessEventMessageMap[K];
  message: K;
  requestId: RemoteRunRequestId | undefined;
  unscopedRoutingState: UnscopedRemoteExecutionRoutingState;
}): RemoteExecutionEventDispatchDecision {
  const { activeRequestId, currentProjectId, data, message, requestId, unscopedRoutingState } = options;

  if (requestId != null) {
    const shouldDispatch = requestId === activeRequestId;
    return {
      reason: shouldDispatch ? 'active-request-matched' : 'active-request-mismatched',
      shouldDispatch,
    };
  }

  if (message === 'start') {
    const accepted = shouldAcceptUnscopedStartEvent(data as ProcessEventMessageMap['start'], currentProjectId);
    rememberUnscopedRunDecision(unscopedRoutingState, data as ProcessEventMessageMap['start'], accepted);
    return {
      reason: accepted ? 'unscoped-start-accepted' : 'unscoped-start-ignored',
      rootRunId: (data as ProcessEventMessageMap['start']).execution?.rootRunId,
      shouldDispatch: accepted,
    };
  }

  const rootRunId = getUnscopedEventRootRunId(data);
  if (rootRunId != null) {
    if (unscopedRoutingState.acceptedRootRunIds.has(rootRunId)) {
      rememberCompletedUnscopedRootRun(unscopedRoutingState, message, data, true);
      return {
        reason: 'active-root-accepted',
        rootRunId,
        shouldDispatch: true,
      };
    }

    if (unscopedRoutingState.ignoredRootRunIds.has(rootRunId)) {
      rememberCompletedUnscopedRootRun(unscopedRoutingState, message, data, false);
      return {
        reason: 'active-root-ignored',
        rootRunId,
        shouldDispatch: false,
      };
    }

    const recentDecision = unscopedRoutingState.recentlyCompletedRootRunDecisions.get(rootRunId);
    if (recentDecision != null) {
      return {
        reason: recentDecision ? 'recent-root-accepted' : 'recent-root-ignored',
        rootRunId,
        shouldDispatch: recentDecision,
      };
    }
  }

  const terminalDecision = consumeCompletedUnscopedTerminalDecision(unscopedRoutingState, message);
  if (terminalDecision != null) {
    return {
      reason: terminalDecision ? 'completed-terminal-accepted' : 'completed-terminal-ignored',
      shouldDispatch: terminalDecision,
    };
  }

  if (unscopedRoutingState.lastRunAccepted != null) {
    return {
      reason: unscopedRoutingState.lastRunAccepted
        ? 'unscoped-last-decision-accepted'
        : 'unscoped-last-decision-ignored',
      shouldDispatch: unscopedRoutingState.lastRunAccepted,
    };
  }

  return {
    reason: 'legacy-unscoped-default-accepted',
    shouldDispatch: true,
  };
}

export function clearActiveRemoteRunRequest(activeRequestIdRef: ActiveRemoteRunRequestRef): void {
  activeRequestIdRef.current = null;
}

export function clearActiveRemoteRunRequestIfMatches(
  activeRequestIdRef: ActiveRemoteRunRequestRef,
  requestId: RemoteRunRequestId | undefined,
): void {
  if (requestId === activeRequestIdRef.current) {
    activeRequestIdRef.current = null;
  }
}

export function startActiveRemoteGraphRunRequest(options: {
  activeRequestIdRef: ActiveRemoteRunRequestRef;
  createRequestId: () => RemoteRunRequestId;
  payload: RemoteRunPayloadWithoutRequestId;
  sendRun: RemoteRunRequestSender;
}): ActiveRemoteRunRequestResult {
  const { activeRequestIdRef, createRequestId, payload, sendRun } = options;
  const requestId = createRequestId();
  activeRequestIdRef.current = requestId;

  const runSent = sendRun({
    ...payload,
    requestId,
  });

  if (!runSent) {
    activeRequestIdRef.current = null;
    return {
      requestId,
      type: 'send-failed',
    };
  }

  return {
    requestId,
    type: 'sent',
  };
}

export async function sendPendingRemoteGraphRunRequest(options: {
  abortSignal?: AbortSignal;
  disconnectErrorMessage: string;
  executorSession: Pick<ExecutorSessionRuntime, 'createPendingGraphExecution' | 'rejectPendingGraphExecution'>;
  onRequestCreated?(requestId: RemoteRunRequestId): void;
  onRequestSettled?(requestId: RemoteRunRequestId): void;
  onProgress?: (progress: GraphProgress) => void;
  payload: RemoteRunPayloadWithoutRequestId;
  sendAbort?(requestId: RemoteRunRequestId): boolean;
  sendRun: RemoteRunRequestSender;
}): Promise<GraphOutputs> {
  const { abortSignal, disconnectErrorMessage, executorSession, payload, sendRun } = options;
  abortSignal?.throwIfAborted();
  const { requestId, promise } = executorSession.createPendingGraphExecution(undefined, options.onProgress);
  options.onRequestCreated?.(requestId);
  let runSent = false;

  const handleAbort = () => {
    let abortSent = false;
    try {
      abortSent = runSent && (options.sendAbort?.(requestId) ?? false);
    } catch {
      // Transport failures fall through to local pending-request cleanup.
    }
    if (abortSent) {
      return;
    }
    executorSession.rejectPendingGraphExecution(
      requestId,
      abortSignal?.reason ?? new DOMException('The graph run was aborted.', 'AbortError'),
    );
  };
  abortSignal?.addEventListener('abort', handleAbort, { once: true });

  try {
    if (abortSignal?.aborted) {
      handleAbort();
      return await promise;
    }

    try {
      runSent = sendRun({
        ...payload,
        requestId,
      });
    } catch (error) {
      executorSession.rejectPendingGraphExecution(requestId, error);
      return await promise;
    }

    if (!runSent) {
      executorSession.rejectPendingGraphExecution(requestId, new Error(disconnectErrorMessage));
    }

    return await promise;
  } finally {
    abortSignal?.removeEventListener('abort', handleAbort);
    options.onRequestSettled?.(requestId);
  }
}

function shouldAcceptUnscopedStartEvent(
  data: ProcessEventMessageMap['start'],
  currentProjectId: ProjectId | undefined,
): boolean {
  const eventProjectId = data.project?.metadata?.id;

  if (!eventProjectId || !currentProjectId) {
    return true;
  }

  return eventProjectId === currentProjectId;
}

function rememberUnscopedRunDecision(
  state: UnscopedRemoteExecutionRoutingState,
  data: ProcessEventMessageMap['start'],
  accepted: boolean,
): void {
  const rootRunId = data.execution?.rootRunId;
  if (rootRunId != null) {
    const targetSet = accepted ? state.acceptedRootRunIds : state.ignoredRootRunIds;
    const otherSet = accepted ? state.ignoredRootRunIds : state.acceptedRootRunIds;
    targetSet.add(rootRunId);
    otherSet.delete(rootRunId);
    state.recentlyCompletedRootRunDecisions.delete(rootRunId);
  }

  state.lastRunAccepted = accepted;
}

function getUnscopedEventRootRunId(data: unknown): RootRunId | undefined {
  if (!hasExecutionMetadata(data)) {
    return undefined;
  }

  return data.execution.rootRunId;
}

function rememberCompletedUnscopedRootRun<K extends keyof ProcessEventMessageMap>(
  state: UnscopedRemoteExecutionRoutingState,
  message: K,
  data: ProcessEventMessageMap[K],
  accepted: boolean,
): void {
  if (message !== 'graphFinish' && message !== 'graphAbort' && message !== 'graphError') {
    return;
  }

  if (!hasExecutionMetadata(data) || data.execution.parentGraphRunId != null) {
    return;
  }

  const existingDecision = state.completedRootRunDecisions.find(
    (decision) => decision.rootRunId === data.execution.rootRunId,
  );
  if (existingDecision) {
    existingDecision.accepted = accepted;
    return;
  }

  state.completedRootRunDecisions.push({ accepted, rootRunId: data.execution.rootRunId });

  if (state.completedRootRunDecisions.length > 32) {
    const removedDecisions = state.completedRootRunDecisions.splice(0, state.completedRootRunDecisions.length - 32);
    for (const removedDecision of removedDecisions) {
      state.acceptedRootRunIds.delete(removedDecision.rootRunId);
      state.ignoredRootRunIds.delete(removedDecision.rootRunId);
    }
  }
}

function consumeCompletedUnscopedTerminalDecision<K extends keyof ProcessEventMessageMap>(
  state: UnscopedRemoteExecutionRoutingState,
  message: K,
): boolean | undefined {
  if (message !== 'done' && message !== 'abort' && message !== 'error') {
    return undefined;
  }

  const decision = state.completedRootRunDecisions.shift();
  if (!decision) {
    return undefined;
  }

  state.acceptedRootRunIds.delete(decision.rootRunId);
  state.ignoredRootRunIds.delete(decision.rootRunId);
  rememberRecentlyCompletedUnscopedRootRun(state, decision);
  return decision.accepted;
}

function rememberRecentlyCompletedUnscopedRootRun(
  state: UnscopedRemoteExecutionRoutingState,
  decision: { accepted: boolean; rootRunId: RootRunId },
): void {
  state.recentlyCompletedRootRunDecisions.set(decision.rootRunId, decision.accepted);

  while (state.recentlyCompletedRootRunDecisions.size > 32) {
    const oldestRootRunId = state.recentlyCompletedRootRunDecisions.keys().next();
    if (oldestRootRunId.done) {
      return;
    }
    state.recentlyCompletedRootRunDecisions.delete(oldestRootRunId.value);
  }
}

function hasExecutionMetadata(data: unknown): data is {
  execution: {
    parentGraphRunId?: unknown;
    rootRunId: RootRunId;
  };
} {
  if (typeof data !== 'object' || data == null) {
    return false;
  }

  const execution = (data as { execution?: unknown }).execution;
  if (typeof execution !== 'object' || execution == null) {
    return false;
  }

  return typeof (execution as { rootRunId?: unknown }).rootRunId === 'string';
}

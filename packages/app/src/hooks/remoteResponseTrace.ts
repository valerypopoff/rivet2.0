import {
  buildAgentResponseTrace,
  logRuntimeDebug,
  type AgentResponseTrace,
  type AgentTraceEvent,
  type GraphExecutionMetadata,
  type RemoteRunRequestId,
} from '@valerypopoff/rivet2-core';

export type RemoteResponseTraceState = {
  callback: (trace: AgentResponseTrace) => void;
  events: AgentTraceEvent[];
  startedAt: number;
  execution?: GraphExecutionMetadata;
  delivered: boolean;
};

export function captureRemoteResponseTraceRootExecution(
  traces: Map<RemoteRunRequestId, RemoteResponseTraceState>,
  requestId: RemoteRunRequestId | undefined,
  data: unknown,
): boolean {
  if (requestId == null) return false;
  const state = traces.get(requestId);
  const execution = getExecution(data);
  if (state == null || state.delivered || execution == null || execution.parentGraphRunId != null) return false;
  if (state.execution != null && !isSameRootExecution(state.execution, execution)) return false;
  state.execution ??= execution;
  return true;
}

export function collectRemoteAgentTraceEvent(
  traces: Map<RemoteRunRequestId, RemoteResponseTraceState>,
  requestId: RemoteRunRequestId | undefined,
  type: AgentTraceEvent['type'],
  data: unknown,
): void {
  if (requestId == null) return;
  const state = traces.get(requestId);
  if (state == null || state.delivered || state.execution == null || typeof data !== 'object' || data == null) return;
  const event = { type, ...data } as AgentTraceEvent;
  if (event.execution.rootRunId !== state.execution.rootRunId) return;
  state.events.push(event);
}

export function emitRemoteResponseTrace(
  traces: Map<RemoteRunRequestId, RemoteResponseTraceState>,
  requestId: RemoteRunRequestId | undefined,
  data: unknown,
  backgroundWorkPending: boolean,
  terminalStatus?: 'error' | 'aborted',
): void {
  if (requestId == null) return;
  const state = traces.get(requestId);
  if (state == null || state.delivered) return;

  const eventExecution = getExecution(data);
  if (eventExecution != null) {
    if (eventExecution.parentGraphRunId != null) return;
    if (!captureRemoteResponseTraceRootExecution(traces, requestId, data)) return;
  }
  if (state.execution == null) return;

  const now = Date.now();
  const trace = buildAgentResponseTrace({
    scope: 'response',
    execution: state.execution,
    events: state.events,
    startedAt: state.startedAt,
    ...(backgroundWorkPending ? { responseReadyAt: now } : { finishedAt: now }),
    status: terminalStatus ?? (backgroundWorkPending ? 'response-ready' : 'completed'),
    backgroundWorkPending,
  });
  state.delivered = true;
  try {
    state.callback(trace);
  } catch (error) {
    logRuntimeDebug('Response trace observer failed.', { error });
  }
}

function getExecution(data: unknown): GraphExecutionMetadata | undefined {
  return typeof data === 'object' && data != null && 'execution' in data
    ? (data as { execution?: GraphExecutionMetadata }).execution
    : undefined;
}

function isSameRootExecution(left: GraphExecutionMetadata, right: GraphExecutionMetadata): boolean {
  return left.rootRunId === right.rootRunId && left.graphRunId === right.graphRunId && left.graphId === right.graphId;
}

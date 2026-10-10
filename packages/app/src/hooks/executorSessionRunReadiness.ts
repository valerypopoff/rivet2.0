import type { ExecutorSessionRuntime } from './executorSession.js';

export const EXECUTOR_SESSION_RUN_READY_TIMEOUT_MS = 30_000;

type ExecutorSessionRuntimeState = ReturnType<ExecutorSessionRuntime['getRuntimeState']>;

/** A run binds to one ready connection, not merely a target URL that can reconnect. */
export function bindExecutorSessionRun(
  runtime: Pick<ExecutorSessionRuntime, 'getRuntimeState'>,
  captured = runtime.getRuntimeState(),
) {
  const { socket, url } = captured;
  const targetType = captured.target?.type;
  const wasReady = captured.capabilities.canSendRun;
  const isCurrent = () => {
    const current = runtime.getRuntimeState();
    return (
      wasReady &&
      socket != null &&
      current.socket === socket &&
      current.target?.type === targetType &&
      current.url === url &&
      current.capabilities.canSendRun
    );
  };
  return {
    isCurrent,
    assertCurrent: () => {
      if (!isCurrent())
        throw new Error('Executor changed while preparing the run. Run it again on the selected executor.');
    },
  };
}

export async function waitForExecutorSessionRunCapability(
  runtime: ExecutorSessionRuntime,
  timeoutMs = EXECUTOR_SESSION_RUN_READY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ExecutorSessionRuntimeState> {
  signal?.throwIfAborted();
  const initialState = runtime.getRuntimeState();
  if (initialState.capabilities.canSendRun || !isPendingRunCapabilityState(initialState)) {
    return initialState;
  }

  return await new Promise<ExecutorSessionRuntimeState>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(runtime.getRuntimeState()), timeoutMs);

    const unsubscribeConnect = runtime.subscribeLifecycle('connect', check);
    const unsubscribeDisconnect = runtime.subscribeLifecycle('disconnect', check);

    function finish(state: ExecutorSessionRuntimeState, aborted = false) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      unsubscribeConnect();
      unsubscribeDisconnect();
      signal?.removeEventListener('abort', abort);
      if (aborted) reject(signal?.reason);
      else resolve(state);
    }

    function check() {
      const state = runtime.getRuntimeState();
      if (state.capabilities.canSendRun || !isPendingRunCapabilityState(state)) {
        finish(state);
      }
    }

    function abort() {
      finish(runtime.getRuntimeState(), true);
    }

    signal?.addEventListener('abort', abort, { once: true });
    check();
  });
}

function isPendingRunCapabilityState(state: ExecutorSessionRuntimeState): boolean {
  return state.status === 'connecting' || state.status === 'reconnecting';
}

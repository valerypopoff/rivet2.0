import type { ExecutorSessionRuntime } from './executorSession.js';

export const EXECUTOR_SESSION_RUN_READY_TIMEOUT_MS = 30_000;

type ExecutorSessionRuntimeState = ReturnType<ExecutorSessionRuntime['getRuntimeState']>;

export async function waitForExecutorSessionRunCapability(
  runtime: ExecutorSessionRuntime,
  timeoutMs = EXECUTOR_SESSION_RUN_READY_TIMEOUT_MS,
): Promise<ExecutorSessionRuntimeState> {
  const initialState = runtime.getRuntimeState();
  if (initialState.capabilities.canSendRun || !isPendingRunCapabilityState(initialState)) {
    return initialState;
  }

  return await new Promise<ExecutorSessionRuntimeState>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const unsubscribeConnect = runtime.subscribeLifecycle('connect', check);
    const unsubscribeDisconnect = runtime.subscribeLifecycle('disconnect', check);

    function finish(state: ExecutorSessionRuntimeState) {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      unsubscribeConnect();
      unsubscribeDisconnect();
      resolve(state);
    }

    function check() {
      const state = runtime.getRuntimeState();
      if (state.capabilities.canSendRun || !isPendingRunCapabilityState(state)) {
        finish(state);
      }
    }

    timeout = setTimeout(() => finish(runtime.getRuntimeState()), timeoutMs);
    check();
  });
}

function isPendingRunCapabilityState(state: ExecutorSessionRuntimeState): boolean {
  return state.status === 'connecting' || state.status === 'reconnecting';
}

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
    const timeout = setTimeout(() => finish(runtime.getRuntimeState()), timeoutMs);

    const unsubscribeConnect = runtime.subscribeLifecycle('connect', check);
    const unsubscribeDisconnect = runtime.subscribeLifecycle('disconnect', check);

    function finish(state: ExecutorSessionRuntimeState) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
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

    check();
  });
}

function isPendingRunCapabilityState(state: ExecutorSessionRuntimeState): boolean {
  return state.status === 'connecting' || state.status === 'reconnecting';
}

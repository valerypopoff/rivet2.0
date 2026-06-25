import type { ExecutorSessionRuntime } from './executorSession.js';
import { attachAndStartExecutorSidecar, detachAndStopExecutorSidecar } from './useExecutorSidecar.js';
import { handleError } from '../utils/errorHandling.js';

export type ExecutorRuntimeSidecar = {
  attachAndStart: () => Promise<void>;
  detachAndStop: () => Promise<void>;
  isStarted: () => boolean;
};

const defaultExecutorRuntimeSidecar: ExecutorRuntimeSidecar = {
  attachAndStart: attachAndStartExecutorSidecar,
  detachAndStop: detachAndStopExecutorSidecar,
  isStarted: () => true,
};

const desktopSidecarConsumers = new WeakMap<object, { promise: Promise<void>; sidecar: ExecutorRuntimeSidecar }>();
const startupTokens = new WeakMap<object, symbol>();

export function createExecutorRuntimeStartupToken(runtime: object) {
  const token = Symbol('executor-runtime-startup');
  startupTokens.set(runtime, token);
  return token;
}

export function invalidateExecutorRuntimeStartup(runtime: object) {
  startupTokens.delete(runtime);
}

export function isExecutorRuntimeStartupTokenCurrent(runtime: object, token: symbol) {
  return startupTokens.get(runtime) === token;
}

export async function attachAndStartDesktopSidecarForRuntime(
  runtime: object,
  sidecar: ExecutorRuntimeSidecar = defaultExecutorRuntimeSidecar,
) {
  const existing = desktopSidecarConsumers.get(runtime);
  if (existing) {
    await existing.promise;
    return;
  }

  const promise = sidecar.attachAndStart().catch((error) => {
    if (desktopSidecarConsumers.get(runtime)?.promise === promise) {
      desktopSidecarConsumers.delete(runtime);
    }
    throw error;
  });

  desktopSidecarConsumers.set(runtime, { promise, sidecar });
  await promise;
}

export function releaseDesktopSidecarForRuntime(runtime: object, sidecar?: ExecutorRuntimeSidecar) {
  const existing = desktopSidecarConsumers.get(runtime);
  if (!existing) {
    return;
  }

  desktopSidecarConsumers.delete(runtime);
  const sidecarToDetach = sidecar ?? existing.sidecar;

  void sidecarToDetach.detachAndStop().catch((error) => {
    handleError(error, 'Executor session coordinator sidecar cleanup failed', {
      toastError: false,
    });
  });
}

export function releaseRuntimeExecutorResources(runtime: Pick<ExecutorSessionRuntime, 'disconnect'> & object) {
  invalidateExecutorRuntimeStartup(runtime);
  releaseDesktopSidecarForRuntime(runtime);
  runtime.disconnect();
}

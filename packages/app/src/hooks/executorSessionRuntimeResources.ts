import type { ExecutorSessionRuntime } from './executorSession.js';
import {
  attachAndStartExecutorSidecar,
  detachAndStopExecutorSidecar,
  executorSidecarRuntime,
  restartSharedExecutorSidecar,
} from './useExecutorSidecar.js';
import { handleError } from '../utils/errorHandling.js';

export type ExecutorRuntimeSidecar = {
  attachAndStart: () => Promise<void>;
  detachAndStop: () => Promise<void>;
  isStarted: () => boolean;
  restart?: () => Promise<void>;
};

const defaultExecutorRuntimeSidecar: ExecutorRuntimeSidecar = {
  attachAndStart: attachAndStartExecutorSidecar,
  detachAndStop: detachAndStopExecutorSidecar,
  isStarted: () => executorSidecarRuntime.started,
  restart: restartSharedExecutorSidecar,
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

  if (!sidecar.isStarted() && desktopSidecarConsumers.get(runtime)?.promise === promise) {
    desktopSidecarConsumers.delete(runtime);
  }
}

export async function releaseDesktopSidecarForRuntimeNow(runtime: object, sidecar?: ExecutorRuntimeSidecar) {
  const existing = desktopSidecarConsumers.get(runtime);
  if (!existing) {
    return false;
  }

  desktopSidecarConsumers.delete(runtime);
  const sidecarToDetach = sidecar ?? existing.sidecar;
  await sidecarToDetach.detachAndStop();
  return true;
}

export function releaseDesktopSidecarForRuntime(runtime: object, sidecar?: ExecutorRuntimeSidecar) {
  void releaseDesktopSidecarForRuntimeNow(runtime, sidecar).catch((error) => {
    handleError(error, 'Executor session coordinator sidecar cleanup failed', {
      toastError: false,
    });
  });
}

export async function restartDesktopSidecarForRuntime(
  runtime: object,
  sidecar: ExecutorRuntimeSidecar = defaultExecutorRuntimeSidecar,
) {
  const existing = desktopSidecarConsumers.get(runtime);
  if (!existing) {
    await attachAndStartDesktopSidecarForRuntime(runtime, sidecar);
    return;
  }

  const sidecarToRestart = existing.sidecar;
  if (!sidecarToRestart.restart) {
    await releaseDesktopSidecarForRuntimeNow(runtime, sidecarToRestart);
    await attachAndStartDesktopSidecarForRuntime(runtime, sidecarToRestart);
    return;
  }

  // Restart preserves this runtime's sidecar consumer ownership. If startup fails,
  // keep the ownership marker so a retry cannot double-count the shared sidecar.
  await sidecarToRestart.restart();
}

export function releaseRuntimeExecutorResources(runtime: Pick<ExecutorSessionRuntime, 'disconnect'> & object) {
  invalidateExecutorRuntimeStartup(runtime);
  releaseDesktopSidecarForRuntime(runtime);
  runtime.disconnect();
}

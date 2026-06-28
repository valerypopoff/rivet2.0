import {
  attachExecutorSidecarConsumer,
  createExecutorSidecarRuntimeState,
  detachExecutorSidecarConsumer,
  forceStopExecutorSidecarForPageUnload,
  restartExecutorSidecar,
  startExecutorSidecar,
  stopExecutorSidecar,
} from './executorSidecarRuntime.js';
import { registerTauriPageUnloadCleanup } from '../utils/platform/tauriCleanup.js';

export const executorSidecarRuntime = createExecutorSidecarRuntimeState();
let unregisterPageUnloadCleanup: (() => void) | undefined;

function ensureExecutorSidecarPageUnloadCleanup() {
  unregisterPageUnloadCleanup ??= registerTauriPageUnloadCleanup(() => {
    forceStopExecutorSidecarForPageUnload(executorSidecarRuntime);
  });
}

export async function attachAndStartExecutorSidecar() {
  ensureExecutorSidecarPageUnloadCleanup();
  attachExecutorSidecarConsumer(executorSidecarRuntime);
  await startExecutorSidecar(executorSidecarRuntime);

  if (!executorSidecarRuntime.started) {
    detachExecutorSidecarConsumer(executorSidecarRuntime);
    await stopExecutorSidecar(executorSidecarRuntime);
    throw new Error('Executor sidecar did not start.');
  }
}

export async function detachAndStopExecutorSidecar() {
  detachExecutorSidecarConsumer(executorSidecarRuntime);
  await stopExecutorSidecar(executorSidecarRuntime);
}

export async function restartSharedExecutorSidecar() {
  await restartExecutorSidecar(executorSidecarRuntime);
  if (executorSidecarRuntime.consumerCount > 0 && !executorSidecarRuntime.started) {
    throw new Error('Executor sidecar did not restart.');
  }
}

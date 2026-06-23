import {
  attachExecutorSidecarConsumer,
  createExecutorSidecarRuntimeState,
  detachExecutorSidecarConsumer,
  forceStopExecutorSidecarForPageUnload,
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
}

export async function detachAndStopExecutorSidecar() {
  detachExecutorSidecarConsumer(executorSidecarRuntime);
  await stopExecutorSidecar(executorSidecarRuntime);
}

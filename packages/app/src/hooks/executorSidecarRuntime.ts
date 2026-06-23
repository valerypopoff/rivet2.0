import { logRuntimeDebug } from '@valerypopoff/rivet2-core';
import { type NativeChildProcess } from '../utils/platform/core.js';
import { createNativeSidecarCommand } from '../utils/platform/shell.js';
import { handleError } from '../utils/errorHandling.js';

const EXECUTOR_READY_MESSAGE = 'Rivet app executor websocket listening';
const EXECUTOR_READY_TIMEOUT_MS = 5000;

export type ExecutorSidecarRuntimeState = {
  started: boolean;
  process: NativeChildProcess | null;
  startPromise: Promise<void> | null;
  consumerCount: number;
  streamCleanup: (() => void) | null;
  lifecycleGeneration: number;
};

export function createExecutorSidecarRuntimeState(): ExecutorSidecarRuntimeState {
  return {
    started: false,
    process: null,
    startPromise: null,
    consumerCount: 0,
    streamCleanup: null,
    lifecycleGeneration: 0,
  };
}

function detachDataStreamListener(
  stream: { off?: NativeDataStreamOff; removeAllListeners?: (event?: 'data') => void; removeListener?: NativeDataStreamOff },
  handler: (data: string) => void,
) {
  if (stream.off) {
    stream.off('data', handler);
  } else if (stream.removeListener) {
    stream.removeListener('data', handler);
  } else {
    stream.removeAllListeners?.('data');
  }
}

type NativeDataStreamOff = (event: 'data', handler: (data: string) => void) => void;

function cleanupExecutorSidecarStreams(runtime: ExecutorSidecarRuntimeState, streamCleanup = runtime.streamCleanup) {
  streamCleanup?.();

  if (runtime.streamCleanup === streamCleanup) {
    runtime.streamCleanup = null;
  }
}

export async function startExecutorSidecar(
  runtime: ExecutorSidecarRuntimeState,
  createSidecarCommand: typeof createNativeSidecarCommand = createNativeSidecarCommand,
  options: { readyTimeoutMs?: number } = {},
) {
  let ownedStartPromise: Promise<void> | null = null;

  try {
    if (runtime.started) {
      return;
    }

    if (runtime.startPromise) {
      await runtime.startPromise;
      return;
    }

    ownedStartPromise = (async () => {
      const lifecycleGeneration = runtime.lifecycleGeneration;
      logRuntimeDebug('Starting executor sidecar.', {
        consumerCount: runtime.consumerCount,
      });

      const command = await createSidecarCommand('../../app-executor/dist/app-executor');
      const ready = createExecutorReadySignal(options.readyTimeoutMs ?? EXECUTOR_READY_TIMEOUT_MS);

      try {
        const handleStdout = (data: string) => {
          const text = String(data);
          logRuntimeDebug('Executor sidecar stdout', {
            byteLength: text.length,
          });
          ready.accept(text);
        };

        const handleStderr = (data: string) => {
          const text = String(data);
          logRuntimeDebug('Executor sidecar stderr', {
            byteLength: text.length,
          });
        };

        const streamCleanup = () => {
          detachDataStreamListener(command.stdout, handleStdout);
          detachDataStreamListener(command.stderr, handleStderr);
        };

        command.stdout.on('data', handleStdout);
        command.stderr.on('data', handleStderr);
        cleanupExecutorSidecarStreams(runtime);
        runtime.streamCleanup = streamCleanup;

        const proc = await command.spawn();

        if (runtime.lifecycleGeneration !== lifecycleGeneration) {
          ready.dispose();
          cleanupExecutorSidecarStreams(runtime, streamCleanup);
          await proc.kill();
          return;
        }

        runtime.process = proc;
        const readyReason = await ready.promise;

        if (runtime.lifecycleGeneration !== lifecycleGeneration) {
          if (runtime.process === proc) {
            runtime.process = null;
            runtime.started = false;
            await proc.kill();
          }

          cleanupExecutorSidecarStreams(runtime, streamCleanup);
          return;
        }

        runtime.started = true;
        logRuntimeDebug('Executor sidecar startup gate passed.', {
          readyReason,
          consumerCount: runtime.consumerCount,
        });

        if (runtime.consumerCount === 0 && runtime.process) {
          const proc = runtime.process;
          runtime.process = null;
          runtime.started = false;
          logRuntimeDebug('Stopping executor sidecar immediately because no consumers remain.');
          cleanupExecutorSidecarStreams(runtime);
          await proc.kill();
        }
      } catch (error) {
        ready.dispose();
        throw error;
      }
    })();

    runtime.startPromise = ownedStartPromise;
    await ownedStartPromise;
    if (runtime.startPromise === ownedStartPromise) {
      runtime.startPromise = null;
    }
  } catch (error) {
    if (runtime.startPromise === ownedStartPromise || runtime.startPromise == null) {
      runtime.startPromise = null;
      runtime.started = false;
      runtime.process = null;
      cleanupExecutorSidecarStreams(runtime);
    }
    handleError(error, 'Failed to start executor sidecar', {
      metadata: {
        consumerCount: runtime.consumerCount,
      },
      toastError: false,
    });
  }
}

export async function stopExecutorSidecar(runtime: ExecutorSidecarRuntimeState) {
  if (runtime.consumerCount > 0) {
    return;
  }

  if (runtime.startPromise) {
    await runtime.startPromise;
    if (runtime.consumerCount > 0) {
      return;
    }
  }

  const proc = runtime.process;
  runtime.process = null;
  runtime.started = false;
  cleanupExecutorSidecarStreams(runtime);

  if (proc) {
    logRuntimeDebug('Stopping executor sidecar.', {
      consumerCount: runtime.consumerCount,
    });
    await proc.kill();
  }
}

export function forceStopExecutorSidecarForPageUnload(runtime: ExecutorSidecarRuntimeState) {
  runtime.lifecycleGeneration += 1;
  runtime.consumerCount = 0;
  runtime.startPromise = null;
  const proc = runtime.process;
  runtime.process = null;
  runtime.started = false;
  cleanupExecutorSidecarStreams(runtime);

  if (proc) {
    void Promise.resolve(proc.kill()).catch((error) => {
      handleError(error, 'Failed to stop executor sidecar during page unload', {
        toastError: false,
      });
    });
  }
}

export function attachExecutorSidecarConsumer(runtime: ExecutorSidecarRuntimeState) {
  runtime.consumerCount += 1;
}

export function detachExecutorSidecarConsumer(runtime: ExecutorSidecarRuntimeState) {
  runtime.consumerCount = Math.max(0, runtime.consumerCount - 1);
}

function createExecutorReadySignal(timeoutMs: number) {
  let stdoutBuffer = '';
  let resolveReady!: (reason: 'ready-marker' | 'timeout') => void;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<'ready-marker' | 'timeout'>((resolve) => {
    resolveReady = (reason) => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      resolve(reason);
    };

    timeout = setTimeout(() => resolveReady('timeout'), timeoutMs);
  });

  return {
    promise,
    accept(text: string) {
      stdoutBuffer = `${stdoutBuffer}${text}`.slice(-4096);
      if (stdoutBuffer.includes(EXECUTOR_READY_MESSAGE)) {
        resolveReady('ready-marker');
      }
    },
    dispose() {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    },
  };
}

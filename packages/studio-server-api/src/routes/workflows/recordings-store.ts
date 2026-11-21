import { setImmediate as yieldToIo } from 'node:timers/promises';
import { isWorkflowRecordingEnabled, runRecordingsSettingsRepository } from './recordings-config.js';
import { recordStudioMetrics } from '../../metrics.js';
import { runOutsideAppSettingsSnapshot } from '../../app-settings/settings-repository.js';
import { reportRecordingFailure, type RecordingDiagnosticContext } from './recording-diagnostics.js';

type WorkflowRecordingPersistenceTask = () => Promise<void>;

export type RecordingQueueAdmission = {
  deferredCapture?: boolean;
  /** An existing run-evidence handle keeps its accepted capture when recording is switched off. */
  acceptedEvidence?: boolean;
  /** Runs when accepted work settles or is cancelled before start. The caller owns rejected work. */
  finalize?: () => void;
};

type QueuePolicySnapshot = { path: string; value: { readonly maxPendingWrites: number } };
type QueuePolicySource = {
  descriptor: { getPath(): string };
  read(): Promise<QueuePolicySnapshot>;
  subscribe(listener: (snapshot: QueuePolicySnapshot) => void): () => void;
};

export type WorkflowRecordingPersistenceMetrics = Readonly<{
  activeWrites: number;
  maxPendingWrites: number | null;
  pendingWrites: number;
}>;

const PERSISTENCE_DROP_LOG_INTERVAL_MS = 60_000;

export function createWorkflowRecordingStore(options: {
  rebuildIndex(root: string): Promise<void>;
  cleanupStorage(): Promise<void>;
  setSchemaVersion(version: string): Promise<void>;
  resetDatabaseForTests(): Promise<void>;
  /** Explicit validated policy for standalone/offline users of the queue. */
  maxPendingWrites?: number;
}) {
  let storageReadyPromise: Promise<void> | null = null;
  let storageReadyRoot = '';
  let cleanupPromise: Promise<void> | null = null;
  let cleanupRequested = false;
  let persistenceQueue: Array<{
    run: WorkflowRecordingPersistenceTask;
    context?: RecordingDiagnosticContext;
    retainedBytes: number;
    finalize?: () => void;
  }> = [];
  let retainedBytes = 0;
  const maxRetainedBytes = 256 * 1024 * 1024;
  let persistenceQueuePromise: Promise<void> | null = null;
  let persistenceQueueStartImmediate: ReturnType<typeof setImmediate> | null = null;
  let lastDroppedPersistenceLogAt = 0;
  let resettingWorkflowRecordingStorageForTests = false;
  let maxPendingWrites = options.maxPendingWrites;
  let policyBinding:
    | {
        source: QueuePolicySource;
        path: string;
        initialization?: Promise<void>;
        unsubscribe(): void;
      }
    | undefined;

  const validateLimit = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid recording queue limit.');
    return value;
  };
  if (maxPendingWrites !== undefined) validateLimit(maxPendingWrites);
  const getQueueLimit = (): number => {
    if (maxPendingWrites === undefined) throw new Error('Recording persistence queue policy is not initialized.');
    return maxPendingWrites;
  };
  const disposeQueuePolicy = (): void => {
    const previous = policyBinding;
    policyBinding = undefined;
    maxPendingWrites = undefined;
    previous?.unsubscribe();
  };
  const initializeQueuePolicy = (source: QueuePolicySource = runRecordingsSettingsRepository): Promise<void> => {
    const sourcePath = source.descriptor.getPath();
    if (policyBinding) {
      if (policyBinding.source !== source || policyBinding.path !== sourcePath)
        return Promise.reject(new Error('Dispose the previous recording queue policy before changing its owner.'));
      return policyBinding.initialization!;
    }
    const binding = {
      source,
      path: sourcePath,
      unsubscribe: () => {},
      initialization: undefined as Promise<void> | undefined,
    };
    policyBinding = binding;
    maxPendingWrites = undefined;
    let latest: number | undefined;
    let initialized = false;
    try {
      binding.unsubscribe = source.subscribe((snapshot) => {
        if (policyBinding !== binding || snapshot.path !== binding.path) return;
        latest = validateLimit(snapshot.value.maxPendingWrites);
        if (initialized) maxPendingWrites = latest;
      });
    } catch (error) {
      disposeQueuePolicy();
      return Promise.reject(error);
    }
    binding.initialization = (async () => {
      try {
        const snapshot = await runOutsideAppSettingsSnapshot(() => source.read());
        if (policyBinding !== binding) throw new Error('Recording queue policy initialization was disposed.');
        if (snapshot.path !== binding.path)
          throw new Error('Recording queue policy source changed during initialization.');
        // A newer notification can arrive before this initial read resolves.
        maxPendingWrites = latest ?? validateLimit(snapshot.value.maxPendingWrites);
        initialized = true;
      } catch (error) {
        if (policyBinding === binding) disposeQueuePolicy();
        throw error;
      }
    })();
    return binding.initialization;
  };

  const scheduleWorkflowRecordingCleanup = (): void => {
    if (resettingWorkflowRecordingStorageForTests) {
      return;
    }

    cleanupRequested = true;

    if (cleanupPromise) {
      return;
    }

    cleanupPromise = (async () => {
      while (cleanupRequested) {
        cleanupRequested = false;
        await options.cleanupStorage();
      }
    })()
      .catch((error) => {
        reportRecordingFailure(error, { phase: 'cleanup' });
      })
      .finally(() => {
        const shouldRunAgain = cleanupRequested;
        cleanupPromise = null;

        if (shouldRunAgain) {
          scheduleWorkflowRecordingCleanup();
        }
      });
  };

  const logDroppedWorkflowRecordingPersistence = (
    maxPendingWrites: number,
    context?: RecordingDiagnosticContext,
  ): void => {
    const now = Date.now();
    if (now - lastDroppedPersistenceLogAt < PERSISTENCE_DROP_LOG_INTERVAL_MS) {
      return;
    }

    lastDroppedPersistenceLogAt = now;
    try {
      console.warn(
        `[workflow-recordings] Dropping recording persistence because the queue is full (${maxPendingWrites} pending writes). ` +
          'Workflow execution continues normally.',
      );
    } catch {
      // Overload reporting must not turn a rejected recording into a graph failure.
    }
    reportRecordingFailure(undefined, { ...context, phase: 'admission' });
  };

  const getPendingPersistenceWriteCount = (): number => {
    return Math.max(0, persistenceQueue.length - (persistenceQueueStartImmediate ? 1 : 0));
  };

  const getPersistenceMetrics = (): WorkflowRecordingPersistenceMetrics => {
    return Object.freeze({
      activeWrites: persistenceQueuePromise ? 1 : 0,
      // Offline maintenance and scrapes can observe work before serving starts.
      // Absence of policy must not hide accepted work or open admission.
      maxPendingWrites: maxPendingWrites ?? null,
      pendingWrites: persistenceQueue.length,
    });
  };

  const runWorkflowRecordingPersistenceQueue = (): void => {
    persistenceQueueStartImmediate = null;
    if (persistenceQueuePromise) {
      return;
    }

    persistenceQueuePromise = (async () => {
      while (persistenceQueue.length > 0) {
        const task = persistenceQueue.shift();
        if (!task) {
          continue;
        }

        try {
          await task.run();
        } catch (error) {
          recordStudioMetrics((metrics) => metrics.recordWorkflowRecordingPersistenceFailure());
          reportRecordingFailure(error, { phase: 'persistence', ...task.context });
        } finally {
          retainedBytes = Math.max(0, retainedBytes - task.retainedBytes);
          try {
            task.finalize?.();
          } catch {
            /* Cleanup cannot stop the next recording. */
          }
        }
        // A previous storage wait may have finished before newly-ready request
        // I/O. Give it a fresh turn before starting another recording's CPU work.
        if (persistenceQueue.length > 0) await yieldToIo();
      }
    })().finally(() => {
      persistenceQueuePromise = null;

      if (persistenceQueue.length > 0) {
        scheduleWorkflowRecordingPersistenceQueue();
      }
    });
  };

  const scheduleWorkflowRecordingPersistenceQueue = (): void => {
    if (persistenceQueuePromise || persistenceQueueStartImmediate) {
      return;
    }

    persistenceQueueStartImmediate = setImmediate(runWorkflowRecordingPersistenceQueue);
  };

  const flushWorkflowRecordingStore = async (): Promise<void> => {
    while (persistenceQueueStartImmediate || persistenceQueuePromise || persistenceQueue.length > 0) {
      if (persistenceQueueStartImmediate) {
        clearImmediate(persistenceQueueStartImmediate);
        persistenceQueueStartImmediate = null;
        runWorkflowRecordingPersistenceQueue();
      } else if (!persistenceQueuePromise && persistenceQueue.length > 0) {
        runWorkflowRecordingPersistenceQueue();
      }

      await persistenceQueuePromise;
    }

    while (cleanupPromise || cleanupRequested) {
      if (!cleanupPromise && cleanupRequested) {
        scheduleWorkflowRecordingCleanup();
      }
      await cleanupPromise;
    }
  };

  return {
    scheduleCleanup: scheduleWorkflowRecordingCleanup,
    flush: flushWorkflowRecordingStore,
    getPersistenceMetrics,
    initializeQueuePolicy,
    disposeQueuePolicy,

    enqueuePersistence(
      task: WorkflowRecordingPersistenceTask,
      context?: RecordingDiagnosticContext,
      payloadBytes = 0,
      admission: RecordingQueueAdmission = {},
    ): boolean {
      if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) throw new Error('Invalid retained recording bytes.');
      if ((!admission.acceptedEvidence && !isWorkflowRecordingEnabled()) || resettingWorkflowRecordingStorageForTests) {
        return false;
      }

      const limit = getQueueLimit();
      const effectiveLimit = limit || (admission.deferredCapture ? 64 : 0);
      if (
        (effectiveLimit > 0 && getPendingPersistenceWriteCount() >= effectiveLimit) ||
        retainedBytes + payloadBytes > maxRetainedBytes
      ) {
        recordStudioMetrics((metrics) => metrics.recordWorkflowRecordingPersistenceDrop());
        logDroppedWorkflowRecordingPersistence(effectiveLimit, context);
        return false;
      }

      retainedBytes += payloadBytes;
      persistenceQueue.push({ run: task, context, retainedBytes: payloadBytes, finalize: admission.finalize });
      scheduleWorkflowRecordingPersistenceQueue();
      return true;
    },

    async ensureStorage(root: string, storageOptions?: { skipCleanup?: boolean }): Promise<void> {
      if (storageReadyPromise && storageReadyRoot === root) {
        return storageReadyPromise;
      }

      storageReadyRoot = root;
      storageReadyPromise = (async () => {
        await options.rebuildIndex(root);
        await options.setSchemaVersion('2');
        // Keep startup cleanup ordered before new writes so retention cannot
        // race their post-save holds. Its failure does not invalidate the index.
        if (!storageOptions?.skipCleanup) {
          try {
            await options.cleanupStorage();
          } catch (error) {
            reportRecordingFailure(error, { phase: 'cleanup' });
          }
        }
      })();

      try {
        await storageReadyPromise;
      } catch (error) {
        storageReadyPromise = null;
        storageReadyRoot = '';
        throw error;
      }
    },

    async resetForTests(): Promise<void> {
      resettingWorkflowRecordingStorageForTests = true;
      disposeQueuePolicy();

      const pendingPersistence = persistenceQueuePromise;
      const pendingCleanup = cleanupPromise;
      const pendingPersistenceStartImmediate = persistenceQueueStartImmediate;

      storageReadyPromise = null;
      storageReadyRoot = '';
      cleanupPromise = null;
      cleanupRequested = false;
      persistenceQueuePromise = null;
      persistenceQueueStartImmediate = null;
      const discarded = persistenceQueue;
      persistenceQueue = [];
      for (const task of discarded) {
        try {
          task.finalize?.();
        } catch {
          /* Complete disposal of the remaining jobs. */
        }
      }
      discarded.length = 0;
      lastDroppedPersistenceLogAt = 0;
      if (pendingPersistenceStartImmediate) {
        clearImmediate(pendingPersistenceStartImmediate);
      }

      try {
        await pendingPersistence?.catch(() => {});
        await pendingCleanup?.catch(() => {});
        await options.resetDatabaseForTests();
      } finally {
        retainedBytes = 0;
        resettingWorkflowRecordingStorageForTests = false;
      }
    },
  };
}

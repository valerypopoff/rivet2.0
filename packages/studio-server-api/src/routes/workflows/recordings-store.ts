import { getWorkflowRecordingConfig, isWorkflowRecordingEnabled } from './recordings-config.js';
import { recordStudioMetrics } from '../../metrics.js';

type WorkflowRecordingPersistenceTask = () => Promise<void>;

export type WorkflowRecordingPersistenceMetrics = Readonly<{
  activeWrites: number;
  maxPendingWrites: number;
  pendingWrites: number;
}>;

const PERSISTENCE_DROP_LOG_INTERVAL_MS = 60_000;

export function createWorkflowRecordingStore(options: {
  rebuildIndex(root: string): Promise<void>;
  cleanupStorage(): Promise<void>;
  setSchemaVersion(version: string): Promise<void>;
  resetDatabaseForTests(): Promise<void>;
}) {
  let storageReadyPromise: Promise<void> | null = null;
  let storageReadyRoot = '';
  let cleanupPromise: Promise<void> | null = null;
  let cleanupRequested = false;
  let persistenceQueue: WorkflowRecordingPersistenceTask[] = [];
  let persistenceQueuePromise: Promise<void> | null = null;
  let persistenceQueueStartImmediate: ReturnType<typeof setImmediate> | null = null;
  let lastDroppedPersistenceLogAt = 0;
  let resettingWorkflowRecordingStorageForTests = false;

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
        console.error('[workflow-recordings] Cleanup failed:', error);
      })
      .finally(() => {
        const shouldRunAgain = cleanupRequested;
        cleanupPromise = null;

        if (shouldRunAgain) {
          scheduleWorkflowRecordingCleanup();
        }
      });
  };

  const logDroppedWorkflowRecordingPersistence = (maxPendingWrites: number): void => {
    const now = Date.now();
    if (now - lastDroppedPersistenceLogAt < PERSISTENCE_DROP_LOG_INTERVAL_MS) {
      return;
    }

    lastDroppedPersistenceLogAt = now;
    console.warn(
      `[workflow-recordings] Dropping recording persistence because the queue is full (${maxPendingWrites} pending writes). ` +
        'Workflow execution continues normally.',
    );
  };

  const getPendingPersistenceWriteCount = (): number => {
    return Math.max(0, persistenceQueue.length - (persistenceQueueStartImmediate ? 1 : 0));
  };

  const getPersistenceMetrics = (): WorkflowRecordingPersistenceMetrics => {
    const { maxPendingWrites } = getWorkflowRecordingConfig();
    return Object.freeze({
      activeWrites: persistenceQueuePromise ? 1 : 0,
      maxPendingWrites,
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
          await task();
        } catch (error) {
          recordStudioMetrics((metrics) => metrics.recordWorkflowRecordingPersistenceFailure());
          console.error('[workflow-recordings] Failed to persist queued recording:', error);
        }
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

    enqueuePersistence(task: WorkflowRecordingPersistenceTask): boolean {
      if (!isWorkflowRecordingEnabled() || resettingWorkflowRecordingStorageForTests) {
        return false;
      }

      const { maxPendingWrites } = getWorkflowRecordingConfig();
      if (maxPendingWrites > 0 && getPendingPersistenceWriteCount() >= maxPendingWrites) {
        recordStudioMetrics((metrics) => metrics.recordWorkflowRecordingPersistenceDrop());
        logDroppedWorkflowRecordingPersistence(maxPendingWrites);
        return false;
      }

      persistenceQueue.push(task);
      scheduleWorkflowRecordingPersistenceQueue();
      return true;
    },

    async ensureStorage(root: string): Promise<void> {
      if (storageReadyPromise && storageReadyRoot === root) {
        return storageReadyPromise;
      }

      storageReadyRoot = root;
      storageReadyPromise = (async () => {
        await options.rebuildIndex(root);
        await options.cleanupStorage();
        await options.setSchemaVersion('2');
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

      const pendingPersistence = persistenceQueuePromise;
      const pendingCleanup = cleanupPromise;
      const pendingPersistenceStartImmediate = persistenceQueueStartImmediate;

      storageReadyPromise = null;
      storageReadyRoot = '';
      cleanupPromise = null;
      cleanupRequested = false;
      persistenceQueuePromise = null;
      persistenceQueueStartImmediate = null;
      persistenceQueue = [];
      lastDroppedPersistenceLogAt = 0;
      if (pendingPersistenceStartImmediate) {
        clearImmediate(pendingPersistenceStartImmediate);
      }

      try {
        await pendingPersistence?.catch(() => {});
        await pendingCleanup?.catch(() => {});
        await options.resetDatabaseForTests();
      } finally {
        resettingWorkflowRecordingStorageForTests = false;
      }
    },
  };
}

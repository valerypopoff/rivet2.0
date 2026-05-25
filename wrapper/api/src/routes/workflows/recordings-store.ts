import { getWorkflowRecordingConfig, isWorkflowRecordingEnabled } from './recordings-config.js';

type WorkflowRecordingPersistenceTask = () => Promise<void>;

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

  return {
    scheduleCleanup: scheduleWorkflowRecordingCleanup,

    enqueuePersistence(task: WorkflowRecordingPersistenceTask): boolean {
      if (!isWorkflowRecordingEnabled() || resettingWorkflowRecordingStorageForTests) {
        return false;
      }

      const { maxPendingWrites } = getWorkflowRecordingConfig();
      if (maxPendingWrites > 0 && getPendingPersistenceWriteCount() >= maxPendingWrites) {
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

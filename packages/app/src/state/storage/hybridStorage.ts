import { getError } from '@valerypopoff/rivet2-core';
import type { SyncStorage } from 'jotai/vanilla/utils/atomWithStorage';
import { debounce, type DebouncedFunc } from 'lodash-es';
import { createDefaultAsyncStorage, type AsyncStorageBackend } from './indexedDB';
import { handleError } from '../../utils/errorHandling.js';
import { initializeHybridStorage, memoryStorage } from './migrations';
import { WorkspaceRecoveryStorage, workspaceRecoveryGroups, validateRecoveryGroups } from './workspaceRecovery.js';

export const allInitializeStoreFns = new Set<(isCurrent?: () => boolean) => Promise<void>>();
const builtInAsyncStorage = createDefaultAsyncStorage();
const recoveryBackends = new WeakMap<AsyncStorageBackend, WorkspaceRecoveryStorage>();
function withWorkspaceRecovery(backend: AsyncStorageBackend): WorkspaceRecoveryStorage {
  if (backend instanceof WorkspaceRecoveryStorage) return backend;
  let recovery = recoveryBackends.get(backend);
  if (!recovery) {
    let session: Storage | undefined;
    let sessionUnavailable = false;
    try {
      session = typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
    } catch {
      sessionUnavailable = true;
    }
    recovery = new WorkspaceRecoveryStorage(
      backend,
      () =>
        Object.fromEntries(
          [...workspaceRecoveryGroups].flatMap((key) =>
            memoryStorage.has(key) ? [[key, memoryStorage.get(key)]] : [],
          ),
        ),
      {
        session,
        sessionUnavailable,
        resolveSession: () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage),
      },
    );
    recoveryBackends.set(backend, recovery);
  }
  return recovery;
}
let defaultAsyncStorage = withWorkspaceRecovery(builtInAsyncStorage);
export const getWorkspaceRecoveryStorage = (): WorkspaceRecoveryStorage => defaultAsyncStorage;

type HybridStorageOptions = {
  debounceMs?: number;
};

type GroupedStorageController = {
  asyncStorage: AsyncStorageBackend;
  debounceMs: number;
  debouncedSave?: DebouncedFunc<(value: any) => Promise<void>>;
  pendingSave: Promise<void>;
  queueSave: (value: any) => Promise<void>;
  saveNow: (value: any) => Promise<void>;
};

const groupedStorageControllers = new Map<string, GroupedStorageController>();
const groupedInitializeControllers = new Map<
  string,
  {
    asyncStorage: AsyncStorageBackend;
    initialize: (isCurrent?: () => boolean) => Promise<void>;
  }
>();

function createDebouncedSave(
  controller: GroupedStorageController,
  debounceMs: number,
): DebouncedFunc<(value: any) => Promise<void>> | undefined {
  if (debounceMs <= 0) {
    return undefined;
  }

  return debounce(async (value: any) => {
    await controller.saveNow(value).catch(() => undefined);
  }, debounceMs);
}

function persistGroupedSnapshot(controller: GroupedStorageController, value: any): void {
  if (controller.debouncedSave) {
    controller.debouncedSave(value);
  } else {
    void controller.saveNow(value).catch(() => undefined);
  }
}

function getOrCreateGroupedStorageController(
  mainKey: string,
  asyncStorage: AsyncStorageBackend,
  debounceMs: number,
): GroupedStorageController {
  const existing = groupedStorageControllers.get(mainKey);
  if (existing) {
    existing.asyncStorage = asyncStorage;
    if (existing.debounceMs !== debounceMs) {
      existing.debouncedSave?.cancel();
      existing.debounceMs = debounceMs;
      existing.debouncedSave = createDebouncedSave(existing, debounceMs);
    }
    return existing;
  }

  const controller: GroupedStorageController = {
    asyncStorage,
    debounceMs,
    pendingSave: Promise.resolve(),
    queueSave: async (value: any) => {
      const backend = controller.asyncStorage;
      let serializedValue: string;
      try {
        // Recovery captures and validates the complete workspace itself. The
        // per-group argument is ignored there; serializing it first duplicates
        // all open project bodies on every checkpoint/explicit project open.
        serializedValue =
          backend instanceof WorkspaceRecoveryStorage && workspaceRecoveryGroups.has(mainKey)
            ? '{}'
            : JSON.stringify(value);
      } catch (error) {
        if (backend instanceof WorkspaceRecoveryStorage) backend.failed();
        handleError(error, 'Failed to serialize browser recovery', {
          toastError: !workspaceRecoveryGroups.has(mainKey),
        });
        throw error;
      }
      const saveOperation = async () => {
        try {
          await backend.setItem(mainKey, serializedValue);
        } catch (error) {
          handleError(error, 'Failed to save persistent storage item', {
            toastError: !workspaceRecoveryGroups.has(mainKey),
            metadata: {
              key: mainKey,
            },
          });
          throw error;
        }
      };

      // Recovery owns an envelope-wide queue. Invoke it now to capture this
      // workspace/backend generation, not later after another group's IO.
      controller.pendingSave =
        backend instanceof WorkspaceRecoveryStorage && workspaceRecoveryGroups.has(mainKey)
          ? saveOperation()
          : controller.pendingSave.then(saveOperation, saveOperation);
      await controller.pendingSave;
    },
    saveNow: async (value: any) => {
      await controller.queueSave(value);
    },
    debouncedSave: undefined,
  };
  controller.debouncedSave = createDebouncedSave(controller, debounceMs);

  groupedStorageControllers.set(mainKey, controller);
  return controller;
}

export async function flushHybridStorageGroup(mainKey: string): Promise<void> {
  const controller = groupedStorageControllers.get(mainKey);
  if (!controller) {
    return;
  }

  controller.debouncedSave?.cancel();

  const value = memoryStorage.get(mainKey);
  if (value === undefined) {
    return;
  }

  await controller.saveNow(value);
}

export async function flushWorkspaceRecovery(): Promise<void> {
  for (const key of workspaceRecoveryGroups) groupedStorageControllers.get(key)?.debouncedSave?.cancel();
  // One envelope includes all workspace groups, regardless of which changed.
  await defaultAsyncStorage.setItem('project', '{}');
}

export async function initializeWorkspaceRecovery(isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) return;
  const groups = Object.fromEntries(
    [...workspaceRecoveryGroups].flatMap((key) => (memoryStorage.has(key) ? [[key, memoryStorage.get(key)]] : [])),
  );
  validateRecoveryGroups(groups);
  // Legacy import must commit and read back the complete envelope before the
  // editor mounts. Interrupted imports retain all original records for retry.
  if (!defaultAsyncStorage.hasSelectedCheckpoint && Object.keys(groups).length > 0) await flushWorkspaceRecovery();
}

function registerInitializeStoreFn(mainKey: string | undefined, asyncStorage: AsyncStorageBackend): void {
  if (!mainKey) {
    allInitializeStoreFns.add(async (isCurrent) => initializeHybridStorage(mainKey, asyncStorage, isCurrent));
    return;
  }

  const existing = groupedInitializeControllers.get(mainKey);
  if (existing) {
    existing.asyncStorage = asyncStorage;
    return;
  }

  const controller = {
    asyncStorage,
    initialize: async (isCurrent: () => boolean = () => true) => {
      const backend = controller.asyncStorage;
      await initializeHybridStorage(mainKey, backend, () => isCurrent() && controller.asyncStorage === backend);
    },
  };

  groupedInitializeControllers.set(mainKey, controller);
  allInitializeStoreFns.add(controller.initialize);
}

export function configureHybridStorageBackend(asyncStorage: AsyncStorageBackend | undefined): AsyncStorageBackend {
  const previousAsyncStorage = defaultAsyncStorage;
  const nextAsyncStorage = withWorkspaceRecovery(asyncStorage ?? builtInAsyncStorage);

  if (nextAsyncStorage === defaultAsyncStorage) {
    return previousAsyncStorage;
  }

  previousAsyncStorage.setSelected(false);
  nextAsyncStorage.setSelected(true);
  defaultAsyncStorage = nextAsyncStorage;

  for (const controller of groupedStorageControllers.values()) {
    controller.debouncedSave?.cancel();
    controller.asyncStorage = nextAsyncStorage;
  }

  for (const controller of groupedInitializeControllers.values()) {
    controller.asyncStorage = nextAsyncStorage;
  }

  return previousAsyncStorage;
}

export const createHybridStorage = (
  mainKey?: string,
  asyncStorage: AsyncStorageBackend = defaultAsyncStorage,
  options: HybridStorageOptions = {},
): {
  storage: SyncStorage<any>;
} => {
  const groupedController = mainKey
    ? getOrCreateGroupedStorageController(mainKey, asyncStorage, options.debounceMs ?? 1000)
    : undefined;

  const storage: SyncStorage<any> = {
    getItem: (key, initialValue) => {
      if (!mainKey) {
        return memoryStorage.get(key) ?? initialValue;
      }

      const mainObject = memoryStorage.get(mainKey) ?? {};
      return mainObject[key] ?? initialValue;
    },
    setItem: (key, value): void => {
      try {
        if (!mainKey) {
          memoryStorage.set(key, value);
          void asyncStorage.setItem(key, JSON.stringify(value)).catch((error) => {
            handleError(error, 'Failed to save persistent storage item', {
              metadata: {
                key,
              },
            });
          });
          return;
        }

        const mainObject = memoryStorage.get(mainKey) ?? {};
        mainObject[key] = value;
        memoryStorage.set(mainKey, mainObject);
        if (
          workspaceRecoveryGroups.has(mainKey) &&
          groupedController!.asyncStorage instanceof WorkspaceRecoveryStorage
        ) {
          groupedController!.asyncStorage.changed();
        }
        persistGroupedSnapshot(groupedController!, mainObject);
      } catch (error) {
        handleError(error, 'Failed to update in-memory storage item', {
          metadata: {
            key,
            mainKey,
            normalizedError: getError(error).message,
          },
        });
      }
    },
    removeItem: (key): void => {
      if (!mainKey) {
        memoryStorage.delete(key);
        asyncStorage.removeItem(key).catch((error) => {
          handleError(error, 'Failed to remove persistent storage item', {
            metadata: {
              key,
            },
            toastError: false,
          });
        });
        return;
      }

      const mainObject = memoryStorage.get(mainKey) ?? {};
      delete mainObject[key];
      memoryStorage.set(mainKey, mainObject);
      if (workspaceRecoveryGroups.has(mainKey) && groupedController!.asyncStorage instanceof WorkspaceRecoveryStorage) {
        groupedController!.asyncStorage.changed();
      }
      persistGroupedSnapshot(groupedController!, mainObject);
    },
  };

  registerInitializeStoreFn(mainKey, asyncStorage);

  return { storage };
};

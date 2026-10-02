import type { AsyncStorageBackend } from './indexedDB';
import { handleError } from '../../utils/errorHandling.js';
import {
  WorkspaceRecoveryAccessError,
  WorkspaceRecoveryDataError,
  WorkspaceRecoveryStorage,
  workspaceRecoveryGroups,
} from './workspaceRecovery.js';

export const memoryStorage = new Map<string, any>();

export async function initializeHybridStorage(
  mainKey: string | undefined,
  asyncStorage: AsyncStorageBackend,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  try {
    if (!mainKey || !isCurrent()) {
      return;
    }

    const storedData = await asyncStorage.getItem(mainKey);
    if (!isCurrent()) return;
    if (storedData !== null) {
      const parsed: unknown = parseGroup(storedData, mainKey);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new WorkspaceRecoveryDataError(
          `Invalid persistent storage group: ${mainKey}`,
          workspaceRecoveryGroups.has(mainKey),
        );
      memoryStorage.set(mainKey, parsed);
      return;
    }

    if (
      asyncStorage instanceof WorkspaceRecoveryStorage &&
      workspaceRecoveryGroups.has(mainKey) &&
      asyncStorage.hasSelectedCheckpoint
    ) {
      memoryStorage.delete(mainKey);
      return;
    }

    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(mainKey);
    if (!isCurrent()) return;
    if (raw !== null) {
      const localData: unknown = parseGroup(raw, mainKey);
      if (!localData || typeof localData !== 'object' || Array.isArray(localData))
        throw new WorkspaceRecoveryDataError(
          `Invalid legacy storage group: ${mainKey}`,
          workspaceRecoveryGroups.has(mainKey),
        );
      // All workspace groups must be loaded before committing an envelope.
      // Persisting a partial localStorage import here would lose later groups.
      if (!(asyncStorage instanceof WorkspaceRecoveryStorage && workspaceRecoveryGroups.has(mainKey))) {
        await asyncStorage.setItem(mainKey, JSON.stringify(localData));
      }
      if (isCurrent()) memoryStorage.set(mainKey, localData);
    } else {
      memoryStorage.delete(mainKey);
    }
  } catch (error) {
    if (!isCurrent()) return;
    handleError(error, 'Failed to initialize hybrid storage', {
      metadata: {
        mainKey,
      },
      toastError: false,
    });

    // An unreadable/corrupt authoritative recovery record is not an empty
    // workspace. Keep the app behind bootstrap rather than overwrite evidence.
    if (workspaceRecoveryGroups.has(mainKey ?? '') && !(error instanceof WorkspaceRecoveryDataError))
      throw new WorkspaceRecoveryAccessError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function parseGroup(raw: string, key: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new WorkspaceRecoveryDataError(
      `Invalid persistent storage group: ${key}. The original record was retained.`,
      workspaceRecoveryGroups.has(key),
    );
  }
}

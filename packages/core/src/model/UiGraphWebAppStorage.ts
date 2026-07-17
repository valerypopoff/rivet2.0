import type { DataValue } from './DataValue.js';
import type { ExternalFunction } from './GraphProcessor.js';

export const RIVET_WEB_APP_STORAGE_GET_FUNCTION_NAME = 'getWebAppStorage';
export const RIVET_WEB_APP_STORAGE_SET_FUNCTION_NAME = 'setWebAppStorage';

export type RivetWebAppStorage = Record<string, unknown>;

export type RivetWebAppStorageExternalFunctions = {
  externalFunctions: Record<string, ExternalFunction>;
  getStoragePatch(): RivetWebAppStorage;
};

/** Creates one action-scoped storage view shared by get/set calls in the same graph run. */
export function createRivetWebAppStorageExternalFunctions(
  initialStorage: Readonly<RivetWebAppStorage> = {},
): RivetWebAppStorageExternalFunctions {
  const currentStorage = cloneStorageRecord(initialStorage, 'Web app storage');
  const storagePatch: RivetWebAppStorage = {};

  const getWebAppStorage: ExternalFunction = async (_context, key) => {
    if (key == null) {
      return { type: 'object', value: cloneStorageRecord(currentStorage, 'Web app storage') } satisfies DataValue;
    }

    const normalizedKey = normalizeStorageKey(key);
    return {
      type: 'any',
      value: Object.prototype.hasOwnProperty.call(currentStorage, normalizedKey)
        ? cloneJsonValue(currentStorage[normalizedKey], 'Stored value')
        : null,
    } satisfies DataValue;
  };

  const setWebAppStorage: ExternalFunction = async (_context, key, value) => {
    const normalizedKey = normalizeStorageKey(key);
    const storedValue = cloneJsonValue(value, 'Web app storage value');
    currentStorage[normalizedKey] = storedValue;
    storagePatch[normalizedKey] = storedValue;
    return { type: 'any', value: cloneJsonValue(storedValue, 'Stored value') } satisfies DataValue;
  };

  return {
    externalFunctions: {
      [RIVET_WEB_APP_STORAGE_GET_FUNCTION_NAME]: getWebAppStorage,
      [RIVET_WEB_APP_STORAGE_SET_FUNCTION_NAME]: setWebAppStorage,
    },
    getStoragePatch: () => cloneStorageRecord(storagePatch, 'Web app storage patch'),
  };
}

function normalizeStorageKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Web app storage key must be a non-empty string.');
  }
  if (value.length > 512) {
    throw new Error('Web app storage key must be at most 512 characters.');
  }
  if (value === '__proto__' || value === 'constructor' || value === 'prototype') {
    throw new Error('Web app storage key is reserved.');
  }
  return value;
}

function cloneStorageRecord(value: Readonly<RivetWebAppStorage>, label: string): RivetWebAppStorage {
  const cloned = cloneJsonValue(value, label);
  if (!isRecord(cloned)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return cloned;
}

function cloneJsonValue(value: unknown, label: string): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized == null) {
      throw new Error(`${label} must be JSON-serializable.`);
    }
    return JSON.parse(serialized) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be JSON-serializable.`) {
      throw error;
    }
    throw new Error(`${label} must be JSON-serializable.`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

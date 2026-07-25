import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { createRecoverableIndexedDbConnection, preserveIndexedDbRequestTiming } from '../../utils/indexedDb.js';

export interface AsyncStorageBackend {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

export class MemoryAsyncStorage implements AsyncStorageBackend {
  #storage = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.#storage.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.#storage.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.#storage.delete(key);
  }
}

interface JotaiStorageDatabase extends DBSchema {
  state: {
    key: string;
    value: string;
  };
}

export class IndexedDBStorage implements AsyncStorageBackend {
  private getDatabase = createRecoverableIndexedDbConnection(openJotaiStorageDatabase);

  async getItem(key: string): Promise<string | null> {
    const db = await this.getDatabase();
    const transaction = preserveIndexedDbRequestTiming(db.transaction('state', 'readonly'));
    return (await transaction.store.get(key)) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    const db = await this.getDatabase();
    const transaction = preserveIndexedDbRequestTiming(db.transaction('state', 'readwrite'));
    await transaction.store.put(value, key);
  }

  async removeItem(key: string): Promise<void> {
    const db = await this.getDatabase();
    const transaction = preserveIndexedDbRequestTiming(db.transaction('state', 'readwrite'));
    await transaction.store.delete(key);
  }
}

export function createDefaultAsyncStorage(): AsyncStorageBackend {
  return typeof indexedDB === 'undefined' ? new MemoryAsyncStorage() : new IndexedDBStorage();
}

function openJotaiStorageDatabase(onUnavailable: () => void): Promise<IDBPDatabase<JotaiStorageDatabase>> {
  let database: IDBPDatabase<JotaiStorageDatabase> | undefined;

  return openDB<JotaiStorageDatabase>('jotai-store', 1, {
    upgrade(upgradeDatabase) {
      upgradeDatabase.createObjectStore('state');
    },
    blocking() {
      database?.close();
      onUnavailable();
    },
    terminated() {
      onUnavailable();
    },
  }).then((openedDatabase) => {
    database = openedDatabase;
    return openedDatabase;
  });
}

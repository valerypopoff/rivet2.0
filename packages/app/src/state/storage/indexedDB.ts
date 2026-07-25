import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { preserveIndexedDbRequestTiming } from '../../utils/indexedDb.js';

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
  private dbPromise: Promise<IDBPDatabase<JotaiStorageDatabase>>;

  constructor() {
    this.dbPromise = openDB<JotaiStorageDatabase>('jotai-store', 1, {
      upgrade(database) {
        database.createObjectStore('state');
      },
    });
  }

  async getItem(key: string): Promise<string | null> {
    const db = await this.dbPromise;
    const transaction = preserveIndexedDbRequestTiming(db.transaction('state', 'readonly'));
    return (await transaction.store.get(key)) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    const db = await this.dbPromise;
    const transaction = preserveIndexedDbRequestTiming(db.transaction('state', 'readwrite'));
    await transaction.store.put(value, key);
  }

  async removeItem(key: string): Promise<void> {
    const db = await this.dbPromise;
    const transaction = preserveIndexedDbRequestTiming(db.transaction('state', 'readwrite'));
    await transaction.store.delete(key);
  }
}

export function createDefaultAsyncStorage(): AsyncStorageBackend {
  return typeof indexedDB === 'undefined' ? new MemoryAsyncStorage() : new IndexedDBStorage();
}

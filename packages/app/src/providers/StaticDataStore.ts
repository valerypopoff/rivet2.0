import { type DataId } from '@valerypopoff/rivet2-core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { createRecoverableIndexedDbConnection, preserveIndexedDbRequestTiming } from '../utils/indexedDb.js';

export type StaticDataRecord = {
  id: DataId;
  data: string;
};

export interface StaticDataStore {
  insert(id: DataId, data: string): Promise<void>;
  get(id: DataId): Promise<StaticDataRecord | undefined>;
  getAll(): Promise<StaticDataRecord[]>;
  clear(): Promise<void>;
}

interface StaticDataDatabase extends DBSchema {
  data: {
    key: string;
    value: StaticDataRecord;
  };
}

export function openStaticDataDatabase(onUnavailable?: () => void): Promise<IDBPDatabase<StaticDataDatabase>> {
  let database: IDBPDatabase<StaticDataDatabase> | undefined;

  return openDB<StaticDataDatabase>('rivet_static_data', 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('data')) {
        db.createObjectStore('data');
      }
    },
    blocking() {
      database?.close();
      onUnavailable?.();
    },
    terminated() {
      onUnavailable?.();
    },
  }).then((openedDatabase) => {
    database = openedDatabase;
    return openedDatabase;
  });
}

export class MemoryStaticDataStore implements StaticDataStore {
  readonly #records = new Map<DataId, string>();

  async insert(id: DataId, data: string): Promise<void> {
    if (this.#records.has(id)) {
      throw new Error(`Static data "${id}" already exists.`);
    }

    this.#records.set(id, data);
  }

  async get(id: DataId): Promise<StaticDataRecord | undefined> {
    return this.#records.has(id) ? { id, data: this.#records.get(id)! } : undefined;
  }

  async getAll(): Promise<StaticDataRecord[]> {
    return [...this.#records].map(([id, data]) => ({ id, data }));
  }

  async clear(): Promise<void> {
    this.#records.clear();
  }
}

export class BrowserStaticDataStore implements StaticDataStore {
  readonly #memoryFallback = new MemoryStaticDataStore();
  readonly #getDatabase = createRecoverableIndexedDbConnection(openStaticDataDatabase);

  async insert(id: DataId, data: string): Promise<void> {
    if (!this.#hasIndexedDB()) {
      return this.#memoryFallback.insert(id, data);
    }

    const database = await this.#getDatabase();
    const transaction = preserveIndexedDbRequestTiming(database.transaction('data', 'readwrite'));
    await transaction.store.add({ id, data }, id);
  }

  async get(id: DataId): Promise<StaticDataRecord | undefined> {
    if (!this.#hasIndexedDB()) {
      return this.#memoryFallback.get(id);
    }

    const database = await this.#getDatabase();
    const transaction = preserveIndexedDbRequestTiming(database.transaction('data', 'readonly'));
    return transaction.store.get(id);
  }

  async getAll(): Promise<StaticDataRecord[]> {
    if (!this.#hasIndexedDB()) {
      return this.#memoryFallback.getAll();
    }

    const database = await this.#getDatabase();
    const transaction = preserveIndexedDbRequestTiming(database.transaction('data', 'readonly'));
    return transaction.store.getAll();
  }

  async clear(): Promise<void> {
    if (!this.#hasIndexedDB()) {
      return this.#memoryFallback.clear();
    }

    const database = await this.#getDatabase();
    const transaction = preserveIndexedDbRequestTiming(database.transaction('data', 'readwrite'));
    await transaction.store.clear();
  }

  #hasIndexedDB(): boolean {
    return typeof indexedDB !== 'undefined';
  }
}

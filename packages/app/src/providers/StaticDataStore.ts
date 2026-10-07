import { type DataId } from '@valerypopoff/rivet2-core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

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

export function openStaticDataDatabase(
  onUnavailable?: () => void,
  name = 'rivet_static_data',
): Promise<IDBPDatabase<StaticDataDatabase>> {
  let database: IDBPDatabase<StaticDataDatabase> | undefined;

  return openDB<StaticDataDatabase>(name, 2, {
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

/** Derived document-local cache. Durable payloads belong to the workspace
 * checkpoint and project file, not another independently written database. */
export class BrowserStaticDataStore extends MemoryStaticDataStore {
  #canReadLegacy = true;

  override async getAll(): Promise<StaticDataRecord[]> {
    const records = await super.getAll();
    if (records.length || !this.#canReadLegacy || typeof indexedDB === 'undefined') return records;
    this.#canReadLegacy = false;
    // Only legacy bootstrap reads the old shared cache. Never clear or write
    // it; another window may still belong to an older application version.
    const legacy = await openStaticDataDatabase();
    try {
      return await legacy.getAll('data');
    } finally {
      legacy.close();
    }
  }

  override async clear(): Promise<void> {
    this.#canReadLegacy = false;
    await super.clear();
  }
}

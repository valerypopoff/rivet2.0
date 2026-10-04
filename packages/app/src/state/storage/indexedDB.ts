import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { createRecoverableIndexedDbConnection, preserveIndexedDbRequestTiming } from '../../utils/indexedDb.js';

export interface AsyncStorageBackend {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
  /** Optional recovery discovery; existing host backends remain compatible. */
  listKeys?: (prefix: string) => Promise<string[]>;
  /** Ephemeral providers must opt out of reload recovery. Existing durable hosts remain compatible. */
  readonly persistsAcrossReload?: boolean;
}

export class MemoryAsyncStorage implements AsyncStorageBackend {
  readonly persistsAcrossReload: boolean = false;
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

  async listKeys(prefix: string): Promise<string[]> {
    return [...this.#storage.keys()].filter((key) => key.startsWith(prefix));
  }
}

interface JotaiStorageDatabase extends DBSchema {
  state: {
    key: string;
    value: string;
  };
}

export class IndexedDBStorage implements AsyncStorageBackend {
  readonly persistsAcrossReload: boolean = true;
  private getDatabase = createRecoverableIndexedDbConnection(openJotaiStorageDatabase);

  private async withDatabase<T>(operation: (database: IDBPDatabase<JotaiStorageDatabase>) => Promise<T>): Promise<T> {
    const connection = this.getDatabase;
    try {
      return await operation(await connection());
    } catch (error) {
      // A closed connection need not emit `terminated` (for example, after a
      // schema-upgrade close race). Retrying that cached handle cannot repair
      // anything. Reopen once; never reinterpret quota/abort as success.
      if (!(error instanceof Error) || error.name !== 'InvalidStateError') throw error;
      if (this.getDatabase === connection)
        this.getDatabase = createRecoverableIndexedDbConnection(openJotaiStorageDatabase);
      return operation(await this.getDatabase());
    }
  }

  async getItem(key: string): Promise<string | null> {
    return this.withDatabase(async (db) => {
      const transaction = preserveIndexedDbRequestTiming(db.transaction('state', 'readonly'));
      return (await transaction.store.get(key)) ?? null;
    });
  }

  async setItem(key: string, value: string): Promise<void> {
    return this.withDatabase(async (db) => {
      const transaction = preserveIndexedDbRequestTiming(db.transaction('state', 'readwrite'));
      await transaction.store.put(value, key);
      await transaction.done;
    });
  }

  async removeItem(key: string): Promise<void> {
    return this.withDatabase(async (db) => {
      const transaction = preserveIndexedDbRequestTiming(db.transaction('state', 'readwrite'));
      await transaction.store.delete(key);
      await transaction.done;
    });
  }

  async listKeys(prefix: string): Promise<string[]> {
    return this.withDatabase(async (db) => (await db.getAllKeys('state')).filter((key) => key.startsWith(prefix)));
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

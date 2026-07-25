import { type DataId } from '@valerypopoff/rivet2-core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { createRecoverableIndexedDbConnection, preserveIndexedDbRequestTiming } from '../utils/indexedDb.js';

interface StaticDataDatabase extends DBSchema {
  data: {
    key: string;
    value: {
      id: DataId;
      data: unknown;
    };
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

const getStaticDataDatabase = createRecoverableIndexedDbConnection(openStaticDataDatabase);

export function useStaticDataDatabase() {
  const insert = async (id: DataId, data: unknown) => {
    const database = await getStaticDataDatabase();
    const transaction = preserveIndexedDbRequestTiming(database.transaction('data', 'readwrite'));
    await transaction.store.add({ id, data }, id);
  };

  const get = async (id: DataId) => {
    const database = await getStaticDataDatabase();
    const transaction = preserveIndexedDbRequestTiming(database.transaction('data', 'readonly'));
    return transaction.store.get(id);
  };

  const getAll = async () => {
    const database = await getStaticDataDatabase();
    const transaction = preserveIndexedDbRequestTiming(database.transaction('data', 'readonly'));
    return transaction.store.getAll() as Promise<{ id: DataId; data: string }[]>;
  };

  const clear = async () => {
    const database = await getStaticDataDatabase();
    const transaction = preserveIndexedDbRequestTiming(database.transaction('data', 'readwrite'));
    await transaction.store.clear();
  };

  return { insert, get, getAll, clear };
}

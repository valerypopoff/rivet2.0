import { type DataId } from '@valerypopoff/rivet2-core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { useEffect, useRef } from 'react';
import { preserveIndexedDbRequestTiming } from '../utils/indexedDb.js';

interface StaticDataDatabase extends DBSchema {
  data: {
    key: string;
    value: {
      id: DataId;
      data: unknown;
    };
  };
}

export function openStaticDataDatabase(): Promise<IDBPDatabase<StaticDataDatabase>> {
  return openDB<StaticDataDatabase>('rivet_static_data', 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('data')) {
        db.createObjectStore('data');
      }
    },
  });
}

export function useStaticDataDatabase() {
  const database = useRef<IDBPDatabase<StaticDataDatabase>>();
  const databaseLoadedPromise = useRef<Promise<void>>();

  useEffect(() => {
    databaseLoadedPromise.current = openStaticDataDatabase().then((db) => {
      database.current = db;
    });
  }, []);

  const insert = async (id: DataId, data: unknown) => {
    await databaseLoadedPromise.current;
    const transaction = preserveIndexedDbRequestTiming(database.current!.transaction('data', 'readwrite'));
    await transaction.store.add({ id, data }, id);
  };

  const get = async (id: DataId) => {
    await databaseLoadedPromise.current;
    const transaction = preserveIndexedDbRequestTiming(database.current!.transaction('data', 'readonly'));
    return transaction.store.get(id);
  };

  const getAll = async () => {
    await databaseLoadedPromise.current;
    const transaction = preserveIndexedDbRequestTiming(database.current!.transaction('data', 'readonly'));
    return transaction.store.getAll() as Promise<{ id: DataId; data: string }[]>;
  };

  const clear = async () => {
    await databaseLoadedPromise.current;
    const transaction = preserveIndexedDbRequestTiming(database.current!.transaction('data', 'readwrite'));
    await transaction.store.clear();
  };

  return {
    insert,
    get,
    getAll,
    clear,
    loaded: !!database.current,
  };
}

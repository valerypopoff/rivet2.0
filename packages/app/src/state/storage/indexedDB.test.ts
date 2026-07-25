import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { type DataId } from '@valerypopoff/rivet2-core';
import { IDBFactory } from 'fake-indexeddb';
import { openStaticDataDatabase } from '../../hooks/useStaticDataDatabase.js';
import { IndexedDBStorage, MemoryAsyncStorage, createDefaultAsyncStorage } from './indexedDB.js';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
    writable: true,
  });
});

void describe('browser IndexedDB storage', () => {
  void it('opens and mutates the legacy Jotai schema without losing existing values', async () => {
    const legacyDatabase = await openNativeDatabase('jotai-store', 1, (database) => {
      database.createObjectStore('state');
    });
    await nativeRequest(legacyDatabase.transaction('state', 'readwrite').objectStore('state').put('before', 'key'));
    legacyDatabase.close();

    const storage = new IndexedDBStorage();

    assert.equal(await storage.getItem('key'), 'before');
    assert.equal(await storage.getItem('missing'), null);
    await storage.setItem('key', 'after');
    assert.equal(await storage.getItem('key'), 'after');
    await storage.removeItem('key');
    assert.equal(await storage.getItem('key'), null);
  });

  void it('keeps the in-memory fallback contract when IndexedDB is unavailable', async () => {
    const indexedDBDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Reflect.deleteProperty(globalThis, 'indexedDB');

    try {
      const storage = createDefaultAsyncStorage();
      assert.ok(storage instanceof MemoryAsyncStorage);
      assert.equal(await storage.getItem('missing'), null);
      await storage.setItem('key', 'value');
      assert.equal(await storage.getItem('key'), 'value');
      await storage.removeItem('key');
      assert.equal(await storage.getItem('key'), null);
    } finally {
      if (indexedDBDescriptor) {
        Object.defineProperty(globalThis, 'indexedDB', indexedDBDescriptor);
      }
    }
  });

  void it('opens and mutates the legacy static-data schema while preserving add semantics', async () => {
    const id = 'static-data' as DataId;
    const legacyDatabase = await openNativeDatabase('rivet_static_data', 2, (database) => {
      database.createObjectStore('data');
    });
    await nativeRequest(
      legacyDatabase.transaction('data', 'readwrite').objectStore('data').add({ id, data: 'before' }, id),
    );
    legacyDatabase.close();

    const database = await openStaticDataDatabase();
    const store = database.transaction('data', 'readonly').store;
    assert.deepEqual(await store.get(id), { id, data: 'before' });

    const duplicateTransaction = database.transaction('data', 'readwrite');
    void duplicateTransaction.done.catch(() => undefined);
    await assert.rejects(duplicateTransaction.store.add({ id, data: 'duplicate' }, id), /ConstraintError/);

    const secondId = 'second-static-data' as DataId;
    await database.transaction('data', 'readwrite').store.add({ id: secondId, data: 'second' }, secondId);
    assert.deepEqual(await database.transaction('data', 'readonly').store.getAll(), [
      { id: secondId, data: 'second' },
      { id, data: 'before' },
    ]);

    await database.transaction('data', 'readwrite').store.clear();
    assert.deepEqual(await database.transaction('data', 'readonly').store.getAll(), []);
    database.close();
  });
});

function openNativeDatabase(
  name: string,
  version: number,
  upgrade: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function nativeRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { type DataId } from '@valerypopoff/rivet2-core';
import { IDBFactory, IDBObjectStore, IDBDatabase } from 'fake-indexeddb';
import { openStaticDataDatabase } from '../../hooks/useStaticDataDatabase.js';
import { BrowserStaticDataStore, MemoryStaticDataStore } from '../../providers/StaticDataStore.js';
import { createRecoverableIndexedDbConnection } from '../../utils/indexedDb.js';
import { IndexedDBStorage, MemoryAsyncStorage, createDefaultAsyncStorage } from './indexedDB.js';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
    writable: true,
  });
});

void describe('browser IndexedDB storage', () => {
  void it('reopens a silently closed cached connection without losing committed records', async () => {
    const storage = new IndexedDBStorage();
    await storage.setItem('key', 'before');
    const transaction = IDBDatabase.prototype.transaction;
    let closed: IDBDatabase | undefined;
    IDBDatabase.prototype.transaction = function (...args) {
      if (this.name === 'jotai-store' && !closed) {
        closed = this;
        this.close();
      }
      return transaction.apply(this, args);
    };
    try {
      assert.equal(await storage.getItem('key'), 'before');
      assert.ok(closed);
      await storage.setItem('key', 'after');
      assert.equal(await storage.getItem('key'), 'after');
      assert.deepEqual(await storage.listKeys('k'), ['key']);
      await storage.removeItem('key');
      assert.equal(await storage.getItem('key'), null);
    } finally {
      IDBDatabase.prototype.transaction = transaction;
    }
  });
  void it('does not acknowledge a request whose transaction aborts after put succeeds', async () => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
    try {
      const storage = new IndexedDBStorage();
      await assert.rejects(storage.setItem('key', 'not-committed'), /AbortError/);
      assert.equal(await storage.getItem('key'), null);
    } finally {
      IDBObjectStore.prototype.put = put;
    }
  });
  void it('opens and mutates the legacy Jotai schema without losing existing values', async () => {
    const legacyDatabase = await openNativeDatabase('jotai-store', 1, (database) => {
      database.createObjectStore('state');
    });
    await nativeRequest(legacyDatabase.transaction('state', 'readwrite').objectStore('state').put('before', 'key'));
    legacyDatabase.close();

    const storage = new IndexedDBStorage();

    assert.equal(storage.persistsAcrossReload, true);
    assert.equal(await storage.getItem('key'), 'before');
    assert.equal(await storage.getItem('missing'), null);
    await storage.setItem('key', 'after');
    assert.equal(await storage.getItem('key'), 'after');
    await storage.removeItem('key');
    assert.equal(await storage.getItem('key'), null);
  });

  void it('closes Jotai storage connections that block a future schema upgrade', async () => {
    const storage = new IndexedDBStorage();
    await storage.setItem('key', 'value');

    const upgradedDatabase = await openNativeDatabase('jotai-store', 2, () => undefined);
    assert.equal(upgradedDatabase.version, 2);
    upgradedDatabase.close();
  });

  void it('keeps the in-memory fallback contract when IndexedDB is unavailable', async () => {
    const indexedDBDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Reflect.deleteProperty(globalThis, 'indexedDB');

    try {
      const storage = createDefaultAsyncStorage();
      assert.ok(storage instanceof MemoryAsyncStorage);
      assert.equal(storage.persistsAcrossReload, false);
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

  void it('keeps the page-lifetime static-data store contract in memory', async () => {
    const database = new MemoryStaticDataStore();
    const id = 'memory-static-data' as DataId;

    await database.clear();
    assert.equal(await database.get(id), undefined);
    await database.insert(id, 'stored');
    assert.deepEqual(await database.get(id), { id, data: 'stored' });
    assert.deepEqual(await database.getAll(), [{ id, data: 'stored' }]);
    await assert.rejects(database.insert(id, 'duplicate'), /already exists/);
    await database.clear();
    assert.deepEqual(await database.getAll(), []);
  });

  void it('isolates document caches and never mutates the retained legacy cache', async () => {
    const id = 'legacy-asset' as DataId;
    const legacy = await openStaticDataDatabase();
    await legacy.put('data', { id, data: 'legacy' }, id);
    const first = new BrowserStaticDataStore();
    const second = new BrowserStaticDataStore();
    assert.deepEqual(await first.getAll(), [{ id, data: 'legacy' }]);
    await first.clear();
    await first.insert(id, 'first');
    await second.clear();
    await second.insert(id, 'second');
    assert.deepEqual(await first.getAll(), [{ id, data: 'first' }]);
    assert.deepEqual(await second.getAll(), [{ id, data: 'second' }]);
    assert.deepEqual(await legacy.getAll('data'), [{ id, data: 'legacy' }]);
    legacy.close();
  });

  void it('closes static-data connections that block a future schema upgrade', async () => {
    await openStaticDataDatabase();

    const upgradedDatabase = await openNativeDatabase('rivet_static_data', 3, () => undefined);
    assert.equal(upgradedDatabase.version, 3);
    upgradedDatabase.close();
  });

  void it('retries failed and browser-invalidated cached database opens', async () => {
    let attempt = 0;
    let invalidate: (() => void) | undefined;
    const getDatabase = createRecoverableIndexedDbConnection(async (onUnavailable) => {
      attempt += 1;
      invalidate = onUnavailable;
      if (attempt === 1) {
        throw new Error('open failed');
      }
      return { attempt };
    });

    await assert.rejects(getDatabase(), /open failed/);
    assert.deepEqual(await getDatabase(), { attempt: 2 });
    assert.deepEqual(await getDatabase(), { attempt: 2 });

    invalidate?.();
    assert.deepEqual(await getDatabase(), { attempt: 3 });

    const getImmediatelyInvalidatedDatabase = createRecoverableIndexedDbConnection(async (onUnavailable) => {
      onUnavailable();
      return { attempt: ++attempt };
    });
    assert.deepEqual(await getImmediatelyInvalidatedDatabase(), { attempt: 4 });
    assert.deepEqual(await getImmediatelyInvalidatedDatabase(), { attempt: 5 });
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

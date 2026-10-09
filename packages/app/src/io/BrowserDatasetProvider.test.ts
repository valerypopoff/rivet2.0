import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { type Dataset, type DatasetId, type DatasetMetadata, type ProjectId } from '@valerypopoff/rivet2-core';
import { IDBFactory, IDBObjectStore, IDBIndex } from 'fake-indexeddb';
import { openDB } from 'idb';
import { BrowserDatasetProvider } from './BrowserDatasetProvider.js';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: globalThis,
    writable: true,
  });
});

void describe('BrowserDatasetProvider IndexedDB persistence', () => {
  void it('upgrades an existing v2 catalog without losing data and scopes reads/replacement to the project index', async (t) => {
    const db = await openDB('datasets', 2, {
      upgrade(database) {
        database.createObjectStore('datasets');
        database.createObjectStore('data');
      },
    });
    const owner = 'owner' as ProjectId;
    const other = 'other' as ProjectId;
    const id = 'owned' as DatasetId;
    const otherId = 'unrelated' as DatasetId;
    const original = { meta: metadata(id, owner, 'Owned'), data: { id, rows: [{ id: 'row', data: ['kept'] }] } };
    const unrelated = { meta: metadata(otherId, other, 'Other'), data: { id: otherId, rows: [] } };
    for (const dataset of [original, unrelated]) {
      await db.put('datasets', dataset.meta, dataset.meta.id);
      await db.put('data', dataset.data, dataset.data.id);
    }
    db.close();
    const provider = new BrowserDatasetProvider();
    // The one-time legacy key migration must visit old records. Ordinary
    // selections and replacements after that must use the project index.
    (await provider.getDatasetDatabase()).close();
    const cursor = t.mock.method(IDBObjectStore.prototype, 'openCursor', function () {
      throw new Error('Must not scan all dataset owners');
    });
    const reads = t.mock.method(IDBIndex.prototype, 'getAll');
    await provider.loadDatasets(owner);
    assert.deepEqual(await provider.exportDatasetsForProject(owner), [original]);
    assert.equal(reads.mock.calls[0]?.arguments[0], owner);
    await provider.importDatasetsForProject(owner, [], { replace: true });
    await provider.loadDatasets(owner);
    assert.deepEqual(await provider.exportDatasetsForProject(owner), []);
    await provider.loadDatasets(other);
    assert.deepEqual(await provider.exportDatasetsForProject(other), [unrelated]);
    assert.equal(cursor.mock.callCount(), 0);
  });
  void it('missing IndexedDB fails clearly without replacing the current project and permits a later retry', async () => {
    const provider = new BrowserDatasetProvider();
    const first = 'first' as ProjectId;
    const second = 'second' as ProjectId;
    await provider.importDatasetsForProject(first, []);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')!;
    Reflect.deleteProperty(globalThis, 'indexedDB');
    try {
      // Use a fresh opener, as if storage was unavailable at bootstrap.
      const unavailable = new BrowserDatasetProvider();
      unavailable.currentProjectId = first;
      await assert.rejects(unavailable.loadDatasets(second), /Browser IndexedDB storage is unavailable/);
      assert.equal(unavailable.currentProjectId, first);
      Object.defineProperty(globalThis, 'indexedDB', descriptor);
      await unavailable.loadDatasets(second);
      assert.equal(unavailable.currentProjectId, second);
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', descriptor);
    }
  });

  void it('migrates the v3 indexed catalog to owner-scoped storage without losing rows', async () => {
    const db = await openDB('datasets', 3, {
      upgrade(database) {
        database.createObjectStore('datasets').createIndex('by-project', 'projectId');
        database.createObjectStore('data');
      },
    });
    const owner = 'v3-owner' as ProjectId;
    const id = 'v3-data' as DatasetId;
    const original = { meta: metadata(id, owner, 'V3'), data: { id, rows: [{ id: 'row', data: ['kept'] }] } };
    await db.put('datasets', original.meta, id);
    await db.put('data', original.data, id);
    db.close();
    const provider = new BrowserDatasetProvider();
    await provider.loadDatasets(owner);
    assert.deepEqual(await provider.exportDatasetsForProject(owner), [original]);
    const migrated = await provider.getDatasetDatabase();
    try {
      assert.equal(migrated.version, 4);
      const transaction = migrated.transaction(['datasets', 'data']);
      const old = transaction.objectStore('datasets').get(id);
      const scoped = transaction.objectStore('data').get([owner, id]);
      await transactionDone(transaction);
      assert.equal(old.result, undefined);
      assert.deepEqual(scoped.result, original.data);
    } finally {
      migrated.close();
    }
  });

  void it('isolates copied and preview datasets with shared IDs through edits, tab reads and cleanup', async () => {
    const provider = new BrowserDatasetProvider();
    const source = 'source' as ProjectId;
    const copy = 'copy' as ProjectId;
    const preview = 'published-version-preview:test' as ProjectId;
    const id = 'shared-data' as DatasetId;
    const original = { meta: metadata(id, source, 'Source'), data: { id, rows: [{ id: 'row', data: ['source'] }] } };
    await provider.importDatasetsForProject(source, [original]);
    await provider.importDatasetsForProject(copy, [original]);
    assert.equal((await provider.getDatasetMetadata(id))!.projectId, copy);
    await provider.putDatasetRow(id, { id: 'row', data: ['copy edit'] });
    await provider.importDatasetsForProject(preview, [original], { replace: true });
    assert.equal((await provider.getDatasetMetadata(id))!.projectId, preview);
    await provider.clearDatasetData(id);
    assert.deepEqual(await provider.exportDatasetsForProject(source), [original]);
    assert.equal((await provider.exportDatasetsForProject(copy))[0]!.data.rows[0]!.data[0], 'copy edit');
    await provider.deleteStoredDatasetsForProject(preview);
    await provider.loadDatasets(copy);
    await provider.deleteDataset(id);
    await provider.loadDatasets(source);
    assert.deepEqual(await provider.exportDatasetsForProject(source), [original]);
    assert.deepEqual(await provider.exportDatasetsForProject(copy), []);
    assert.deepEqual(await provider.exportDatasetsForProject(preview), []);
  });

  void it('a failed key migration retains the legacy database and can be retried', async (t) => {
    const db = await openDB('datasets', 2, {
      upgrade(database) {
        database.createObjectStore('datasets');
        database.createObjectStore('data');
      },
    });
    const owner = 'owner' as ProjectId;
    const id = 'data' as DatasetId;
    const original = { meta: metadata(id, owner, 'Original'), data: { id, rows: [{ id: 'row', data: ['kept'] }] } };
    await db.put('datasets', original.meta, id);
    await db.put('data', original.data, id);
    db.close();
    const cursor = t.mock.method(IDBObjectStore.prototype, 'openCursor', () => {
      throw new DOMException('Migration failure', 'UnknownError');
    });
    const provider = new BrowserDatasetProvider();
    await assert.rejects(provider.loadDatasets(owner));
    cursor.mock.restore();
    const retained = await openDB('datasets', 2);
    assert.deepEqual(await retained.get('datasets', id), original.meta);
    assert.deepEqual(await retained.get('data', id), original.data);
    retained.close();
    await provider.loadDatasets(owner);
    assert.deepEqual(await provider.exportDatasetsForProject(owner), [original]);
  });
  void it('exports the requested inactive project without changing the live owner', async () => {
    const provider = new BrowserDatasetProvider();
    const first = 'first-project' as ProjectId;
    const second = 'second-project' as ProjectId;
    const firstId = 'first-dataset' as DatasetId;
    const secondId = 'second-dataset' as DatasetId;
    const firstDataset = {
      meta: metadata(firstId, first, 'First'),
      data: { id: firstId, rows: [{ id: 'row', data: ['first'] }] },
    };
    const secondDataset = {
      meta: metadata(secondId, second, 'Second'),
      data: { id: secondId, rows: [{ id: 'row', data: ['second'] }] },
    };
    await provider.importDatasetsForProject(first, [firstDataset]);
    await provider.importDatasetsForProject(second, [secondDataset]);

    assert.deepEqual(await provider.exportDatasetsForProject(first), [firstDataset]);
    assert.deepEqual(await provider.exportDatasetsForProject('missing' as ProjectId), []);
    assert.equal(provider.currentProjectId, second);
    assert.deepEqual(await provider.exportDatasetsForProject(second), [secondDataset]);
  });

  void it('captures an active export before later edits or a tab switch', async () => {
    const provider = new BrowserDatasetProvider();
    const projectId = 'project' as ProjectId;
    const id = 'dataset' as DatasetId;
    const original = {
      meta: metadata(id, projectId, 'Original'),
      data: { id, rows: [{ id: 'row', data: ['original'] }] },
    };
    await provider.importDatasetsForProject(projectId, [original]);
    const exported = provider.exportDatasetsForProject(projectId);
    await provider.putDatasetRow(id, { id: 'row', data: ['changed'] });
    await provider.loadDatasets('other' as ProjectId);
    assert.deepEqual(await exported, [original]);
  });

  void it('a failed replacement rolls back the deletes and does not change the live owner', async () => {
    const provider = new BrowserDatasetProvider();
    const projectId = 'project' as ProjectId;
    const id = 'original' as DatasetId;
    const original = { meta: metadata(id, projectId, 'Original'), data: { id, rows: [] } };
    await provider.importDatasetsForProject(projectId, [original]);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'data') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return put.apply(this, args);
    };
    try {
      const replacement = 'replacement' as DatasetId;
      await assert.rejects(
        provider.importDatasetsForProject(
          projectId,
          [
            {
              meta: metadata(replacement, projectId, 'New'),
              data: { id: replacement, rows: [] },
            },
          ],
          { replace: true },
        ),
        /Quota/,
      );
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    assert.deepEqual(await provider.getDatasetsForProject(projectId), [original.meta]);
    const reloaded = new BrowserDatasetProvider();
    await reloaded.loadDatasets(projectId);
    assert.deepEqual(await reloaded.getDatasetsForProject(projectId), [original.meta]);
  });

  void it('the latest dataset selection wins over an earlier asynchronous load', async () => {
    const provider = new BrowserDatasetProvider();
    await Promise.all([provider.loadDatasets('old' as ProjectId), provider.loadDatasets('new' as ProjectId)]);
    assert.equal(provider.currentProjectId, 'new');
  });

  void it('inactive imports preserve the live dataset owner', async () => {
    const provider = new BrowserDatasetProvider();
    const active = 'active' as ProjectId;
    const inactive = 'inactive' as ProjectId;
    await provider.loadDatasets(active);
    const id = 'inactive-dataset' as DatasetId;
    await provider.importDatasetsForProject(
      inactive,
      [{ meta: metadata(id, inactive, 'Inactive'), data: { id, rows: [] } }],
      { activate: false },
    );
    assert.equal(provider.currentProjectId, active);
    assert.deepEqual(await provider.getDatasetsForProject(active), []);
    await provider.loadDatasets(inactive);
    assert.deepEqual(await provider.getDatasetsForProject(inactive), [metadata(id, inactive, 'Inactive')]);
  });

  void it('cleanup deletes only its owner and refreshes an active cache without opening a public connection', async (t) => {
    const provider = new BrowserDatasetProvider();
    const active = 'active' as ProjectId;
    const inactive = 'inactive' as ProjectId;
    const activeId = 'active-data' as DatasetId;
    const inactiveId = 'inactive-data' as DatasetId;
    await provider.importDatasetsForProject(inactive, [
      { meta: metadata(inactiveId, inactive, 'Inactive'), data: { id: inactiveId, rows: [] } },
    ]);
    const activeDataset = { meta: metadata(activeId, active, 'Active'), data: { id: activeId, rows: [] } };
    await provider.importDatasetsForProject(active, [activeDataset]);
    const publicConnection = t.mock.method(provider, 'getDatasetDatabase', async () => {
      throw new Error('Cleanup must reuse the internal connection');
    });
    await provider.deleteStoredDatasetsForProject(inactive);
    assert.equal(provider.currentProjectId, active);
    assert.deepEqual(await provider.exportDatasetsForProject(active), [activeDataset]);
    assert.deepEqual(await provider.exportDatasetsForProject(inactive), []);
    await provider.deleteStoredDatasetsForProject(active);
    assert.equal(provider.currentProjectId, active);
    assert.deepEqual(await provider.getDatasetsForProject(active), []);
    assert.equal(publicConnection.mock.callCount(), 0);
    const reloaded = new BrowserDatasetProvider();
    await reloaded.loadDatasets(active);
    assert.deepEqual(await reloaded.getDatasetsForProject(active), []);
  });

  void it('cleanup cannot supersede a pending tab selection', async (t) => {
    const provider = new BrowserDatasetProvider();
    const old = 'old' as ProjectId;
    const next = 'next' as ProjectId;
    await provider.loadDatasets(old);
    const importDatasets = provider.importDatasetsForProject.bind(provider);
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(provider, 'importDatasetsForProject', async (...args: Parameters<typeof importDatasets>) => {
      await delayed;
      return importDatasets(...args);
    });
    const cleanup = provider.deleteStoredDatasetsForProject(old);
    await provider.loadDatasets(next);
    release();
    await cleanup;
    assert.equal(provider.currentProjectId, next);
    assert.deepEqual(await provider.getDatasetsForProject(next), []);
  });
  void it('cancelled replacement retains the original datasets and current in-memory owner', async () => {
    const provider = new BrowserDatasetProvider();
    const id = 'cancelled-data' as DatasetId;
    const projectId = 'project' as ProjectId;
    const original = { meta: metadata(id, projectId, 'Original'), data: { id, rows: [] } };
    await provider.importDatasetsForProject(projectId, [original]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      provider.importDatasetsForProject(projectId, [], {
        signal: controller.signal,
        replace: true,
      }),
      /cancelled/,
    );
    assert.deepEqual(await provider.getDatasetsForProject(projectId), [original.meta]);
    const reloaded = new BrowserDatasetProvider();
    await reloaded.loadDatasets(projectId);
    assert.deepEqual(await reloaded.getDatasetsForProject(projectId), [original.meta]);
  });
  void it('loads the legacy schema in cursor order and preserves missing-data fallback', async () => {
    const projectId = 'project' as ProjectId;
    const otherProjectId = 'other-project' as ProjectId;
    const firstId = 'first' as DatasetId;
    const missingDataId = 'missing-data' as DatasetId;
    const otherId = 'other' as DatasetId;
    const firstMetadata = metadata(firstId, projectId, 'First');
    const missingDataMetadata = metadata(missingDataId, projectId, 'Missing data');
    const firstData: Dataset = {
      id: firstId,
      rows: [{ id: 'row', data: ['value'], embedding: [1, 0] }],
    };

    const legacyDatabase = await openLegacyDatasetDatabase();
    const transaction = legacyDatabase.transaction(['datasets', 'data'], 'readwrite');
    transaction.objectStore('datasets').put(firstMetadata, firstId);
    transaction.objectStore('datasets').put(missingDataMetadata, missingDataId);
    transaction.objectStore('datasets').put(metadata(otherId, otherProjectId, 'Other'), otherId);
    transaction.objectStore('data').put(firstData, firstId);
    await transactionDone(transaction);
    legacyDatabase.close();

    const provider = new BrowserDatasetProvider();
    await provider.loadDatasets(projectId);

    assert.deepEqual(await provider.getDatasetsForProject(projectId), [firstMetadata, missingDataMetadata]);
    assert.deepEqual(await provider.getDatasetData(firstId), firstData);
    assert.deepEqual(await provider.getDatasetData(missingDataId), {
      id: missingDataId,
      rows: [],
    });
    await assert.rejects(provider.getDatasetsForProject(otherProjectId), /Project not loaded/);
  });

  void it('persists writes, imports both stores together, and deletes both records', async () => {
    const projectId = 'project' as ProjectId;
    const datasetId = 'dataset' as DatasetId;
    const provider = new BrowserDatasetProvider();
    await provider.loadDatasets(projectId);

    const datasetMetadata = metadata(datasetId, projectId, 'Dataset');
    await provider.putDatasetMetadata(datasetMetadata);
    await provider.putDatasetRow(datasetId, {
      id: 'row',
      data: ['first'],
      embedding: [1, 0],
    });
    await provider.putDatasetRow(datasetId, {
      id: 'row',
      data: ['updated'],
      embedding: [0, 1],
    });

    assert.deepEqual(await provider.getDatasetData(datasetId), {
      id: datasetId,
      rows: [{ id: 'row', data: ['updated'], embedding: [0, 1] }],
    });

    const importedId = 'imported' as DatasetId;
    await provider.importDatasetsForProject(projectId, [
      {
        meta: metadata(importedId, projectId, 'Imported'),
        data: { id: importedId, rows: [{ id: 'imported-row', data: ['value'] }] },
      },
    ]);

    const reloadedProvider = new BrowserDatasetProvider();
    await reloadedProvider.loadDatasets(projectId);
    assert.deepEqual(
      await reloadedProvider.getDatasetMetadata(importedId),
      metadata(importedId, projectId, 'Imported'),
    );
    assert.deepEqual(await reloadedProvider.getDatasetData(importedId), {
      id: importedId,
      rows: [{ id: 'imported-row', data: ['value'] }],
    });

    await reloadedProvider.clearDatasetData(importedId);
    assert.deepEqual(await reloadedProvider.getDatasetData(importedId), { id: importedId, rows: [] });
    await reloadedProvider.deleteDataset(importedId);

    const afterDelete = new BrowserDatasetProvider();
    await afterDelete.loadDatasets(projectId);
    assert.deepEqual(await afterDelete.getDatasetsForProject(projectId), [datasetMetadata]);
    assert.deepEqual(await afterDelete.getDatasetData(importedId), { id: importedId, rows: [] });
  });

  void it('keeps the public native-database contract isolated from the internal cached connection', async () => {
    const projectId = 'project' as ProjectId;
    const provider = new BrowserDatasetProvider();
    const publicDatabase = await provider.getDatasetDatabase();

    assert.ok(publicDatabase instanceof IDBDatabase);
    publicDatabase.close();

    await provider.loadDatasets(projectId);
    assert.deepEqual(await provider.getDatasetsForProject(projectId), []);
  });

  void it('closes the cached connection when it blocks a future schema upgrade', async () => {
    const provider = new BrowserDatasetProvider();
    await provider.loadDatasets('project' as ProjectId);

    const upgradedDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('datasets', 5);
      request.onblocked = () => reject(new Error('The cached dataset connection blocked the version upgrade.'));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    assert.equal(upgradedDatabase.version, 5);
    upgradedDatabase.close();
  });

  void it('preserves in-memory mutation order when a persistence request fails', async () => {
    const projectId = 'project' as ProjectId;
    const datasetId = 'dataset' as DatasetId;
    const provider = new BrowserDatasetProvider();
    await provider.loadDatasets(projectId);
    await provider.putDatasetMetadata(metadata(datasetId, projectId, 'Dataset'));

    const uncloneableData = {
      id: datasetId,
      rows: [{ id: 'row', data: [() => undefined] }],
    } as unknown as Dataset;

    await assert.rejects(provider.putDatasetData(datasetId, uncloneableData), /DataCloneError/);
    assert.equal(await provider.getDatasetData(datasetId), uncloneableData);
  });
});

function metadata(id: DatasetId, projectId: ProjectId, name: string): DatasetMetadata {
  return { id, projectId, name, description: `${name} description` };
}

function openLegacyDatasetDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('datasets', 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('datasets');
      request.result.createObjectStore('data');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
}

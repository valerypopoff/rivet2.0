import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { type Dataset, type DatasetId, type DatasetMetadata, type ProjectId } from '@valerypopoff/rivet2-core';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
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
      const request = indexedDB.open('datasets', 3);
      request.onblocked = () => reject(new Error('The cached dataset connection blocked the version upgrade.'));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    assert.equal(upgradedDatabase.version, 3);
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

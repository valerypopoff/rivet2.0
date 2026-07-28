import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { type Dataset, type DatasetId, type DatasetMetadata, type ProjectId } from '@valerypopoff/rivet2-core';
import { IDBFactory } from 'fake-indexeddb';
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

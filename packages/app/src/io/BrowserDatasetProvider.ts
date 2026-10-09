import {
  type DatasetRow,
  type DatasetId,
  type DatasetMetadata,
  type DatasetProvider,
  type ProjectId,
  type Dataset,
  type CombinedDataset,
} from '@valerypopoff/rivet2-core';
import { openDB, unwrap, type DBSchema, type IDBPDatabase } from 'idb';
import { cloneDeep } from 'lodash-es';
import { createRecoverableIndexedDbConnection, preserveIndexedDbRequestTiming } from '../utils/indexedDb.js';

interface DatasetDatabase extends DBSchema {
  datasets: {
    key: [ProjectId, DatasetId];
    value: DatasetMetadata;
    indexes: { 'by-project': ProjectId };
  };
  data: {
    key: [ProjectId, DatasetId];
    value: Dataset;
  };
}

export class BrowserDatasetProvider implements DatasetProvider {
  currentProjectId: ProjectId | undefined;
  #currentProjectDatasets: CombinedDataset[] = [];
  #selectionRevision = 0;
  #getDatasetDatabase = createRecoverableIndexedDbConnection(openDatasetDatabase);

  async getDatasetDatabase(): Promise<IDBDatabase> {
    return unwrap(await openDatasetDatabase());
  }

  async loadDatasets(projectId: ProjectId): Promise<void> {
    const revision = ++this.#selectionRevision;
    const datasets = await this.#readProjectDatasets(projectId);
    if (revision !== this.#selectionRevision) return;

    this.currentProjectId = projectId;
    this.#currentProjectDatasets = datasets;
  }

  async #readProjectDatasets(projectId: ProjectId): Promise<CombinedDataset[]> {
    const db = await this.#getDatasetDatabase();

    const transaction = preserveIndexedDbRequestTiming(db.transaction(['datasets', 'data'], 'readonly'));
    const metadata = await transaction.objectStore('datasets').index('by-project').getAll(projectId);

    const dataStore = transaction.objectStore('data');

    const data = await Promise.all(metadata.map((meta) => dataStore.get([projectId, meta.id])));
    await transaction.done;
    return metadata.map(
      (meta, i): CombinedDataset => ({
        meta,
        data: data[i] ?? {
          id: meta.id,
          rows: [],
        },
      }),
    );
  }

  async getDatasetMetadata(id: DatasetId): Promise<DatasetMetadata | undefined> {
    return this.#currentProjectDatasets.find((d) => d.meta.id === id)?.meta;
  }

  async getDatasetsForProject(projectId: ProjectId): Promise<DatasetMetadata[]> {
    if (this.currentProjectId !== projectId) {
      throw new Error('Project not loaded. Call loadDatasets first.');
    }

    return this.#currentProjectDatasets.map((d) => d.meta);
  }

  async getDatasetData(id: DatasetId): Promise<Dataset> {
    return (
      this.#currentProjectDatasets.find((d) => d.meta.id === id)?.data ?? {
        id,
        rows: [],
      }
    );
  }

  async putDatasetData(id: DatasetId, data: Dataset): Promise<void> {
    const dataset = this.#currentProjectDatasets.find((d) => d.meta.id === id);
    if (!dataset) {
      throw new Error(`Dataset ${id} not found`);
    }

    dataset.data = data;

    // Sync the database
    const dataStore = await this.#getDatasetDatabase();

    const transaction = preserveIndexedDbRequestTiming(dataStore.transaction('data', 'readwrite'));
    await transaction.store.put(data, [dataset.meta.projectId, id]);
  }

  async putDatasetRow(id: DatasetId, row: DatasetRow): Promise<void> {
    const dataset = this.#currentProjectDatasets.find((d) => d.meta.id === id);
    if (!dataset) {
      throw new Error(`Dataset ${id} not found`);
    }

    const existingRow = dataset.data.rows.find((r) => r.id === row.id);
    if (existingRow) {
      existingRow.data = row.data;
      existingRow.embedding = row.embedding;
    } else {
      dataset.data.rows.push(row);
    }

    // Sync the database
    const dataStore = await this.#getDatasetDatabase();

    const transaction = preserveIndexedDbRequestTiming(dataStore.transaction('data', 'readwrite'));
    await transaction.store.put(dataset.data, [dataset.meta.projectId, id]);
  }

  async putDatasetMetadata(metadata: DatasetMetadata): Promise<void> {
    const matchingDataset = this.#currentProjectDatasets.find((d) => d.meta.id === metadata.id);

    if (matchingDataset) {
      matchingDataset.meta = metadata;
    } else {
      this.#currentProjectDatasets.push({
        meta: metadata,
        data: {
          id: metadata.id,
          rows: [],
        },
      });
    }

    // Sync the database
    const metadataStore = await this.#getDatasetDatabase();

    const transaction = preserveIndexedDbRequestTiming(metadataStore.transaction('datasets', 'readwrite'));
    await transaction.store.put(metadata, [metadata.projectId, metadata.id]);
  }

  async clearDatasetData(id: DatasetId): Promise<void> {
    const dataset = this.#currentProjectDatasets.find((d) => d.meta.id === id);
    if (!dataset) {
      return;
    }

    dataset.data = {
      id,
      rows: [],
    };

    // Sync the database
    const dataStore = await this.#getDatasetDatabase();

    const transaction = preserveIndexedDbRequestTiming(dataStore.transaction('data', 'readwrite'));
    await transaction.store.delete([dataset.meta.projectId, id]);
  }

  async deleteDataset(id: DatasetId): Promise<void> {
    const index = this.#currentProjectDatasets.findIndex((d) => d.meta.id === id);
    if (index === -1) {
      return;
    }

    const [dataset] = this.#currentProjectDatasets.splice(index, 1);
    const key: [ProjectId, DatasetId] = [dataset!.meta.projectId, id];

    // Sync the database
    const metadataStore = await this.#getDatasetDatabase();

    const metaTxn = preserveIndexedDbRequestTiming(metadataStore.transaction('datasets', 'readwrite'));
    await metaTxn.store.delete(key);

    const dataStore = await this.#getDatasetDatabase();

    const dataTxn = preserveIndexedDbRequestTiming(dataStore.transaction('data', 'readwrite'));
    await dataTxn.store.delete(key);
  }

  async knnDatasetRows(
    datasetId: DatasetId,
    k: number,
    vector: number[],
  ): Promise<(DatasetRow & { distance?: number })[]> {
    const allRows = await this.getDatasetData(datasetId);

    const sorted = allRows.rows
      .filter((row) => row.embedding != null)
      .map((row) => ({
        row,
        similarity: dotProductSimilarity(vector, row.embedding!),
      }))
      .sort((a, b) => b.similarity - a.similarity);

    return sorted.slice(0, k).map((r) => ({ ...r.row, distance: r.similarity }));
  }

  async exportDatasetsForProject(projectId: ProjectId): Promise<CombinedDataset[]> {
    // Capture live edits synchronously, before the caller's first await. An
    // inactive project is read without selecting it or borrowing another tab's
    // in-memory datasets.
    if (this.currentProjectId === projectId) return cloneDeep(this.#currentProjectDatasets);
    return this.#readProjectDatasets(projectId);
  }

  async deleteStoredDatasetsForProject(projectId: ProjectId): Promise<void> {
    const revision = this.#selectionRevision;
    await this.importDatasetsForProject(projectId, [], { replace: true, activate: false });
    // Cleanup must never select a project or supersede a pending tab switch.
    if (revision === this.#selectionRevision && this.currentProjectId === projectId) {
      this.#currentProjectDatasets = [];
    }
  }

  async importDatasetsForProject(
    projectId: ProjectId,
    datasets: CombinedDataset[],
    options: { isCurrent?: () => boolean; signal?: AbortSignal; replace?: boolean; activate?: boolean } = {},
  ): Promise<void> {
    const activate = options.activate !== false;
    const revision = activate ? ++this.#selectionRevision : this.#selectionRevision;
    const isCurrent = () =>
      (!activate || revision === this.#selectionRevision) &&
      !options.signal?.aborted &&
      options.isCurrent?.() !== false;
    const db = await this.#getDatasetDatabase();
    if (!isCurrent()) throw new DOMException('Project load cancelled', 'AbortError');
    const transaction = preserveIndexedDbRequestTiming(db.transaction(['datasets', 'data'], 'readwrite'));
    const metadataStore = transaction.objectStore('datasets');
    const dataStore = transaction.objectStore('data');
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        /* already settled */
      }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (options.replace) {
        let cursor = await metadataStore.index('by-project').openCursor(projectId);
        while (cursor) {
          await dataStore.delete(cursor.primaryKey);
          await cursor.delete();
          cursor = await cursor.continue();
        }
      }
      for (const dataset of datasets) {
        // Await each issued request before issuing the next. A synchronous
        // clone/quota error must not orphan the preceding request's rejection
        // when the enclosing transaction is rolled back.
        await metadataStore.put({ ...dataset.meta, projectId }, [projectId, dataset.meta.id]);
        await dataStore.put(dataset.data, [projectId, dataset.data.id]);
      }
      await transaction.done;
      if (!isCurrent()) throw new DOMException('Project load cancelled', 'AbortError');
      if (activate) {
        this.#currentProjectDatasets = cloneDeep(
          datasets.map((dataset) => ({
            ...dataset,
            meta: { ...dataset.meta, projectId },
          })),
        );
        this.currentProjectId = projectId;
      }
    } catch (error) {
      abort();
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

/** OpenAI embeddings are already normalized, so this is equivalent to cosine similarity */
const dotProductSimilarity = (a: number[], b: number[]): number => {
  return a.reduce((acc, val, i) => acc + val * b[i]!, 0);
};

function openDatasetDatabase(onUnavailable?: () => void): Promise<IDBPDatabase<DatasetDatabase>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error('Browser IndexedDB storage is unavailable. Enable browser storage and retry opening the project.'),
    );
  }
  let database: IDBPDatabase<DatasetDatabase> | undefined;

  return openDB<DatasetDatabase>('datasets', 4, {
    upgrade(upgradeDatabase, oldVersion, _newVersion, transaction) {
      preserveIndexedDbRequestTiming(transaction);
      if (!upgradeDatabase.objectStoreNames.contains('datasets')) {
        upgradeDatabase.createObjectStore('datasets');
      }

      if (!upgradeDatabase.objectStoreNames.contains('data')) {
        upgradeDatabase.createObjectStore('data');
      }
      const metadataStore = transaction.objectStore('datasets');
      if (!metadataStore.indexNames.contains('by-project')) {
        metadataStore.createIndex('by-project', 'projectId');
      }
      if (oldVersion > 0 && oldVersion < 4) {
        // Migrate one legacy dataset at a time within the upgrade transaction.
        // Keep runtime IDs unchanged; only browser storage keys gain an owner.
        const nativeTransaction = unwrap(transaction);
        const metadata = nativeTransaction.objectStore('datasets');
        const data = nativeTransaction.objectStore('data');
        const request = metadata.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (Array.isArray(cursor.primaryKey)) {
            cursor.continue();
            return;
          }
          const value = cursor.value as DatasetMetadata;
          const key = [value.projectId, value.id];
          const payload = data.get(cursor.primaryKey);
          payload.onsuccess = () => {
            metadata.put(value, key);
            if (payload.result !== undefined) data.put(payload.result, key);
            data.delete(cursor.primaryKey);
            cursor.delete();
            cursor.continue();
          };
        };
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

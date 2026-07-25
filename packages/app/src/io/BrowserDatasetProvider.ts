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
import { preserveIndexedDbRequestTiming } from '../utils/indexedDb.js';

interface DatasetDatabase extends DBSchema {
  datasets: {
    key: string;
    value: DatasetMetadata;
  };
  data: {
    key: string;
    value: Dataset;
  };
}

export class BrowserDatasetProvider implements DatasetProvider {
  currentProjectId: ProjectId | undefined;
  #currentProjectDatasets: CombinedDataset[] = [];
  #databasePromise: Promise<IDBPDatabase<DatasetDatabase>> | undefined;

  async getDatasetDatabase(): Promise<IDBDatabase> {
    return unwrap(await openDatasetDatabase());
  }

  #getDatasetDatabase(): Promise<IDBPDatabase<DatasetDatabase>> {
    if (this.#databasePromise == null) {
      const guarded = openDatasetDatabase(() => {
        if (this.#databasePromise === guarded) {
          this.#databasePromise = undefined;
        }
      }).catch((error: unknown) => {
        if (this.#databasePromise === guarded) {
          this.#databasePromise = undefined;
        }
        throw error;
      });
      this.#databasePromise = guarded;
    }

    return this.#databasePromise;
  }

  async loadDatasets(projectId: ProjectId): Promise<void> {
    const db = await this.#getDatasetDatabase();

    const metadataTransaction = preserveIndexedDbRequestTiming(db.transaction('datasets', 'readonly'));
    const store = metadataTransaction.store;

    const metadata: DatasetMetadata[] = [];

    let cursor = await store.openCursor();
    while (cursor) {
      if (cursor.value.projectId === projectId) {
        metadata.push(cursor.value);
      }
      cursor = await cursor.continue();
    }

    const dataTransaction = preserveIndexedDbRequestTiming(db.transaction('data', 'readonly'));
    const dataStore = dataTransaction.store;

    const data = await Promise.all(metadata.map((meta) => dataStore.get(meta.id)));

    this.currentProjectId = projectId;
    this.#currentProjectDatasets = metadata.map(
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
    await transaction.store.put(data, id);
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
    await transaction.store.put(dataset.data, id);
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
    await transaction.store.put(metadata, metadata.id);
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
    await transaction.store.delete(id);
  }

  async deleteDataset(id: DatasetId): Promise<void> {
    const index = this.#currentProjectDatasets.findIndex((d) => d.meta.id === id);
    if (index === -1) {
      return;
    }

    this.#currentProjectDatasets.splice(index, 1);

    // Sync the database
    const metadataStore = await this.#getDatasetDatabase();

    const metaTxn = preserveIndexedDbRequestTiming(metadataStore.transaction('datasets', 'readwrite'));
    await metaTxn.store.delete(id);

    const dataStore = await this.#getDatasetDatabase();

    const dataTxn = preserveIndexedDbRequestTiming(dataStore.transaction('data', 'readwrite'));
    await dataTxn.store.delete(id);
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

  async exportDatasetsForProject(_projectId: ProjectId): Promise<CombinedDataset[]> {
    return cloneDeep(this.#currentProjectDatasets);
  }

  async importDatasetsForProject(projectId: ProjectId, datasets: CombinedDataset[]) {
    this.#currentProjectDatasets = datasets;
    this.currentProjectId = projectId;

    const db = await this.#getDatasetDatabase();
    const transaction = preserveIndexedDbRequestTiming(db.transaction(['datasets', 'data'], 'readwrite'));

    const metadataStore = transaction.objectStore('datasets');
    const dataStore = transaction.objectStore('data');

    await Promise.all(
      datasets.map(async (dataset) => {
        await Promise.all([
          metadataStore.put(dataset.meta, dataset.meta.id),
          dataStore.put(dataset.data, dataset.data.id),
        ]);
      }),
    );
  }
}

/** OpenAI embeddings are already normalized, so this is equivalent to cosine similarity */
const dotProductSimilarity = (a: number[], b: number[]): number => {
  return a.reduce((acc, val, i) => acc + val * b[i]!, 0);
};

function openDatasetDatabase(onUnavailable?: () => void): Promise<IDBPDatabase<DatasetDatabase>> {
  let database: IDBPDatabase<DatasetDatabase> | undefined;

  return openDB<DatasetDatabase>('datasets', 2, {
    upgrade(upgradeDatabase) {
      if (!upgradeDatabase.objectStoreNames.contains('datasets')) {
        upgradeDatabase.createObjectStore('datasets');
      }

      if (!upgradeDatabase.objectStoreNames.contains('data')) {
        upgradeDatabase.createObjectStore('data');
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

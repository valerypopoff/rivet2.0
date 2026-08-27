import type { CombinedDataset, DatasetMetadata, ProjectId } from '@valerypopoff/rivet2-core';
import { BrowserDatasetProvider } from '../../../rivet/packages/app/src/io/BrowserDatasetProvider';

export class HostedDatasetProvider extends BrowserDatasetProvider {
  private async clearStoredDatasetsForProject(projectId: ProjectId): Promise<void> {
    const db = await this.getDatasetDatabase();

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['datasets', 'data'], 'readwrite');
      const metadataStore = transaction.objectStore('datasets');
      const dataStore = transaction.objectStore('data');
      const cursorRequest = metadataStore.openCursor();
      const getTransactionError = () => transaction.error ?? new Error('Dataset cleanup failed');

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(getTransactionError());
      transaction.onabort = () => reject(getTransactionError());

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          return;
        }

        const metadata = cursor.value as Partial<DatasetMetadata>;
        if (metadata.projectId === projectId) {
          const datasetId = typeof metadata.id === 'string'
            ? metadata.id
            : typeof cursor.key === 'string'
              ? cursor.key
              : undefined;

          cursor.delete();
          if (datasetId) {
            dataStore.delete(datasetId);
          }
        }

        cursor.continue();
      };
    });
  }

  async deleteStoredDatasetsForProject(projectId: ProjectId): Promise<void> {
    await this.clearStoredDatasetsForProject(projectId);

    if (this.currentProjectId === projectId) {
      await super.importDatasetsForProject(projectId, []);
    }
  }

  override async importDatasetsForProject(projectId: ProjectId, datasets: CombinedDataset[]): Promise<void> {
    await this.clearStoredDatasetsForProject(projectId);
    await super.importDatasetsForProject(projectId, datasets);
  }
}

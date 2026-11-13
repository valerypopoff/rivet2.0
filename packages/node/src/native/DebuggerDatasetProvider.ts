import {
  type CombinedDataset,
  type Dataset,
  type DatasetId,
  type DatasetMetadata,
  type DatasetProvider,
  type DatasetRow,
  type ProjectId,
  newId,
} from '@valerypopoff/rivet2-core';

export class DebuggerDatasetProvider implements DatasetProvider {
  listeners: Record<string, (payload: any) => void> = {};
  #reject = new Map<string, (reason: unknown) => void>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();

  onrequest: ((type: string, data: any) => void) | undefined;

  handleResponse(type: string, data: any) {
    const { requestId, payload } = data;

    if (type === 'datasets:response') {
      const listener = this.listeners[requestId];
      if (listener) {
        if (typeof data.error === 'string') this.rejectRequest(requestId, new Error(data.error));
        else listener(payload);
      }
    }
  }

  makeRequestAndWaitForResponse<T>(type: `datasets:${string}`, data: any): Promise<T> {
    const requestId = newId();

    const waitingPromise = new Promise<T>((resolve, reject) => {
      const clean = () => {
        clearTimeout(this.#timers.get(requestId));
        this.#timers.delete(requestId);
        this.#reject.delete(requestId);
        delete this.listeners[requestId];
      };
      this.#reject.set(requestId, (error) => {
        clean();
        reject(error);
      });
      this.listeners[requestId] = (response: any) => {
        clean();
        resolve(response);
      };
      const timer = setTimeout(
        () =>
          this.rejectRequest(requestId, new Error('Executor dataset response expired. The operation was not retried.')),
        120_000,
      );
      timer.unref?.();
      this.#timers.set(requestId, timer);
    });

    try {
      if (!this.onrequest) throw new Error('Executor dataset bridge is unavailable');
      this.onrequest(type, { requestId, payload: data });
    } catch (error) {
      this.rejectRequest(requestId, error);
    }

    return waitingPromise;
  }

  rejectRequest(requestId: string, error: unknown) {
    this.#reject.get(requestId)?.(error);
  }
  dispose() {
    for (const id of [...this.#reject.keys()]) this.rejectRequest(id, new Error('Executor dataset session closed.'));
  }

  getDatasetMetadata(id: DatasetId): Promise<DatasetMetadata | undefined> {
    return this.makeRequestAndWaitForResponse(`datasets:get-metadata`, { id });
  }

  getDatasetsForProject(projectId: ProjectId): Promise<DatasetMetadata[]> {
    return this.makeRequestAndWaitForResponse(`datasets:get-for-project`, { projectId });
  }

  getDatasetData(id: DatasetId): Promise<Dataset> {
    return this.makeRequestAndWaitForResponse(`datasets:get-data`, { id });
  }

  putDatasetData(id: DatasetId, data: Dataset): Promise<void> {
    return this.makeRequestAndWaitForResponse(`datasets:put-data`, { id, data });
  }

  putDatasetRow(id: DatasetId, row: DatasetRow): Promise<void> {
    return this.makeRequestAndWaitForResponse(`datasets:put-row`, { id, row });
  }

  putDatasetMetadata(metadata: DatasetMetadata): Promise<void> {
    return this.makeRequestAndWaitForResponse(`datasets:put-metadata`, { metadata });
  }

  clearDatasetData(id: DatasetId): Promise<void> {
    return this.makeRequestAndWaitForResponse(`datasets:clear-data`, { id });
  }

  deleteDataset(id: DatasetId): Promise<void> {
    return this.makeRequestAndWaitForResponse(`datasets:delete`, { id });
  }

  knnDatasetRows(
    datasetId: DatasetId,
    k: number,
    vector: number[],
  ): Promise<(DatasetRow & { distance?: number | undefined })[]> {
    return this.makeRequestAndWaitForResponse(`datasets:knn`, { datasetId, k, vector });
  }

  exportDatasetsForProject(projectId: ProjectId): Promise<CombinedDataset[]> {
    return this.makeRequestAndWaitForResponse(`datasets:export-for-project`, { projectId });
  }
}

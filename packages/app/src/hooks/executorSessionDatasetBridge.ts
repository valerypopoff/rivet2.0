import type { DatasetRequestMap, DatasetRequestPayload, OutgoingMessage } from '@valerypopoff/rivet2-core';
import type { AppDatasetProvider } from '../providers/ProvidersContext.js';
import { handleError } from '../utils/errorHandling.js';
import type { ExecutorSessionTarget } from './executorSessionTarget.js';
import { safeSendExecutorSocket } from './executorSessionTransport.js';

export function handleExecutorDatasetRequest(options: {
  data: DatasetRequestPayload<unknown>;
  datasetProvider: AppDatasetProvider | null;
  message: keyof DatasetRequestMap;
  socket: WebSocket;
  target: ExecutorSessionTarget;
  sendResponse?: (requestId: string, payload: unknown) => void;
}): void {
  const { data, datasetProvider, message, socket, target } = options;
  if (!datasetProvider) {
    return;
  }

  void processExecutorDatasetRequest({
    data,
    datasetProvider,
    message,
    socket,
    target,
    sendResponse: options.sendResponse,
  }).catch((error) => {
    handleError(error, 'Failed to handle executor dataset request', {
      metadata: {
        requestId: getExecutorDatasetRequestId(data),
        socketUrl: socket.url,
        target: target.type,
        type: message,
      },
      toastError: false,
    });
  });
}

export async function processExecutorDatasetRequest(options: {
  data: DatasetRequestPayload<unknown>;
  datasetProvider: AppDatasetProvider;
  message: keyof DatasetRequestMap;
  socket: WebSocket;
  target: ExecutorSessionTarget;
  sendResponse?: (requestId: string, payload: unknown) => void;
}): Promise<void> {
  const { data, datasetProvider, message, socket, target } = options;
  const { payload, requestId } = data as DatasetRequestPayload<any>;
  const sendResponse = (response: unknown) => options.sendResponse
    ? options.sendResponse(requestId, response)
    : sendExecutorDatasetResponse(socket, requestId, response, target);

  switch (message) {
    case 'datasets:get-metadata':
      return sendResponse(await datasetProvider.getDatasetMetadata(payload.id));
    case 'datasets:get-for-project':
      return sendResponse(await datasetProvider.getDatasetsForProject(payload.projectId));
    case 'datasets:get-data':
      return sendResponse(await datasetProvider.getDatasetData(payload.id));
    case 'datasets:put-data':
      await datasetProvider.putDatasetData(payload.id, payload.data);
      return sendResponse(undefined);
    case 'datasets:put-row':
      await datasetProvider.putDatasetRow(payload.id, payload.row);
      return sendResponse(undefined);
    case 'datasets:put-metadata':
      await datasetProvider.putDatasetMetadata(payload.metadata);
      return sendResponse(undefined);
    case 'datasets:clear-data':
      await datasetProvider.clearDatasetData(payload.id);
      return sendResponse(undefined);
    case 'datasets:delete':
      await datasetProvider.deleteDataset(payload.id);
      return sendResponse(undefined);
    case 'datasets:knn':
      return sendResponse(await datasetProvider.knnDatasetRows(payload.datasetId, payload.k, payload.vector));
    default:
      handleError(new Error(`Unknown datasets message type: ${String(message)}`), 'Failed to handle datasets message', {
        metadata: {
          requestId,
          target: target.type,
          type: message,
        },
        toastError: false,
      });
  }
}

export function getExecutorDatasetRequestId(data: unknown): string | undefined {
  return typeof data === 'object' && data != null && 'requestId' in data ? String(data.requestId) : undefined;
}

function sendExecutorDatasetResponse(
  socket: WebSocket,
  requestId: string,
  payload: unknown,
  target: ExecutorSessionTarget,
) {
  const msg: OutgoingMessage = { type: 'datasets:response', data: { payload, requestId } };
  safeSendExecutorSocket(socket, JSON.stringify(msg), 'Failed to send executor dataset response', {
    requestId,
    target: target.type,
  });
}

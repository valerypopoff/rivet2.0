import type WebSocket from 'ws';
import {
  RIVET_WEB_APP_BROWSER_STORAGE_RPC_CAPABILITY,
  RIVET_WEB_APP_ACTION_PROTOCOL_VERSION,
  parseRivetWebAppClientMessage,
  type RivetWebAppActionStartMessage,
  type RivetWebAppBrowserStorageClientMessage,
  type RivetWebAppBrowserStorageRpcAdvertisedLimits,
} from '@valerypopoff/rivet2-core';
import { startWebSocketHeartbeat } from './webSocketHeartbeat.js';
import {
  getWebAppSocketMessageByteLength,
  isWebAppSocketMessageType,
  parseWebAppSocketMessage,
  readWebAppSocketRequestId,
  sendWebAppSocketMessage,
} from './webAppSocketProtocol.js';

export function attachWebAppSocketSession(
  socket: WebSocket,
  options: {
    handshakeTimeoutMs: number;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    maxMessageBytes: number;
    browserStorageRpcLimits: RivetWebAppBrowserStorageRpcAdvertisedLimits;
    onActionCancel(runId: string): Promise<void>;
    onActionStart(message: RivetWebAppActionStartMessage): Promise<void>;
    onCleanup(): void;
    onError(error: unknown): void;
    onInvalidMessage(requestId: string, error: Error): void;
    onRunResume(runId: string, lastSequence: number): Promise<void>;
    onStorageBinary(frame: WebSocket.RawData): void;
    onStorageMessage(message: RivetWebAppBrowserStorageClientMessage): void;
  },
): void {
  const heartbeat = startWebSocketHeartbeat(socket, {
    intervalMs: options.heartbeatIntervalMs,
    timeoutMs: options.heartbeatTimeoutMs,
  });
  let protocolReady = false;
  let storageRpcReady = false;
  let handshakeTimeout: ReturnType<typeof setTimeout> | undefined;
  if (options.handshakeTimeoutMs > 0) {
    handshakeTimeout = setTimeout(() => {
      if (!protocolReady) socket.close(1002, 'Protocol handshake timed out');
    }, options.handshakeTimeoutMs);
    handshakeTimeout.unref?.();
  }

  const dispatch = (operation: Promise<void>, failureMessage: string): void => {
    void operation.catch((error) => {
      options.onError(error);
      socket.close(1011, failureMessage);
    });
  };

  socket.on('message', (raw, isBinary) => {
    heartbeat.markActivity();
    if (isBinary) {
      if (!protocolReady || !storageRpcReady) return socket.close(1002, 'Storage RPC handshake required');
      options.onStorageBinary(raw);
      return;
    }
    if (getWebAppSocketMessageByteLength(raw) > options.maxMessageBytes) {
      socket.close(1009, 'Message too large');
      return;
    }
    const parsed = parseWebAppSocketMessage(raw);
    const message = parseRivetWebAppClientMessage(parsed);
    if (!message) {
      if (isWebAppSocketMessageType(parsed, 'client.hello')) {
        socket.close(1002, 'Unsupported protocol version');
      } else {
        options.onInvalidMessage(
          readWebAppSocketRequestId(parsed) ?? 'invalid-request',
          new Error('Invalid web app action message.'),
        );
      }
      return;
    }

    if (message.type === 'client.hello') {
      storageRpcReady = message.capabilities?.includes(RIVET_WEB_APP_BROWSER_STORAGE_RPC_CAPABILITY) === true;
      protocolReady = true;
      if (handshakeTimeout) {
        clearTimeout(handshakeTimeout);
        handshakeTimeout = undefined;
      }
      sendWebAppSocketMessage(socket, {
        type: 'server.ready',
        protocolVersion: RIVET_WEB_APP_ACTION_PROTOCOL_VERSION,
        ...(storageRpcReady
          ? {
              capabilities: [RIVET_WEB_APP_BROWSER_STORAGE_RPC_CAPABILITY],
              browserStorageRpcLimits: options.browserStorageRpcLimits,
            }
          : {}),
      });
      return;
    }
    if (!protocolReady) {
      socket.close(1002, 'Protocol handshake required');
      return;
    }

    if (message.type === 'action.start') {
      if (message.storageRpcVersion === 2 && !storageRpcReady) {
        options.onInvalidMessage(message.requestId, new Error('Browser storage RPC v2 was not negotiated.'));
        return;
      }
      dispatch(options.onActionStart(message), 'Action setup failed');
    } else if (message.type === 'run.resume') {
      dispatch(options.onRunResume(message.runId, message.lastSequence), 'Run store failed');
    } else if (message.type === 'action.cancel') {
      dispatch(options.onActionCancel(message.runId), 'Run store failed');
    } else {
      options.onStorageMessage(message);
    }
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (handshakeTimeout) clearTimeout(handshakeTimeout);
    heartbeat.stop();
    options.onCleanup();
  };
  socket.once('close', cleanup);
  socket.once('error', cleanup);
}

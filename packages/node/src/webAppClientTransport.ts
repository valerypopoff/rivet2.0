import {
  parseRivetWebAppServerMessage,
  RIVET_WEB_APP_ACTION_PROTOCOL_VERSION,
  RIVET_WEB_APP_BROWSER_STORAGE_RPC_CAPABILITY,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTION_BYTES,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_VALUE_BYTES,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_TRANSFER_TIMEOUT_MS,
  RIVET_WEB_APP_BROWSER_STORAGE_SAFE_FALLBACK_BYTES,
  type GraphProgress,
  type AgentResponseTrace,
  type RivetWebAppBrowserStorageServerMessage,
  type RivetWebAppBrowserStorageRpcAdvertisedLimits,
} from '@valerypopoff/rivet2-core/web-app-runtime';
import type { WebAppClientConfig } from './webAppClientTypes.js';
import { WebAppClientStorageRpc, type HostedBrowserStorageBridge } from './webAppClientStorageRpc.js';
const DEFAULT_CLIENT_STORAGE_RPC_LIMITS: RivetWebAppBrowserStorageRpcAdvertisedLimits = {
  maxActionBytes: RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTION_BYTES,
  maxValueBytes: RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_VALUE_BYTES,
  transferTimeoutMs: RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_TRANSFER_TIMEOUT_MS,
};

export type { HostedBrowserStorageBridge } from './webAppClientStorageRpc.js';

type WebAppActionResponse = {
  code?: string;
  error?: string;
  statePatch?: Record<string, unknown>;
  storagePatch?: Record<string, unknown>;
  responseTrace?: AgentResponseTrace;
};

export type HostedActionRunner = {
  survivesPageDetach: boolean;
  dispose(): void;
  run(options: {
    componentId: string;
    onProgress(progress: GraphProgress): void;
    revisionKey?: string;
    signal: AbortSignal;
    state: Record<string, unknown>;
    storage?: Record<string, unknown>;
    browserStorage?: HostedBrowserStorageBridge;
  }): Promise<{
    statePatch?: Record<string, unknown>;
    storagePatch?: Record<string, unknown>;
    responseTrace?: AgentResponseTrace;
  }>;
};

export class HostedActionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly responseTrace?: AgentResponseTrace,
  ) {
    super(message);
  }
}

export function createHostedActionRunner(config: WebAppClientConfig): HostedActionRunner {
  const transport =
    config.actionTransport ??
    (config.actionPath ? { type: 'http' as const, actionPath: config.actionPath } : undefined);
  if (!transport) {
    return {
      survivesPageDetach: false,
      dispose: () => undefined,
      run: async () => {
        throw new Error('Rivet web app action transport is not configured.');
      },
    };
  }
  return transport.type === 'websocket'
    ? createWebSocketActionRunner(transport.socketPath)
    : createHttpActionRunner(transport.actionPath);
}

function createHttpActionRunner(actionPath: string): HostedActionRunner {
  return {
    survivesPageDetach: false,
    dispose: () => undefined,
    async run({ browserStorage, componentId, revisionKey, signal, state, storage }) {
      const snapshot = browserStorage ? await browserStorage.loadSnapshot() : storage ?? {};
      if (browserStorage && serializedByteLength(snapshot) > RIVET_WEB_APP_BROWSER_STORAGE_SAFE_FALLBACK_BYTES) {
        const error = new HostedActionError(
          'This Stored Value state is too large for HTTP action transport. Use a current Studio Server WebSocket endpoint with browser-storage RPC v2.',
          'browser_storage_rpc_required',
        );
        browserStorage.reportTransportIncompatibility?.(error.message);
        throw error;
      }
      browserStorage?.clearTransportIncompatibility?.();
      const response = await fetch(actionPath, {
        body: JSON.stringify({ componentId, revisionKey, state, storage: snapshot }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal,
      });
      const result = await readHostedActionResponse(response);
      if (!response.ok) {
        throw new HostedActionError(result.error || 'Action failed.', result.code, result.responseTrace);
      }
      return {
        statePatch: result.statePatch,
        storagePatch: result.storagePatch,
        responseTrace: result.responseTrace,
      };
    },
  };
}

function createWebSocketActionRunner(socketPath: string): HostedActionRunner {
  type PendingAction = {
    abortListener: () => void;
    lastSequence: number;
    message: {
      type: 'action.start';
      requestId: string;
      componentId: string;
      revisionKey?: string;
      state: Record<string, unknown>;
    };
    browserStorage?: HostedBrowserStorageBridge;
    legacyStorage?: Record<string, unknown>;
    onProgress(progress: GraphProgress): void;
    reject(error: unknown): void;
    resolve(result: {
      statePatch?: Record<string, unknown>;
      storagePatch?: Record<string, unknown>;
      responseTrace?: AgentResponseTrace;
    }): void;
    runId?: string;
    settled: boolean;
    signal: AbortSignal;
    sendingStart: boolean;
    storageRpc?: WebAppClientStorageRpc;
    startSent: boolean;
  };

  const pendingByRequestId = new Map<string, PendingAction>();
  const pendingByRunId = new Map<string, PendingAction>();
  let socket: WebSocket | undefined;
  let protocolReady = false;
  let storageRpcReady = false;
  let reconnectAttempt = 0;
  let storageRpcLimits = DEFAULT_CLIENT_STORAGE_RPC_LIMITS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const settlePending = (pending: PendingAction, settle: () => void): void => {
    if (pending.settled) return;
    pending.settled = true;
    pending.signal.removeEventListener('abort', pending.abortListener);
    pending.storageRpc?.dispose();
    pendingByRequestId.delete(pending.message.requestId);
    if (pending.runId) pendingByRunId.delete(pending.runId);
    settle();
  };
  const sendRaw = (message: unknown): boolean => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };
  const sendBinary = (frame: Uint8Array): boolean => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(frame);
      return true;
    } catch {
      return false;
    }
  };
  const send = (message: unknown): boolean => protocolReady && sendRaw(message);
  const sendPending = (pending: PendingAction): void => {
    if (pending.runId) {
      send({ type: 'run.resume', runId: pending.runId, lastSequence: pending.lastSequence });
      if (pending.signal.aborted) send({ type: 'action.cancel', runId: pending.runId });
    } else if ((!pending.signal.aborted || pending.startSent) && !pending.sendingStart) {
      pending.sendingStart = true;
      void (async () => {
        try {
          const useRpc = storageRpcReady && pending.browserStorage != null;
          if (useRpc) pending.browserStorage?.clearTransportIncompatibility?.();
          const storage = useRpc
            ? undefined
            : pending.browserStorage
              ? await pending.browserStorage.loadSnapshot()
              : pending.legacyStorage ?? {};
          if (storage != null && serializedByteLength(storage) > RIVET_WEB_APP_BROWSER_STORAGE_SAFE_FALLBACK_BYTES) {
            const error = new HostedActionError(
              'This Stored Value state requires browser-storage RPC v2, but the server or proxy did not negotiate it. Update the server before running this action.',
              'browser_storage_rpc_required',
            );
            pending.browserStorage?.reportTransportIncompatibility?.(error.message);
            settlePending(pending, () => pending.reject(error));
            return;
          }
          if (!useRpc) pending.browserStorage?.clearTransportIncompatibility?.();
          pending.startSent =
            send({
              ...pending.message,
              ...(useRpc ? { storageRpcVersion: 2 } : { storage: storage ?? {} }),
            }) || pending.startSent;
        } catch (error) {
          settlePending(pending, () => pending.reject(error));
        } finally {
          pending.sendingStart = false;
        }
      })();
    }
  };
  const scheduleReconnect = (): void => {
    if (reconnectTimer || disposed) return;
    const delay = Math.min(10_000, 250 * 2 ** reconnectAttempt) + Math.floor(Math.random() * 200);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };
  const connect = (): void => {
    if (disposed || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    try {
      const url = new URL(socketPath, window.location.href);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      else if (url.protocol === 'https:') url.protocol = 'wss:';
      else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error(`Unsupported web app WebSocket protocol: ${url.protocol}`);
      }
      socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      protocolReady = false;
      storageRpcReady = false;
    } catch (error) {
      for (const pending of [...pendingByRequestId.values()]) {
        settlePending(pending, () => pending.reject(error));
      }
      return;
    }
    socket.addEventListener('open', () => {
      sendRaw({
        type: 'client.hello',
        protocolVersion: RIVET_WEB_APP_ACTION_PROTOCOL_VERSION,
        capabilities: [RIVET_WEB_APP_BROWSER_STORAGE_RPC_CAPABILITY],
      });
    });
    socket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        const sourceSocket = socket;
        void (async () => {
          for (const pending of pendingByRequestId.values()) {
            if (pending.storageRpc && (await pending.storageRpc.handleBinary(event.data))) return;
          }
          if (socket === sourceSocket && sourceSocket?.readyState === WebSocket.OPEN) {
            sourceSocket.close(1002, 'Unexpected browser storage frame');
          }
        })();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const message = parseRivetWebAppServerMessage(value);
      if (!message) return;
      if (message.type === 'server.ready') {
        protocolReady = true;
        storageRpcReady = message.capabilities?.includes(RIVET_WEB_APP_BROWSER_STORAGE_RPC_CAPABILITY) === true;
        reconnectAttempt = 0;
        storageRpcLimits = message.browserStorageRpcLimits ?? DEFAULT_CLIENT_STORAGE_RPC_LIMITS;
        for (const pending of pendingByRequestId.values()) sendPending(pending);
        return;
      }
      if (message.type === 'server.draining') return;
      if (isStorageServerMessage(message)) {
        const pending = pendingByRunId.get(message.runId) ?? pendingByRequestId.get(message.requestId);
        if (pending?.storageRpc) {
          void pending.storageRpc.handleMessage(message);
        }
        return;
      }
      if (message.type === 'action.rejected') {
        const pending = pendingByRequestId.get(message.requestId);
        if (pending) settlePending(pending, () => pending.reject(new HostedActionError(message.error, message.code)));
        return;
      }
      if (message.type === 'run.rejected') {
        const pending = pendingByRunId.get(message.runId);
        if (pending) settlePending(pending, () => pending.reject(new HostedActionError(message.error, message.code)));
        return;
      }

      const pending = pendingByRunId.get(message.runId) ?? pendingByRequestId.get(message.requestId);
      if (!pending || message.sequence <= pending.lastSequence) return;
      pending.lastSequence = message.sequence;
      if (message.type === 'action.accepted') {
        pending.runId = message.runId;
        pendingByRunId.set(message.runId, pending);
        if (storageRpcReady && pending.browserStorage) {
          pending.storageRpc = new WebAppClientStorageRpc({
            bridge: pending.browserStorage,
            requestId: pending.message.requestId,
            limits: storageRpcLimits,
            runId: () => pending.runId,
            sendBinary,
            sendJson: send,
            onFatal(error) {
              if (pending.runId) send({ type: 'action.cancel', runId: pending.runId });
              settlePending(pending, () => pending.reject(error));
            },
          });
        }
        if (pending.signal.aborted) send({ type: 'action.cancel', runId: message.runId });
      } else if (message.type === 'action.progress') {
        pending.onProgress(message.progress);
      } else if (message.type === 'action.completed') {
        settlePending(pending, () =>
          pending.resolve({
            statePatch: message.statePatch,
            storagePatch: message.storagePatch,
            responseTrace: message.responseTrace,
          }),
        );
      } else if (message.type === 'action.failed') {
        settlePending(pending, () =>
          pending.reject(new HostedActionError(message.error, message.code, message.responseTrace)),
        );
      } else if (message.type === 'action.cancelled') {
        settlePending(pending, () => pending.reject(new DOMException('The action was cancelled.', 'AbortError')));
      } else if (message.type === 'action.interrupted') {
        settlePending(pending, () => pending.reject(new HostedActionError(message.error, 'action_interrupted')));
      }
    });
    socket.addEventListener('close', (event) => {
      socket = undefined;
      protocolReady = false;
      storageRpcReady = false;
      if (isNonRetryableWebSocketClose(event.code)) {
        const message = event.reason.trim() || `Web app action connection closed (${event.code}).`;
        for (const pending of [...pendingByRequestId.values()]) {
          settlePending(pending, () => pending.reject(new HostedActionError(message, 'websocket_closed')));
        }
        return;
      }
      if (!disposed && pendingByRequestId.size > 0) scheduleReconnect();
    });
  };

  return {
    survivesPageDetach: true,
    dispose() {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close(1000, 'Page detached');
      socket = undefined;
      const error = new DOMException('The page detached from the action.', 'AbortError');
      for (const pending of [...pendingByRequestId.values()]) {
        settlePending(pending, () => pending.reject(error));
      }
    },
    run({ browserStorage, componentId, onProgress, revisionKey, signal, state, storage }) {
      if (disposed) return Promise.reject(new Error('The web app action transport is closed.'));
      signal.throwIfAborted();
      const requestId = globalThis.crypto?.randomUUID?.() ?? `rivet-${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        const pending: PendingAction = {
          abortListener: () => {
            if (pending.runId) send({ type: 'action.cancel', runId: pending.runId });
            else if (!pending.startSent) settlePending(pending, () => reject(signal.reason));
          },
          lastSequence: 0,
          message: {
            type: 'action.start',
            requestId,
            componentId,
            state,
            ...(revisionKey == null ? {} : { revisionKey }),
          },
          onProgress,
          browserStorage,
          legacyStorage: storage,
          reject,
          resolve,
          settled: false,
          signal,
          sendingStart: false,
          startSent: false,
        };
        pendingByRequestId.set(requestId, pending);
        signal.addEventListener('abort', pending.abortListener, { once: true });
        connect();
        sendPending(pending);
      });
    },
  };
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isStorageServerMessage(
  message: ReturnType<typeof parseRivetWebAppServerMessage>,
): message is RivetWebAppBrowserStorageServerMessage {
  return (
    message?.type === 'storage.get' ||
    message?.type === 'storage.transfer.ack' ||
    message?.type === 'storage.commit.start' ||
    message?.type === 'storage.error'
  );
}

function isNonRetryableWebSocketClose(code: number): boolean {
  return code === 1002 || code === 1003 || code === 1007 || code === 1008 || code === 1009;
}

const getActionFailureMessage = (response: Pick<Response, 'status' | 'statusText'>): string =>
  `${response.status} ${response.statusText || 'Action failed'}`;

async function readHostedActionResponse(response: Response): Promise<WebAppActionResponse> {
  const body = (await response.text()).trim();
  if (body) {
    try {
      const result: unknown = JSON.parse(body);
      if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
        return result as WebAppActionResponse;
      }
    } catch {
      // Proxy and upstream failures may return HTML or plain text instead of action JSON.
    }
  }
  throw new Error(response.ok ? 'Action returned an invalid response.' : getActionFailureMessage(response));
}

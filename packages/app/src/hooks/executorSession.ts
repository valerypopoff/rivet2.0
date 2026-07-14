import type {
  OutgoingMessageMap,
  ProcessEventMessageMap,
  GraphOutputs,
  GraphProgress,
  RemoteRunRequestId,
} from '@valerypopoff/rivet2-core';
import { logRuntimeDebug } from '@valerypopoff/rivet2-core';
import type { AppDatasetProvider } from '../providers/ProvidersContext.js';
import { handleError } from '../utils/errorHandling.js';
import { runExecutorSessionCallback, notifyExecutorSessionCallbacks } from './executorSessionCallbackIsolation.js';
import { handleExecutorDatasetRequest } from './executorSessionDatasetBridge.js';
import {
  createExecutorSessionPendingExecutions,
  type PendingGraphExecution,
} from './executorSessionPendingExecutions.js';
import {
  createExternalDebuggerTarget,
  createInternalDesktopExecutorTarget,
  createInternalHostedExecutorTarget,
  DEFAULT_REMOTE_DEBUGGER_URL,
  executorSessionTargetsEqual,
  getExecutorSessionTargetLabel,
  INTERNAL_EXECUTOR_URL,
  isInternalExecutorTarget,
  type ExecutorSessionTarget,
} from './executorSessionTarget.js';
import {
  parseExecutorSessionIncomingMessage,
  safeSendExecutorSocket,
  serializeExecutorSessionMessage,
} from './executorSessionTransport.js';

export { DEFAULT_REMOTE_DEBUGGER_URL, INTERNAL_EXECUTOR_URL } from './executorSessionTarget.js';
export type { ExecutorSessionTarget } from './executorSessionTarget.js';

export type ExecutorSessionStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting';

export type ExecutorSessionCapabilities = {
  canBridgeDatasets: boolean;
  canRecordSocket: boolean;
  canSendAbort: boolean;
  canSendPause: boolean;
  canSendResume: boolean;
  canSendRun: boolean;
  canUploadProject: boolean;
};

export type ExecutorSessionState = {
  capabilities: ExecutorSessionCapabilities;
  isInternalExecutor: boolean;
  reconnecting: boolean;
  remoteUploadAllowed: boolean;
  socket: WebSocket | null;
  started: boolean;
  status: ExecutorSessionStatus;
  target: ExecutorSessionTarget | null;
  url: string;
};

type MaybePromise<T> = T | Promise<T>;

type DebuggerMessageHandler = <K extends keyof ProcessEventMessageMap>(
  message: K,
  data: ProcessEventMessageMap[K],
  requestId?: RemoteRunRequestId,
) => MaybePromise<void>;

export type ExecutorSessionDisconnectReason = 'manual-disconnect' | 'unexpected-disconnect' | 'replaced';
export type ExecutorSessionDisconnectOptions = {
  reason?: ExecutorSessionDisconnectReason;
};

export type ExecutorSessionConnectedEvent = {
  isInternalExecutor: boolean;
  reason: 'connected';
  status: ExecutorSessionStatus;
  target: ExecutorSessionTarget;
  type: 'connected';
  url: string;
};

export type ExecutorSessionDisconnectedEvent = {
  isInternalExecutor: boolean;
  reason: ExecutorSessionDisconnectReason;
  status: ExecutorSessionStatus;
  target: ExecutorSessionTarget | null;
  type: 'disconnected';
  url: string;
};

export type ExecutorSessionLifecycleEvent = ExecutorSessionConnectedEvent | ExecutorSessionDisconnectedEvent;

type LifecycleCallback = (event: ExecutorSessionLifecycleEvent) => MaybePromise<void>;
type StateChangeCallback = () => MaybePromise<void>;
export type { PendingGraphExecution } from './executorSessionPendingExecutions.js';

export type ExecutorSessionRuntime = {
  buildSessionState(legacyDebuggerConfig?: unknown, legacyConnectionState?: unknown): ExecutorSessionState;
  connect(url?: string): Promise<void>;
  connectExternalDebugger(url?: string): Promise<void>;
  connectInternal(url?: string): Promise<void>;
  connectInternalDesktopExecutor(): Promise<void>;
  connectInternalHostedExecutor(url: string): Promise<void>;
  createPendingGraphExecution(
    requestId?: RemoteRunRequestId,
    onProgress?: (progress: GraphProgress) => void,
  ): PendingGraphExecution;
  createRemoteExecutionRequest(): RemoteRunRequestId;
  disconnect(options?: ExecutorSessionDisconnectOptions): void;
  getActiveGraphRunRequestId(): RemoteRunRequestId | null;
  getRuntimeState(): Pick<
    ExecutorSessionState,
    'capabilities' | 'isInternalExecutor' | 'remoteUploadAllowed' | 'socket' | 'status' | 'target' | 'url'
  >;
  isReady(): boolean;
  rejectPendingGraphExecution(requestId: RemoteRunRequestId | undefined, reason: unknown): void;
  reportPendingGraphProgress(requestId: RemoteRunRequestId | undefined, progress: GraphProgress): void;
  recordSocketEvents(recordSocket: (socket: WebSocket) => Promise<void>): Promise<void> | undefined;
  resolvePendingGraphExecution(requestId: RemoteRunRequestId | undefined, outputs: GraphOutputs): void;
  sendMessage<T extends keyof OutgoingMessageMap>(type: T, data: OutgoingMessageMap[T]): boolean;
  sendRaw(data: string): boolean;
  setActiveGraphRunRequestId(requestId: RemoteRunRequestId | null): void;
  setDatasetProvider(datasetProvider: AppDatasetProvider | null): void;
  subscribeLifecycle(type: 'connect' | 'disconnect', callback: LifecycleCallback): () => void;
  subscribeMessages(handler: DebuggerMessageHandler): () => void;
};

export function createExecutorSessionRuntime(options: {
  datasetProvider?: AppDatasetProvider | null;
  onStateChange: StateChangeCallback;
}): ExecutorSessionRuntime {
  let currentDatasetProvider: AppDatasetProvider | null = options.datasetProvider ?? null;
  let currentRemoteUploadAllowed = false;
  let currentSocket: WebSocket | null = null;
  let currentSocketGeneration = 0;
  let currentStatus: ExecutorSessionStatus = 'idle';
  let currentTarget: ExecutorSessionTarget | null = null;
  let activeGraphRunRequestId: RemoteRunRequestId | null = null;
  let reconnectingTimeout: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 0;

  const pendingGraphExecutions = createExecutorSessionPendingExecutions();

  const onConnectCallbacks = new Set<LifecycleCallback>();
  const onDisconnectCallbacks = new Set<LifecycleCallback>();
  const debuggerMessageHandlers = new Set<DebuggerMessageHandler>();

  function notifyConnect(event: ExecutorSessionConnectedEvent) {
    notifyLifecycleCallbacks(onConnectCallbacks, event);
  }

  function notifyDisconnect(event: ExecutorSessionDisconnectedEvent) {
    notifyLifecycleCallbacks(onDisconnectCallbacks, event);
  }

  function notifyLifecycleCallbacks(callbacks: Set<LifecycleCallback>, event: ExecutorSessionLifecycleEvent) {
    notifyExecutorSessionCallbacks({
      callbacks,
      context: 'Executor session lifecycle subscriber failed',
      event,
      metadata: {
        reason: event.reason,
        target: event.target?.type ?? 'none',
        url: event.url,
      },
    });
  }

  function notifyStateChanged() {
    runExecutorSessionCallback(options.onStateChange, 'Executor session state-change callback failed', {
      socketReadyState: currentSocket?.readyState ?? null,
      status: currentStatus,
      target: currentTarget?.type ?? 'none',
    });
  }

  function setConnectionStatus(status: ExecutorSessionStatus) {
    if (status !== currentStatus) {
      logRuntimeDebug('Executor session status changed.', {
        from: currentStatus,
        socketReadyState: currentSocket?.readyState ?? null,
        target: currentTarget ? getExecutorSessionTargetLabel(currentTarget) : 'none',
        to: status,
      });
    }

    currentStatus = status;
    notifyStateChanged();
  }

  function notifySessionStateChanged() {
    notifyStateChanged();
  }

  function clearReconnectTimeout() {
    if (reconnectingTimeout) {
      clearTimeout(reconnectingTimeout);
      reconnectingTimeout = undefined;
    }
  }

  function getCapabilities(): ExecutorSessionCapabilities {
    const socketReady = currentStatus === 'ready' && currentSocket?.readyState === WebSocket.OPEN;

    return {
      canBridgeDatasets: socketReady && currentDatasetProvider != null,
      canRecordSocket: socketReady,
      canSendAbort: socketReady,
      canSendPause: socketReady,
      canSendResume: socketReady,
      canSendRun: socketReady,
      canUploadProject: socketReady && currentRemoteUploadAllowed,
    };
  }

  async function connectToTarget(nextTarget: ExecutorSessionTarget) {
    retryDelay = 0;
    clearReconnectTimeout();

    if (currentSocket || (currentTarget && currentStatus !== 'idle')) {
      if (
        currentTarget &&
        executorSessionTargetsEqual(currentTarget, nextTarget) &&
        currentSocket &&
        (currentSocket.readyState === WebSocket.OPEN || currentSocket.readyState === WebSocket.CONNECTING)
      ) {
        logRuntimeDebug('Executor session reused existing websocket.', {
          socketReadyState: currentSocket.readyState,
          target: getExecutorSessionTargetLabel(nextTarget),
        });
        setConnectionStatus(currentSocket.readyState === WebSocket.OPEN ? 'ready' : 'connecting');
        notifySessionStateChanged();
        return;
      }

      if (!currentTarget || !executorSessionTargetsEqual(currentTarget, nextTarget)) {
        replaceCurrentSession(nextTarget);
      } else if (currentSocket) {
        replaceCurrentSession(nextTarget);
      }
    }

    currentTarget = nextTarget;
    currentRemoteUploadAllowed = false;
    notifySessionStateChanged();

    logRuntimeDebug('Executor session opening websocket.', {
      target: getExecutorSessionTargetLabel(nextTarget),
    });

    let socket: WebSocket;
    try {
      socket = new WebSocket(nextTarget.url);
    } catch (error) {
      currentTarget = null;
      currentRemoteUploadAllowed = false;
      setConnectionStatus('idle');
      throw error;
    }

    const socketGeneration = ++currentSocketGeneration;
    const socketTarget = nextTarget;
    currentSocket = socket;
    setConnectionStatus('connecting');

    socket.onopen = () => {
      if (socketGeneration !== currentSocketGeneration || currentSocket !== socket) {
        return;
      }

      retryDelay = 0;
      currentTarget = socketTarget;
      logRuntimeDebug('Executor websocket opened.', {
        target: getExecutorSessionTargetLabel(socketTarget),
      });
      setConnectionStatus('ready');
      notifySessionStateChanged();
      notifyConnect({
        isInternalExecutor: isInternalExecutorTarget(socketTarget),
        reason: 'connected',
        status: currentStatus,
        target: socketTarget,
        type: 'connected',
        url: socket.url,
      });
    };

    socket.onclose = () => {
      if (socketGeneration !== currentSocketGeneration) {
        return;
      }

      const closedTarget = socketTarget;
      currentSocket = null;
      currentRemoteUploadAllowed = false;
      logRuntimeDebug('Executor websocket closed.', {
        target: getExecutorSessionTargetLabel(closedTarget),
      });

      pendingGraphExecutions.rejectAllPendingGraphExecutions(new Error('executor session disconnected'));
      activeGraphRunRequestId = null;

      if (!isInternalExecutorTarget(closedTarget)) {
        logRuntimeDebug('External debugger websocket closed; automatic reconnect skipped.', {
          target: getExecutorSessionTargetLabel(closedTarget),
        });
        setConnectionStatus('idle');
        currentTarget = null;
        notifySessionStateChanged();
        notifyDisconnect({
          isInternalExecutor: false,
          reason: 'unexpected-disconnect',
          status: currentStatus,
          target: closedTarget,
          type: 'disconnected',
          url: socket.url,
        });
        return;
      }

      setConnectionStatus('reconnecting');
      currentTarget = closedTarget;
      notifySessionStateChanged();

      const nextRetryDelay = Math.min(2000, (retryDelay + 100) * 1.5);
      retryDelay = nextRetryDelay;
      const reconnectTarget = closedTarget;

      logRuntimeDebug('Executor websocket reconnect scheduled.', {
        retryDelayMs: nextRetryDelay,
        target: getExecutorSessionTargetLabel(reconnectTarget),
      });

      reconnectingTimeout = setTimeout(() => {
        void connectToTarget(reconnectTarget);
      }, nextRetryDelay);

      notifyDisconnect({
        isInternalExecutor: true,
        reason: 'unexpected-disconnect',
        status: currentStatus,
        target: closedTarget,
        type: 'disconnected',
        url: socket.url,
      });
    };

    socket.onerror = (event) => {
      if (socketGeneration !== currentSocketGeneration || currentSocket !== socket) {
        return;
      }

      handleError(event, 'Executor websocket transport error', {
        metadata: {
          socketUrl: socket.url,
          status: currentStatus,
          target: socketTarget.type,
        },
        toastError: false,
      });
    };

    socket.onmessage = (event) => {
      if (socketGeneration !== currentSocketGeneration || currentSocket !== socket) {
        return;
      }

      const incoming = parseExecutorSessionIncomingMessage({
        rawMessage: event.data,
        socketUrl: socket.url,
        target: socketTarget,
      });
      if (!incoming) {
        return;
      }

      if (incoming.kind === 'upload-allowed') {
        currentRemoteUploadAllowed = true;
        notifySessionStateChanged();
        return;
      }

      if (incoming.kind === 'dataset-request') {
        handleExecutorDatasetRequest({
          data: incoming.data,
          datasetProvider: currentDatasetProvider,
          message: incoming.message,
          socket,
          target: socketTarget,
        });
        return;
      }

      if (incoming.kind === 'process-event') {
        const processEvent = incoming.incoming;
        for (const handler of [...debuggerMessageHandlers]) {
          runExecutorSessionCallback(
            () => handler(processEvent.message, processEvent.data, processEvent.requestId),
            'Executor process-message subscriber failed',
            {
              message: processEvent.message,
              requestId: processEvent.requestId,
              target: socketTarget.type,
            },
          );
        }
      }
    };
  }

  function replaceCurrentSession(nextTarget: ExecutorSessionTarget) {
    const oldSocket = currentSocket;
    const oldTarget = currentTarget;
    const oldUrl = oldTarget?.url ?? oldSocket?.url ?? '';

    logRuntimeDebug('Executor session replacing active websocket.', {
      nextTarget: getExecutorSessionTargetLabel(nextTarget),
      previousSocketReadyState: oldSocket?.readyState ?? null,
      previousTarget: oldTarget ? getExecutorSessionTargetLabel(oldTarget) : 'none',
    });

    if (oldSocket) {
      currentSocketGeneration += 1;
      currentSocket = null;
    }

    clearReconnectTimeout();
    setConnectionStatus('idle');
    currentTarget = null;
    currentRemoteUploadAllowed = false;
    pendingGraphExecutions.rejectAllPendingGraphExecutions(new Error('executor session replaced'));
    activeGraphRunRequestId = null;
    notifySessionStateChanged();

    if (oldSocket && oldSocket.readyState !== WebSocket.CLOSED) {
      oldSocket.close();
    }

    notifyDisconnect({
      isInternalExecutor: isInternalExecutorTarget(oldTarget),
      reason: 'replaced',
      status: currentStatus,
      target: oldTarget,
      type: 'disconnected',
      url: oldUrl,
    });
  }

  function disconnect(options: ExecutorSessionDisconnectOptions = {}) {
    const hadActiveSession = currentSocket != null || currentStatus !== 'idle';
    const disconnectReason = options.reason ?? 'manual-disconnect';
    const socketToClose = currentSocket;
    const disconnectedTarget = currentTarget;
    const disconnectedUrl = currentTarget?.url ?? currentSocket?.url ?? '';

    logRuntimeDebug('Executor session disconnect requested.', {
      hadActiveSession,
      target: currentTarget ? getExecutorSessionTargetLabel(currentTarget) : 'none',
    });

    if (socketToClose) {
      currentSocketGeneration += 1;
      currentSocket = null;
    }

    setConnectionStatus('idle');
    retryDelay = 0;
    currentTarget = null;
    currentRemoteUploadAllowed = false;
    clearReconnectTimeout();
    pendingGraphExecutions.rejectAllPendingGraphExecutions(new Error('executor session disconnected'));
    activeGraphRunRequestId = null;
    notifySessionStateChanged();

    if (socketToClose && socketToClose.readyState !== WebSocket.CLOSED) {
      socketToClose.close();
    }

    if (hadActiveSession) {
      notifyDisconnect({
        isInternalExecutor: isInternalExecutorTarget(disconnectedTarget),
        reason: disconnectReason,
        status: currentStatus,
        target: disconnectedTarget,
        type: 'disconnected',
        url: disconnectedUrl,
      });
    }
  }

  const runtime: ExecutorSessionRuntime = {
    buildSessionState(_legacyDebuggerConfig?: unknown, _legacyConnectionState?: unknown) {
      return {
        ...legacyConnectionStateFor(currentStatus),
        capabilities: getCapabilities(),
        isInternalExecutor: isInternalExecutorTarget(currentTarget),
        remoteUploadAllowed: currentRemoteUploadAllowed,
        socket: currentSocket,
        status: currentStatus,
        target: currentTarget,
        url: currentTarget?.url ?? '',
      };
    },
    connect(url = DEFAULT_REMOTE_DEBUGGER_URL) {
      return runtime.connectExternalDebugger(url);
    },
    connectExternalDebugger(url = DEFAULT_REMOTE_DEBUGGER_URL) {
      return connectToTarget(createExternalDebuggerTarget(url));
    },
    connectInternal(url = INTERNAL_EXECUTOR_URL) {
      return url === INTERNAL_EXECUTOR_URL
        ? runtime.connectInternalDesktopExecutor()
        : runtime.connectInternalHostedExecutor(url);
    },
    connectInternalDesktopExecutor() {
      return connectToTarget(createInternalDesktopExecutorTarget());
    },
    connectInternalHostedExecutor(url) {
      return connectToTarget(createInternalHostedExecutorTarget(url));
    },
    createPendingGraphExecution: pendingGraphExecutions.createPendingGraphExecution,
    createRemoteExecutionRequest: pendingGraphExecutions.createRemoteExecutionRequest,
    disconnect,
    getActiveGraphRunRequestId() {
      return activeGraphRunRequestId;
    },
    getRuntimeState() {
      return {
        capabilities: getCapabilities(),
        isInternalExecutor: isInternalExecutorTarget(currentTarget),
        remoteUploadAllowed: currentRemoteUploadAllowed,
        socket: currentSocket,
        status: currentStatus,
        target: currentTarget,
        url: currentTarget?.url ?? '',
      };
    },
    isReady() {
      return currentSocket?.readyState === WebSocket.OPEN;
    },
    rejectPendingGraphExecution(requestId, reason) {
      pendingGraphExecutions.rejectPendingGraphExecution(requestId, reason);
    },
    reportPendingGraphProgress(requestId, progress) {
      pendingGraphExecutions.reportPendingGraphProgress(requestId, progress);
    },
    recordSocketEvents(recordSocket) {
      if (!getCapabilities().canRecordSocket || !currentSocket) {
        logRuntimeDebug('Executor socket recording skipped because the session cannot be recorded.', {
          status: currentStatus,
          target: currentTarget?.type ?? 'none',
        });
        return undefined;
      }

      return recordSocket(currentSocket);
    },
    resolvePendingGraphExecution(requestId, outputs) {
      pendingGraphExecutions.resolvePendingGraphExecution(requestId, outputs);
    },
    sendMessage(type, data) {
      return safeSendExecutorSocket(
        currentSocket,
        serializeExecutorSessionMessage(type, data),
        'Failed to send executor message',
        {
          messageType: type,
          target: currentTarget?.type ?? 'none',
        },
      );
    },
    sendRaw(data) {
      return safeSendExecutorSocket(currentSocket, data, 'Failed to send raw executor message', {
        target: currentTarget?.type ?? 'none',
      });
    },
    setActiveGraphRunRequestId(requestId) {
      activeGraphRunRequestId = requestId;
    },
    setDatasetProvider(datasetProvider) {
      currentDatasetProvider = datasetProvider;
      notifySessionStateChanged();
    },
    subscribeLifecycle(type, callback) {
      const callbacks = type === 'connect' ? onConnectCallbacks : onDisconnectCallbacks;
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    subscribeMessages(handler) {
      debuggerMessageHandlers.add(handler);
      return () => {
        debuggerMessageHandlers.delete(handler);
      };
    },
  };

  return runtime;
}

function legacyConnectionStateFor(
  status: ExecutorSessionStatus,
): Pick<ExecutorSessionState, 'reconnecting' | 'started'> {
  return {
    reconnecting: status === 'reconnecting',
    started: status === 'connecting' || status === 'ready',
  };
}

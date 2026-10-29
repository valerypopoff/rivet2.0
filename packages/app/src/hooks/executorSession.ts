import {
  type OutgoingMessageMap,
  type ProcessEventMessageMap,
  type GraphOutputs,
  type GraphProgress,
  type RemoteRunRequestId,
  type SocketRecordingChannel,
  type ProjectId,
  type RootRunId,
  logRuntimeDebug,
  parseLatestDebuggerPath,
  type LatestDebuggerScope,
  type LatestDebuggerLifecycleMessage,
} from '@valerypopoff/rivet2-core';
import type { LatestDebuggerRuns } from './latestDebuggerRuns.js';
import type { AppDatasetProvider } from '../providers/ProvidersContext.js';
import { handleError } from '../utils/errorHandling.js';
import { toast } from 'react-toastify';
import { ManagedLatestSession } from './managedLatestSession.js';
import {
  createUnscopedRemoteExecutionRoutingState,
  getRemoteExecutionEventDispatchDecision,
  resetUnscopedRemoteExecutionRoutingState,
  type RemoteExecutionEventDispatchDecision,
} from './remoteExecutorRunRequest.js';
import { summarizeRemoteDebuggerRoutingState, type RemoteDebuggerRoutingSummary } from './remoteDebuggerDiagnostics.js';
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

/** Negotiated transport identity; readiness and execution authority remain separate. */
export type ExecutorSessionConnection =
  | { kind: 'none' | 'executor' | 'generic-debugger' }
  | { kind: 'managed-latest'; protocol: 0 | 1 | 2; channel: string | null };

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
  connection: ExecutorSessionConnection;
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

export type RemoteEventAdmission = {
  managedLatest?: {
    scope: LatestDebuggerScope;
    selected: boolean;
    reset: boolean;
    replay: boolean;
    retained: string[];
  };
  /** Actual root project, which need not be the tab that opened a bundle debugger. */
  projectId?: ProjectId;
  /** Root events remain admitted for dependencies after its source tab is replaced. */
  sourceDisplayAllowed?: boolean;
  decision: RemoteExecutionEventDispatchDecision;
  before?: RemoteDebuggerRoutingSummary;
  after?: RemoteDebuggerRoutingSummary;
};

type DebuggerMessageHandler = <K extends keyof ProcessEventMessageMap>(
  message: K,
  data: ProcessEventMessageMap[K],
  requestId?: RemoteRunRequestId,
  admission?: RemoteEventAdmission,
) => MaybePromise<void>;
type ManagedLatestLifecycleHandler = (
  frame: LatestDebuggerLifecycleMessage,
  admission: RemoteEventAdmission,
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
  getLatestDebuggerState(): ReturnType<LatestDebuggerRuns['state']> | undefined;
  selectLatestDebuggerRun(key?: string): void;
  sendLatestPrompt(target: LatestDebuggerScope, promptId: string, answers: unknown): boolean;
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
    | 'connection'
    | 'capabilities'
    | 'isInternalExecutor'
    | 'remoteUploadAllowed'
    | 'socket'
    | 'status'
    | 'target'
    | 'url'
  >;
  isReady(): boolean;
  rejectPendingGraphExecution(requestId: RemoteRunRequestId | undefined, reason: unknown): void;
  reportPendingGraphProgress(requestId: RemoteRunRequestId | undefined, progress: GraphProgress): void;
  recordSocketEvents(recordSocket: (socket: SocketRecordingChannel) => Promise<void>): Promise<void> | undefined;
  resolvePendingGraphExecution(requestId: RemoteRunRequestId | undefined, outputs: GraphOutputs): void;
  sendMessage<T extends keyof OutgoingMessageMap>(type: T, data: OutgoingMessageMap[T]): boolean;
  sendRaw(data: string): boolean;
  setActiveGraphRunRequestId(requestId: RemoteRunRequestId | null): void;
  setDatasetProvider(datasetProvider: AppDatasetProvider | null): void;
  subscribeLifecycle(type: 'connect' | 'disconnect', callback: LifecycleCallback): () => void;
  subscribeMessages(handler: DebuggerMessageHandler, lifecycle?: ManagedLatestLifecycleHandler): () => void;
};

export function createExecutorSessionRuntime(options: {
  projectId?: ProjectId;
  acceptsProject?: (projectId: ProjectId) => boolean;
  acceptsLatestProject?: (projectId: string) => boolean;
  getProjectLifetime?: (projectId: ProjectId) => string | undefined;
  datasetProvider?: AppDatasetProvider | null;
  onStateChange: StateChangeCallback;
  resolveInternalHostedExecutorUrl?: () => Promise<string>;
}): ExecutorSessionRuntime {
  let currentDatasetProvider: AppDatasetProvider | null = options.datasetProvider ?? null;
  const eventRouting = createUnscopedRemoteExecutionRoutingState();
  let currentRemoteUploadAllowed = false;
  let currentSocket: WebSocket | null = null;
  let currentSocketGeneration = 0;
  let currentStatus: ExecutorSessionStatus = 'idle';
  let currentTarget: ExecutorSessionTarget | null = null;
  let activeGraphRunRequestId: RemoteRunRequestId | null = null;
  let activeRunDisplayBinding: { requestId: RemoteRunRequestId; lifetime: string | undefined } | undefined;
  let reconnectingTimeout: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 0;
  let resumeCapability: string | undefined;
  let resumeSequence = 0;

  const latest = new ManagedLatestSession({
    eligible: (id) => options.acceptsLatestProject?.(id) ?? id === options.projectId,
    notify: notifySessionStateChanged,
    warn: (message, options) => {
      toast.warn(message, options);
    },
    canSend: () => currentStatus === 'ready' && currentSocket?.readyState === WebSocket.OPEN,
    send: (raw) => safeSendExecutorSocket(currentSocket, raw, 'Failed to send latest control', {}),
    deliver(frame, selected, reset, replay, retained) {
      const admission: RemoteEventAdmission = {
        projectId: frame.rivetScope.projectId as ProjectId,
        decision: { reason: 'active-root-accepted', shouldDispatch: true },
        managedLatest: { scope: frame.rivetScope, selected, reset, replay, retained },
      };
      for (const [handler, lifecycle] of [...debuggerMessageHandlers])
        runExecutorSessionCallback(
          () => {
            if (frame.message === 'latest-settled' || frame.message === 'latest-prompt-closed')
              return lifecycle?.(frame, admission);
            return handler(frame.message, frame.data, undefined, admission);
          },
          'Managed latest debugger subscriber failed',
          { message: frame.message },
        );
    },
  });
  // The first ready may arrive on a replacement transport after identity replay.
  let connectionNotified = false;
  let idleHandoff: symbol | undefined;
  let resumeTimeout: ReturnType<typeof setTimeout> | undefined;
  let recordingChannel: (EventTarget & { readyState: number }) | undefined;
  // Retain completed dataset responses across transport gaps, never requests,
  // run commands or controls. The logical capability fences late completions.
  const datasetResponses: string[] = [];
  let datasetResponseBytes = 0;

  function flushDatasetResponses() {
    if (currentStatus !== 'ready' || currentSocket?.readyState !== WebSocket.OPEN) return;
    const responses = datasetResponses.splice(0);
    datasetResponseBytes = 0;
    for (const response of responses) {
      if (!safeSendExecutorSocket(currentSocket, response, 'Failed to send resumed dataset response', {})) {
        failResume();
        return;
      }
    }
  }

  function retainDatasetResponse(capability: string, requestId: string, payload: unknown) {
    if (resumeCapability !== capability) return; // A replaced logical session cannot receive this result.
    const response = serializeExecutorSessionMessage('datasets:response', { requestId, payload });
    if (currentStatus === 'ready' && currentSocket?.readyState === WebSocket.OPEN) {
      if (!safeSendExecutorSocket(currentSocket, response, 'Failed to send resumed dataset response', {})) failResume();
      return;
    }
    const bytes = new TextEncoder().encode(response).byteLength;
    if (datasetResponses.length >= 64 || datasetResponseBytes + bytes > 8 * 1024 * 1024) {
      failResume();
      return;
    }
    datasetResponses.push(response);
    datasetResponseBytes += bytes;
  }

  function closeRecordingChannel() {
    const channel = recordingChannel;
    recordingChannel = undefined;
    if (channel) {
      channel.readyState = WebSocket.CLOSED;
      channel.dispatchEvent(new Event('close'));
    }
  }

  function isResumableTarget(target: ExecutorSessionTarget | null) {
    return target?.type === 'internal-hosted' && /^wss?:\/\/[^/]+\/ws\/executor\/owner\//.test(target.url);
  }

  function clearResumeTimeout() {
    if (resumeTimeout) clearTimeout(resumeTimeout);
    resumeTimeout = undefined;
  }
  function failResume() {
    pendingGraphExecutions.rejectAllPendingGraphExecutions(
      new Error('Executor session could not be resumed. Run outcome is unknown; it was not resubmitted.'),
    );
    disconnect({ reason: 'unexpected-disconnect' });
  }

  const pendingGraphExecutions = createExecutorSessionPendingExecutions();

  const onConnectCallbacks = new Set<LifecycleCallback>();
  const onDisconnectCallbacks = new Set<LifecycleCallback>();
  const debuggerMessageHandlers = new Map<DebuggerMessageHandler, ManagedLatestLifecycleHandler | undefined>();

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
    const managedUrl = latest.observation || isNamedLatestTarget(currentTarget);
    const policy = latest.getSelectedControlPolicy();
    const readyForControls = socketReady && (!managedUrl || latest.ready);

    return {
      canBridgeDatasets: socketReady && !managedUrl && currentDatasetProvider != null,
      canRecordSocket: socketReady,
      canSendAbort: readyForControls && (!managedUrl || !!policy?.canAbort),
      canSendPause: readyForControls && (!managedUrl || !!policy?.canPause),
      canSendResume: readyForControls && (!managedUrl || !!policy?.canResume),
      canSendRun: socketReady && !managedUrl && !latest.runs,
      canUploadProject: socketReady && !managedUrl && currentRemoteUploadAllowed,
    };
  }

  function getConnection(): ExecutorSessionConnection {
    if (!currentTarget) return { kind: 'none' };
    if (isInternalExecutorTarget(currentTarget)) return { kind: 'executor' };
    if (latest.channel !== undefined) return { kind: 'managed-latest', protocol: 2, channel: latest.channel };
    if (latest.observation) return { kind: 'managed-latest', protocol: 1, channel: null };
    if (typeof latest.requestedChannel === 'string')
      return { kind: 'managed-latest', protocol: 0, channel: latest.requestedChannel };
    return { kind: 'generic-debugger' };
  }

  function isNamedLatestTarget(target: ExecutorSessionTarget | null) {
    return target?.type === 'external-debugger' && typeof latest.requestedChannel === 'string';
  }

  async function connectToTarget(nextTarget: ExecutorSessionTarget) {
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
        // An open socket may still be replaying diagnostics or discovering a
        // retiring owner's replacement. Reuse cannot acknowledge either step.
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
    latest.requestedChannel = undefined;
    if (nextTarget.type === 'external-debugger') {
      try {
        latest.requestedChannel = parseLatestDebuggerPath(new URL(nextTarget.url).pathname);
      } catch {
        // Generic debuggers keep their existing adapter; only a valid latest
        // route may negotiate managed protocol identity below.
      }
    }
    currentRemoteUploadAllowed = false;
    notifySessionStateChanged();

    logRuntimeDebug('Executor session opening websocket.', {
      target: getExecutorSessionTargetLabel(nextTarget),
    });

    let socket: WebSocket;
    const resumableTarget = isResumableTarget(nextTarget);
    try {
      socket = new WebSocket(
        nextTarget.url,
        resumableTarget
          ? [
              'rivet-session-v1',
              ...(resumeCapability ? [`rivet-cap.${resumeCapability}`, `rivet-seq.${resumeSequence}`] : []),
            ]
          : undefined,
      );
    } catch (error) {
      currentTarget = null;
      currentRemoteUploadAllowed = false;
      setConnectionStatus('idle');
      throw error;
    }

    const socketGeneration = ++currentSocketGeneration;
    const socketTarget = nextTarget;
    let sessionAcknowledged = false;
    currentSocket = socket;
    setConnectionStatus('connecting');

    const notifySocketConnected = () => {
      if (connectionNotified || currentSocket !== socket || currentStatus !== 'ready') return;
      connectionNotified = true;
      notifyConnect({
        isInternalExecutor: isInternalExecutorTarget(socketTarget),
        reason: 'connected',
        status: currentStatus,
        target: socketTarget,
        type: 'connected',
        url: socket.url,
      });
    };

    socket.onopen = () => {
      if (socketGeneration !== currentSocketGeneration || currentSocket !== socket) {
        return;
      }

      retryDelay = 0;
      currentTarget = socketTarget;
      // Every owned connection, including the first, must finish the handshake.
      // Keep one deadline even if the transport drops before the first ready.
      if (resumableTarget) {
        resumeTimeout ??= setTimeout(failResume, 60_000);
        return;
      }
      if (latest.observation || isNamedLatestTarget(socketTarget)) {
        resumeTimeout ??= setTimeout(failResume, 60_000);
        return;
      }
      logRuntimeDebug('Executor websocket opened.', {
        target: getExecutorSessionTargetLabel(socketTarget),
      });
      setConnectionStatus('ready');
      notifySessionStateChanged();
      notifySocketConnected();
    };

    socket.onclose = (event) => {
      if (socketGeneration !== currentSocketGeneration) {
        return;
      }

      const closedTarget = socketTarget;
      currentSocket = null;
      latest.suspend();
      idleHandoff = undefined;
      if (resumeCapability && event?.code === 4409) {
        failResume();
        return;
      }
      const canResume = resumeCapability != null || latest.observation;
      if (canResume) {
        resumeTimeout ??= setTimeout(failResume, 60_000);
      }
      if (!canResume) currentRemoteUploadAllowed = false;
      logRuntimeDebug('Executor websocket closed.', {
        target: getExecutorSessionTargetLabel(closedTarget),
      });

      if (!canResume) {
        connectionNotified = false;
        closeRecordingChannel();
        resumeCapability = undefined;
        resumeSequence = 0;
        pendingGraphExecutions.rejectAllPendingGraphExecutions(new Error('executor session disconnected'));
        activeGraphRunRequestId = null;
        activeRunDisplayBinding = undefined;
      }

      if (!isInternalExecutorTarget(closedTarget) && !latest.observation) {
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

      if (!canResume)
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
        managedLatest: latest.runs !== undefined,
        acceptEnvelope: (value) => {
          const envelope = (typeof value === 'object' && value != null ? value : {}) as {
            message?: string;
            data?: {
              capability?: string;
              protocol?: number;
              channel?: unknown;
              channelIsolation?: boolean;
              runScopedControls?: boolean;
              commandId?: string;
              status?: string;
              reason?: string;
            };
            rivetSequence?: number;
            rivetEventId?: string;
          };
          const managedAdmission = latest.acceptEnvelope(envelope, value, {
            external: socketTarget.type === 'external-debugger',
            named: isNamedLatestTarget(socketTarget),
            fail: failResume,
            onReady() {
              currentRemoteUploadAllowed = false;
              clearResumeTimeout();
              setConnectionStatus('ready');
              notifySessionStateChanged();
              notifySocketConnected();
            },
          });
          if (managedAdmission !== undefined) return managedAdmission;
          if (resumableTarget && envelope.message === 'executor-session') {
            if (
              envelope.data?.protocol !== 1 ||
              typeof envelope.data.capability !== 'string' ||
              !/^[A-Za-z0-9_-]{43}$/.test(envelope.data.capability) ||
              (resumeCapability && envelope.data.capability !== resumeCapability)
            ) {
              failResume();
              return false;
            }
            resumeCapability = envelope.data.capability;
            sessionAcknowledged = true;
            return false;
          }
          if (resumableTarget && !sessionAcknowledged) {
            failResume();
            return false;
          }
          if (resumableTarget && envelope.message === 'executor-session-ready') {
            if (envelope.data?.protocol !== 1) {
              failResume();
              return false;
            }
            clearResumeTimeout();
            setConnectionStatus('ready');
            flushDatasetResponses();
            notifySessionStateChanged();
            notifySocketConnected();
            return false;
          }
          if (resumeCapability && envelope.rivetSequence != null) {
            if (!Number.isSafeInteger(envelope.rivetSequence) || envelope.rivetSequence <= resumeSequence) return false;
            if (envelope.rivetSequence !== resumeSequence + 1) {
              failResume();
              return false;
            }
            resumeSequence = envelope.rivetSequence;
          }
          if (resumableTarget && envelope.message === 'executor-owner-retiring' && envelope.data?.protocol === 1) {
            // Only an idle, positively settled session can choose a new owner.
            // Accepted or uncertain runs always remain pinned to the old one.
            if (
              !activeGraphRunRequestId &&
              !pendingGraphExecutions.hasPendingExecutions() &&
              options.resolveInternalHostedExecutorUrl &&
              !idleHandoff
            ) {
              const generation = currentSocketGeneration;
              const handoff = Symbol('executor-owner-handoff');
              idleHandoff = handoff;
              setConnectionStatus('reconnecting');
              void (async () => {
                const deadline = Date.now() + 60_000;
                const canHandoff = () =>
                  idleHandoff === handoff &&
                  Date.now() < deadline &&
                  generation === currentSocketGeneration &&
                  currentSocket === socket &&
                  currentTarget?.type === 'internal-hosted' &&
                  !activeGraphRunRequestId &&
                  !pendingGraphExecutions.hasPendingExecutions();
                while (canHandoff()) {
                  const url = await options.resolveInternalHostedExecutorUrl!().catch(() => undefined);
                  // Discovery does not own the session. A disconnect, explicit
                  // replacement or newly accepted run can win while it awaits.
                  if (!canHandoff()) return;
                  if (url && url !== socketTarget.url) {
                    const old = new URL(socketTarget.url),
                      next = new URL(url);
                    if (old.origin !== next.origin || !next.pathname.startsWith('/ws/executor/owner/'))
                      throw new Error('Fresh executor owner is invalid.');
                    const target: ExecutorSessionTarget = { type: 'internal-hosted', url };
                    replaceCurrentSession(target);
                    await connectToTarget(target);
                    return;
                  }
                  await new Promise((resolve) => setTimeout(resolve, 500));
                }
                throw new Error('Fresh executor owner is unavailable.');
              })()
                .catch(() => {
                  // No run was replayed. Keep the old owner/cursor for explicit recovery.
                  if (idleHandoff === handoff && generation === currentSocketGeneration)
                    setConnectionStatus('reconnecting');
                })
                .finally(() => {
                  if (idleHandoff === handoff) idleHandoff = undefined;
                });
            }
            return false;
          }
          return true;
        },
      });
      if (!incoming) {
        return;
      }
      // Managed latest is observation/control only, not an executor for this
      // browser's datasets. Keep the generic/ordinary Node bridge unchanged.
      if (
        (latest.observation || isNamedLatestTarget(socketTarget)) &&
        incoming.kind !== 'process-event' &&
        incoming.kind !== 'managed-event'
      )
        return;

      if (incoming.kind === 'managed-event') {
        const frame = incoming.incoming;
        latest.receive(frame.message, frame.data, frame.rivetScope, String(event.data));
        return;
      }

      if (incoming.kind === 'upload-allowed') {
        currentRemoteUploadAllowed = true;
        notifySessionStateChanged();
        return;
      }

      if (incoming.kind === 'dataset-request') {
        const capability = resumableTarget ? resumeCapability : undefined;
        handleExecutorDatasetRequest({
          data: incoming.data,
          datasetProvider: currentDatasetProvider,
          message: incoming.message,
          socket,
          target: socketTarget,
          ...(capability
            ? {
                sendResponse: (requestId: string, payload: unknown) =>
                  retainDatasetResponse(capability, requestId, payload),
              }
            : {}),
        });
        return;
      }

      if (incoming.kind === 'process-event') {
        const processEvent = incoming.incoming;
        const metadata = (
          processEvent.data as {
            execution?: {
              rootRunId?: RootRunId;
              projectId?: ProjectId;
              parentGraphRunId?: string;
            };
          } | null
        )?.execution;
        const rootId =
          metadata?.rootRunId ??
          (['done', 'error', 'abort'].includes(processEvent.message)
            ? eventRouting.completedRootRunDecisions[0]?.rootRunId
            : undefined) ??
          (eventRouting.lastRunAccepted !== false && eventRouting.acceptedRootRunIds.size === 1
            ? eventRouting.acceptedRootRunIds.values().next().value
            : undefined);
        const rootProjectId =
          (processEvent.message === 'start'
            ? (processEvent.data as ProcessEventMessageMap['start']).project?.metadata?.id
            : rootId && eventRouting.rootProjects.get(rootId)?.projectId) ||
          (metadata && !metadata.parentGraphRunId ? metadata.projectId : undefined) ||
          options.projectId;
        const before =
          socketTarget.type === 'external-debugger' ? summarizeRemoteDebuggerRoutingState(eventRouting) : undefined;
        const decision = getRemoteExecutionEventDispatchDecision({
          activeRequestId: activeGraphRunRequestId,
          currentProjectId: options.projectId,
          acceptsProject: socketTarget.type === 'external-debugger' ? options.acceptsProject : undefined,
          getProjectLifetime: options.getProjectLifetime,
          data: processEvent.data,
          message: processEvent.message,
          requestId: processEvent.requestId,
          unscopedRoutingState: eventRouting,
        });
        const rootProject = rootId == null ? undefined : eventRouting.rootProjects.get(rootId);
        const currentProjectLifetime = rootProjectId == null ? undefined : options.getProjectLifetime?.(rootProjectId);
        const internalBindingMatches =
          !isInternalExecutorTarget(socketTarget) ||
          !activeRunDisplayBinding ||
          (processEvent.requestId != null && processEvent.requestId !== activeRunDisplayBinding.requestId) ||
          activeRunDisplayBinding.lifetime === currentProjectLifetime;
        const admission: RemoteEventAdmission = {
          projectId: rootProjectId,
          sourceDisplayAllowed:
            !options.getProjectLifetime ||
            (currentProjectLifetime != null &&
              (rootProject == null || rootProject.lifetime === currentProjectLifetime) &&
              internalBindingMatches),
          decision,
          before,
          after: before ? summarizeRemoteDebuggerRoutingState(eventRouting) : undefined,
        };
        // Request settlement is not display admission. An explicitly identified
        // accepted request still returns its result after its tab was replaced.
        // Never infer a modifying request's owner from an unscoped legacy frame.
        if (
          admission.sourceDisplayAllowed === false &&
          isInternalExecutorTarget(socketTarget) &&
          processEvent.requestId
        ) {
          if (processEvent.message === 'graphOutputsReady')
            pendingGraphExecutions.resolvePendingGraphExecution(
              processEvent.requestId,
              (processEvent.data as ProcessEventMessageMap['graphOutputsReady']).outputs as GraphOutputs,
            );
          else if (processEvent.message === 'done')
            pendingGraphExecutions.resolvePendingGraphExecution(
              processEvent.requestId,
              (processEvent.data as ProcessEventMessageMap['done']).results as GraphOutputs,
            );
          else if (processEvent.message === 'error')
            pendingGraphExecutions.rejectPendingGraphExecution(
              processEvent.requestId,
              (processEvent.data as ProcessEventMessageMap['error']).error,
            );
          if (
            (processEvent.message === 'done' || processEvent.message === 'error') &&
            activeGraphRunRequestId === processEvent.requestId
          )
            activeGraphRunRequestId = null;
        }
        for (const handler of [...debuggerMessageHandlers.keys()]) {
          runExecutorSessionCallback(
            () => handler(processEvent.message, processEvent.data, processEvent.requestId, admission),
            'Executor process-message subscriber failed',
            {
              message: processEvent.message,
              requestId: processEvent.requestId,
              target: socketTarget.type,
            },
          );
        }
        // Capture only admitted events, after terminal handlers update their
        // owners. A transport reconnect must neither end nor duplicate capture.
        if (resumableTarget) recordingChannel?.dispatchEvent(new MessageEvent('message', { data: event.data }));
      }
    };
  }

  function replaceCurrentSession(nextTarget: ExecutorSessionTarget) {
    latest.reset();
    resetUnscopedRemoteExecutionRoutingState(eventRouting);
    connectionNotified = false;
    retryDelay = 0;
    idleHandoff = undefined;
    datasetResponses.length = 0;
    datasetResponseBytes = 0;
    closeRecordingChannel();
    clearResumeTimeout();
    resumeCapability = undefined;
    resumeSequence = 0;
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
    activeRunDisplayBinding = undefined;
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
    latest.reset();
    resetUnscopedRemoteExecutionRoutingState(eventRouting);
    connectionNotified = false;
    idleHandoff = undefined;
    datasetResponses.length = 0;
    datasetResponseBytes = 0;
    closeRecordingChannel();
    clearResumeTimeout();
    resumeCapability = undefined;
    resumeSequence = 0;
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
    activeRunDisplayBinding = undefined;
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
    getLatestDebuggerState: () => latest.runs?.state(),
    selectLatestDebuggerRun: (key) => latest.select(key),
    sendLatestPrompt: (target, promptId, answers) => latest.sendControl('user-input', target, { promptId, answers }),
    buildSessionState(_legacyDebuggerConfig?: unknown, _legacyConnectionState?: unknown) {
      return {
        ...legacyConnectionStateFor(currentStatus),
        connection: getConnection(),
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
      if (
        currentTarget?.type === 'internal-hosted' &&
        currentStatus === 'ready' &&
        /^wss?:\/\/[^/]+\/ws\/executor\/owner\//.test(url) &&
        new URL(url).origin === new URL(currentTarget.url).origin &&
        currentTarget.url.includes('/ws/executor/owner/')
      )
        return connectToTarget(currentTarget);
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
        connection: getConnection(),
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
      return currentStatus === 'ready' && currentSocket?.readyState === WebSocket.OPEN;
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

      if (!isResumableTarget(currentTarget)) return recordSocket(currentSocket);
      recordingChannel ??= Object.assign(new EventTarget(), { readyState: WebSocket.OPEN });
      return recordSocket(recordingChannel);
    },
    resolvePendingGraphExecution(requestId, outputs) {
      pendingGraphExecutions.resolvePendingGraphExecution(requestId, outputs);
    },
    sendMessage(type, data) {
      if (latest.runs) {
        return latest.sendSelectedControl(type);
      }
      if (
        (latest.observation || isNamedLatestTarget(currentTarget)) &&
        ['abort', 'pause', 'resume', 'user-input'].includes(type)
      )
        return false;
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
      if (requestId != null && activeRunDisplayBinding?.requestId !== requestId)
        activeRunDisplayBinding = {
          requestId,
          lifetime: options.projectId == null ? undefined : options.getProjectLifetime?.(options.projectId),
        };
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
    subscribeMessages(handler, lifecycle) {
      debuggerMessageHandlers.set(handler, lifecycle);
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

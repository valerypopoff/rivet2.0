import { nanoid } from 'nanoid';
import type WebSocket from 'ws';
import {
  isRivetWebAppRunTerminalEvent,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTION_BYTES,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTIVE_BYTES,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_VALUE_BYTES,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_TRANSFER_TIMEOUT_MS,
  type GraphProcessor,
  type Project,
  type RivetWebAppActionStartMessage,
  type RivetWebAppRunEvent,
  type RivetStoredValueStore,
  type RivetKnowledgeStoreRegistry,
  type RivetLLMProfileHealthStore,
  type UiGraph,
} from '@valerypopoff/rivet2-core';
import {
  getRivetWebAppActionErrorResponseTrace,
  prepareRivetWebAppAction,
  RivetWebAppActionHttpError,
  type RivetWebAppActionContext,
  type RivetWebAppCreateProcessorOptions,
  type RivetWebAppHandlerOptions,
  type RivetWebAppActionResult,
} from './webAppHandler.js';
import type { RivetWebAppRunCoordinator } from './webAppRunCoordinator.js';
import { createInMemoryRivetWebAppRunStore } from './webAppRunStore.js';
import { createWebAppRunJournal } from './webAppRunJournal.js';
import { createWebAppLeaseManager } from './webAppLeaseManager.js';
import { sendWebAppSocketBinary, sendWebAppSocketMessage as safeSend } from './webAppSocketProtocol.js';
import { attachWebAppSocketSession } from './webAppSocketSession.js';
import {
  createRivetWebAppBrowserStorageRpcAdmission,
  RivetWebAppBrowserStorageRpcError,
  RivetWebAppBrowserStorageRpcHost,
  type RivetWebAppBrowserStorageRpcEvent,
  type RivetWebAppBrowserStorageRpcLimits,
} from './webAppBrowserStorageRpcHost.js';
import { createWebAppRemoteRunSubscriptions } from './webAppRemoteRunSubscriptions.js';
import { createWebAppActiveRunRegistry, type ActiveWebAppRun } from './webAppActiveRuns.js';

export { createInMemoryRivetWebAppRunStore } from './webAppRunStore.js';
export type { RivetWebAppBrowserStorageRpcEvent } from './webAppBrowserStorageRpcHost.js';

export type RivetWebAppRunPermit = {
  release(): void;
};

export type RivetWebAppSocketAuthorizationStatus = 'authorized' | 'revoked' | 'policy-revoked' | 'unavailable';
export type RivetWebAppSocketOperation = 'action-start' | 'action-cancel' | 'run-resume';

export type RivetWebAppSocketSession = {
  /** Optional synchronous cached-policy check before accepting each client frame. */
  isAuthorized?: () => boolean;
  /**
   * Optional fresh authorization check for commands that can create, alter, or
   * attach to work. The gateway deliberately does not call this for every
   * browser-storage frame.
   */
  authorizeOperation?: (operation: RivetWebAppSocketOperation) => Promise<RivetWebAppSocketAuthorizationStatus>;
  /**
   * Notifies the gateway that this app's current publication policy was
   * revoked. New commands and action-result delivery stop immediately, while
   * an accepted action retains only its browser-storage RPC connection until
   * it settles.
   */
  onPolicyRevoked?: (listener: () => void) => () => void;
  acquireRunPermit?: (context: {
    componentId: string;
    ownerScope: string;
    requestId: string;
    runId: string;
  }) => Promise<RivetWebAppRunPermit | void> | RivetWebAppRunPermit | void;
  createProcessorOptions?: RivetWebAppCreateProcessorOptions;
  onActionError?: RivetWebAppHandlerOptions['onActionError'];
  onActionFinish?: RivetWebAppHandlerOptions['onActionFinish'];
  onActionStart?: RivetWebAppHandlerOptions['onActionStart'];
  onProcessorPrepared?: (context: RivetWebAppProcessorPreparedContext) => Promise<void> | void;
  onRunFailed?: (context: RivetWebAppRunFailedContext) => Promise<void> | void;
  onRunFinished?: (context: RivetWebAppRunFinishedContext) => Promise<void> | void;
  ownerScope: string;
  project: Project;
  request?: Request;
  resolveContext?: RivetWebAppHandlerOptions['resolveContext'];
  revisionKey?: string;
  storedValueStore?: RivetStoredValueStore;
  knowledgeStores?: RivetKnowledgeStoreRegistry;
  llmProfileHealthStore?: RivetLLMProfileHealthStore;
  uiGraph: UiGraph;
};

export type RivetWebAppProcessorPreparedContext = {
  actionContext: RivetWebAppActionContext;
  processor: GraphProcessor;
  requestId: string;
  runId: string;
};

export type RivetWebAppRunFinishedContext = {
  actionContext: RivetWebAppActionContext;
  requestId: string;
  result: RivetWebAppActionResult;
  runId: string;
};

export type RivetWebAppRunFailedContext = {
  actionContext: RivetWebAppActionContext;
  error?: unknown;
  outcome: 'failed' | 'cancelled' | 'interrupted';
  requestId: string;
  runId: string;
};

export type RivetWebAppStoredRun = {
  componentId: string;
  createdAt: number;
  events: RivetWebAppRunEvent[];
  hostId: string;
  lastSequence: number;
  leaseExpiresAt: number;
  leaseId: string;
  ownerScope: string;
  requestId: string;
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  updatedAt: number;
};

export type RivetWebAppUnsequencedRunEvent = RivetWebAppRunEvent extends infer Event
  ? Event extends RivetWebAppRunEvent
    ? Omit<Event, 'sequence'>
    : never
  : never;

export type RivetWebAppRunCreation = Omit<
  RivetWebAppStoredRun,
  'events' | 'lastSequence' | 'leaseExpiresAt' | 'status' | 'updatedAt'
> & {
  leaseDurationMs: number;
};

export type RivetWebAppRunStore = {
  /**
   * Atomically verifies the live lease, assigns the next sequence, and appends
   * the event. Returns undefined when the run or lease no longer owns writes.
   */
  appendEvent(
    runId: string,
    leaseId: string,
    event: RivetWebAppUnsequencedRunEvent,
  ): Promise<RivetWebAppRunEvent | undefined>;
  /**
   * Atomically reserves (ownerScope, requestId). The store uses its own clock
   * to derive leaseExpiresAt from leaseDurationMs.
   */
  createRun(input: RivetWebAppRunCreation): Promise<{ created: boolean; run: RivetWebAppStoredRun }>;
  getRun(runId: string): Promise<RivetWebAppStoredRun | undefined>;
  getRunByRequestId(ownerScope: string, requestId: string): Promise<RivetWebAppStoredRun | undefined>;
  /** Atomically appends one interruption terminal to every expired running row. */
  interruptExpiredRuns(error: string): Promise<RivetWebAppStoredRun[]>;
  /** Atomically interrupts running rows owned by this exact process lease. */
  interruptRunsByLease(leaseId: string, error: string): Promise<RivetWebAppStoredRun[]>;
  /**
   * Renews only the listed, still-live rows owned by leaseId. The store uses
   * its own clock to calculate each new expiry and returns the renewed IDs.
   */
  renewRunLeases(leaseId: string, runIds: readonly string[], leaseDurationMs: number): Promise<string[]>;
};

export type RivetWebAppWebSocketGateway = {
  dispose(options?: { interrupt?: boolean }): Promise<void>;
  drain(options?: { closeConnections?: boolean }): void;
  getActiveRunCount(): number;
  handleConnection(socket: WebSocket, session: RivetWebAppSocketSession): void;
  recoverInterruptedRuns(error?: string): Promise<number>;
};

export type RivetWebAppWebSocketGatewayOptions = {
  browserStorageTransferTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  hostId?: string;
  leaseDurationMs?: number;
  leaseRenewIntervalMs?: number;
  maxActiveRunsPerScope?: number;
  maxBrowserStorageActionBytes?: number;
  maxBrowserStorageActiveBytes?: number;
  maxBrowserStorageValueBytes?: number;
  maxMessageBytes?: number;
  onBrowserStorageRpcEvent?: (event: RivetWebAppBrowserStorageRpcEvent) => void;
  onError?: (error: unknown) => void;
  runCoordinator?: RivetWebAppRunCoordinator;
  runStore?: RivetWebAppRunStore;
};

const DEFAULT_MAX_MESSAGE_BYTES = 1_000_000;
const DEFAULT_MAX_ACTIVE_RUNS_PER_SCOPE = 10;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 20_000;
const AUTHORIZATION_CLOSE_GRACE_MS = 1_000;

function closeSocketForAuthorization(socket: WebSocket, code: 1008 | 1013, reason: string): void {
  socket.close(code, reason);
  const fallback = setTimeout(() => {
    if (socket.readyState !== 3) socket.terminate();
  }, AUTHORIZATION_CLOSE_GRACE_MS);
  fallback.unref();
  socket.once('close', () => clearTimeout(fallback));
}

export function createRivetWebAppWebSocketGateway(
  options: RivetWebAppWebSocketGatewayOptions = {},
): RivetWebAppWebSocketGateway {
  const configuredHostId = options.hostId?.trim();
  if (options.hostId != null && !configuredHostId) throw new Error('Web app action gateway hostId cannot be blank.');
  const hostId = configuredHostId ?? nanoid();
  const leaseId = nanoid();
  const leaseDurationMs = getIntegerOption('leaseDurationMs', options.leaseDurationMs, DEFAULT_LEASE_DURATION_MS, 2);
  const leaseRenewIntervalMs = getIntegerOption(
    'leaseRenewIntervalMs',
    options.leaseRenewIntervalMs,
    DEFAULT_LEASE_RENEW_INTERVAL_MS,
    1,
  );
  if (leaseRenewIntervalMs >= leaseDurationMs) {
    throw new RangeError('leaseRenewIntervalMs must be less than leaseDurationMs.');
  }
  const handshakeTimeoutMs = getIntegerOption('handshakeTimeoutMs', options.handshakeTimeoutMs, 10_000, 0);
  const heartbeatIntervalMs = getIntegerOption('heartbeatIntervalMs', options.heartbeatIntervalMs, 30_000, 0);
  const heartbeatTimeoutMs = getIntegerOption('heartbeatTimeoutMs', options.heartbeatTimeoutMs, 10_000, 1);
  const maxActiveRunsPerScope = getIntegerOption(
    'maxActiveRunsPerScope',
    options.maxActiveRunsPerScope,
    DEFAULT_MAX_ACTIVE_RUNS_PER_SCOPE,
    1,
  );
  const maxMessageBytes = getIntegerOption('maxMessageBytes', options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, 1);
  const store = options.runStore ?? createInMemoryRivetWebAppRunStore();
  const browserStorageLimits: RivetWebAppBrowserStorageRpcLimits = {
    maxActionBytes: getIntegerOption(
      'maxBrowserStorageActionBytes',
      options.maxBrowserStorageActionBytes,
      RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTION_BYTES,
      1,
    ),
    maxActiveBytes: getIntegerOption(
      'maxBrowserStorageActiveBytes',
      options.maxBrowserStorageActiveBytes,
      RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTIVE_BYTES,
      1,
    ),
    maxValueBytes: getIntegerOption(
      'maxBrowserStorageValueBytes',
      options.maxBrowserStorageValueBytes,
      RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_VALUE_BYTES,
      1,
    ),
    transferTimeoutMs: getIntegerOption(
      'browserStorageTransferTimeoutMs',
      options.browserStorageTransferTimeoutMs,
      RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_TRANSFER_TIMEOUT_MS,
      1,
    ),
  };
  if (browserStorageLimits.maxValueBytes > browserStorageLimits.maxActionBytes) {
    throw new RangeError('maxBrowserStorageValueBytes cannot exceed maxBrowserStorageActionBytes.');
  }
  const browserStorageAdmission = createRivetWebAppBrowserStorageRpcAdmission(browserStorageLimits.maxActiveBytes);
  const coordinator = options.runCoordinator;
  const activeRuns = createWebAppActiveRunRegistry();
  const runPermitReleases = new Map<string, () => void>();
  const pendingRunSetups = new Map<string, Promise<RivetWebAppStoredRun | undefined>>();
  const connections = new Set<WebSocket>();
  let draining = false;
  let disposed = false;

  const browserStorageHosts = new Map<string, { host: RivetWebAppBrowserStorageRpcHost; socket: WebSocket }>();
  const activeRunOwnerSockets = new Map<string, WebSocket>();
  const activeRunIdsBySocket = new Map<WebSocket, Set<string>>();
  const policyRevokedSockets = new Set<WebSocket>();
  let detachSocketRunDelivery = (_socket: WebSocket): void => {};
  // A policy-revoked page is allowed to service the browser-storage exchange
  // of an action it already started, but it must not receive action events,
  // replays, or an unavailable-run result. A delayed store read can also
  // resume after its socket's cleanup, so delivery requires both a live
  // gateway connection and current publication access.
  const canDeliverRunResult = (socket: WebSocket): boolean =>
    connections.has(socket) && !policyRevokedSockets.has(socket);
  const closePolicyRevokedSocketIfIdle = (socket: WebSocket): void => {
    if (!policyRevokedSockets.has(socket)) return;
    if ((activeRunIdsBySocket.get(socket)?.size ?? 0) > 0) return;
    closeSocketForAuthorization(socket, 1008, 'Web app access was revoked');
  };
  const markSocketPolicyRevoked = (socket: WebSocket): void => {
    // An already-cleaned-up socket may have a queued policy callback. Do not
    // recreate policy state for it; late asynchronous work will fail the same
    // live-connection delivery predicate.
    if (!connections.has(socket)) return;
    policyRevokedSockets.add(socket);
    // Browser-storage RPC remains attached to an accepted action, but its
    // action journal and remote subscriptions must stop sending results as
    // soon as the user's current publication access is revoked.
    detachSocketRunDelivery(socket);
    closePolicyRevokedSocketIfIdle(socket);
  };
  const trackAcceptedRun = (socket: WebSocket, runId: string): void => {
    activeRunOwnerSockets.set(runId, socket);
    const runIds = activeRunIdsBySocket.get(socket) ?? new Set<string>();
    runIds.add(runId);
    activeRunIdsBySocket.set(socket, runIds);
  };
  const untrackAcceptedRun = (runId: string): void => {
    const socket = activeRunOwnerSockets.get(runId);
    if (!socket) return;
    activeRunOwnerSockets.delete(runId);
    const runIds = activeRunIdsBySocket.get(socket);
    runIds?.delete(runId);
    if (runIds?.size === 0) activeRunIdsBySocket.delete(socket);
    closePolicyRevokedSocketIfIdle(socket);
  };
  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Observability must never alter action or connection cleanup.
    }
  };
  const authorizeSocketOperation = async (
    socket: WebSocket,
    session: RivetWebAppSocketSession,
    operation: RivetWebAppSocketOperation,
    onPolicyRevoked: () => void,
  ): Promise<RivetWebAppSocketAuthorizationStatus> => {
    // A policy callback can win while an authorization or any preceding
    // asynchronous operation is in flight. Treat that as a revocation even
    // if the policy reader itself returned an older successful decision. This
    // also protects sessions whose policy is pushed through onPolicyRevoked
    // instead of authorizeOperation.
    if (!canDeliverRunResult(socket)) {
      if (policyRevokedSockets.has(socket)) onPolicyRevoked();
      return 'policy-revoked';
    }
    if (!session.authorizeOperation) return 'authorized';
    let authorization: RivetWebAppSocketAuthorizationStatus;
    try {
      authorization = await session.authorizeOperation(operation);
    } catch {
      authorization = 'unavailable';
    }
    if (authorization === 'authorized' && canDeliverRunResult(socket)) return authorization;
    if (authorization === 'authorized') {
      if (policyRevokedSockets.has(socket)) onPolicyRevoked();
      return 'policy-revoked';
    }
    if (authorization === 'policy-revoked') {
      markSocketPolicyRevoked(socket);
      onPolicyRevoked();
      return authorization;
    }
    closeSocketForAuthorization(
      socket,
      authorization === 'unavailable' ? 1013 : 1008,
      authorization === 'unavailable' ? 'Web app authorization is temporarily unavailable' : 'Web app access was revoked',
    );
    return authorization;
  };

  const journal = createWebAppRunJournal({
    coordinator,
    getRunOwnerScope: activeRuns.getOwnerScope,
    hostId,
    leaseId,
    reportError,
    store,
  });
  const { append: appendAndBroadcast, broadcast, subscribe, unsubscribe } = journal;

  const finishRun = (runId: string, fallbackOwnerScope?: string): void => {
    browserStorageHosts.get(runId)?.host.dispose();
    browserStorageHosts.delete(runId);
    untrackAcceptedRun(runId);
    const releasePermit = runPermitReleases.get(runId);
    runPermitReleases.delete(runId);
    try {
      activeRuns.finish(runId, fallbackOwnerScope);
    } finally {
      releasePermit?.();
    }
  };
  const replay = (socket: WebSocket, run: RivetWebAppStoredRun, afterSequence: number): number => {
    if (!canDeliverRunResult(socket)) return afterSequence;
    let lastSequence = afterSequence;
    for (const event of run.events) {
      if (event.sequence <= afterSequence) continue;
      safeSend(socket, event);
      lastSequence = Math.max(lastSequence, event.sequence);
    }
    return lastSequence;
  };
  const rejectRun = (socket: WebSocket, runId: string): void => {
    if (!canDeliverRunResult(socket)) return;
    safeSend(socket, {
      type: 'run.rejected',
      runId,
      error: 'The web app action is unavailable.',
      code: 'run_unavailable',
    });
  };
  const remoteRunSubscriptions = createWebAppRemoteRunSubscriptions({
    canDeliver: canDeliverRunResult,
    coordinator,
    rejectRun,
    replay,
    reportError,
    store,
  });
  detachSocketRunDelivery = (socket: WebSocket): void => {
    for (const runId of journal.subscribedRunIds()) unsubscribe(socket, runId);
    remoteRunSubscriptions.closeSocket(socket);
  };
  const attachRun = async (socket: WebSocket, run: RivetWebAppStoredRun, afterSequence: number): Promise<void> => {
    if (!canDeliverRunResult(socket)) return;
    let snapshot = run;
    if (afterSequence > snapshot.lastSequence) {
      const latest = await store.getRun(run.runId);
      if (!canDeliverRunResult(socket)) return;
      if (!latest || afterSequence > latest.lastSequence) {
        rejectRun(socket, run.runId);
        return;
      }
      snapshot = latest;
    }

    if (snapshot.status !== 'running') {
      replay(socket, snapshot, afterSequence);
      return;
    }

    if (snapshot.hostId !== hostId) {
      await remoteRunSubscriptions.attach(socket, snapshot, afterSequence);
      return;
    }

    if (!activeRuns.has(snapshot.runId)) {
      const latest = await store.getRun(snapshot.runId);
      if (!canDeliverRunResult(socket)) return;
      if (!latest || latest.status === 'running') {
        rejectRun(socket, snapshot.runId);
      } else {
        replay(socket, latest, Math.max(afterSequence, snapshot.lastSequence));
      }
      return;
    }

    replay(socket, snapshot, afterSequence);
    subscribe(socket, snapshot.runId);
    const latest = await store.getRun(snapshot.runId);
    if (!canDeliverRunResult(socket)) {
      unsubscribe(socket, snapshot.runId);
      return;
    }
    if (latest) {
      replay(socket, latest, Math.max(afterSequence, snapshot.lastSequence));
      if (latest.status !== 'running') unsubscribe(socket, snapshot.runId);
    }
  };
  const reject = (socket: WebSocket, requestId: string, error: unknown): void => {
    safeSend(socket, {
      type: 'action.rejected',
      requestId,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof RivetWebAppActionHttpError && error.code ? { code: error.code } : {}),
    });
  };
  const rejectPolicyRevokedAction = (socket: WebSocket, requestId: string): void => {
    reject(socket, requestId, createAccessRevokedError());
  };
  const rejectPolicyRevokedRun = (socket: WebSocket, runId: string): void => {
    safeSend(socket, {
      type: 'run.rejected',
      runId,
      error: 'Web app access was revoked.',
      code: 'access_revoked',
    });
  };
  const rejectRunSubscribers = (runId: string): void => {
    journal.rejectSubscribers(runId, (socket) => rejectRun(socket, runId));
  };
  const handleTerminalPersistenceError = (runId: string, error: unknown): void => {
    journal.deleteCallbacks(runId);
    reportError(error);
    rejectRunSubscribers(runId);
  };
  const cancelOwnedRun = async (run: RivetWebAppStoredRun): Promise<boolean> => {
    if (run.hostId !== hostId || run.leaseId !== leaseId || run.status !== 'running') return false;
    const active = activeRuns.get(run.runId);
    if (!active) return false;

    active.abortController.abort(new Error('Cancelled by user.'));
    const callbacks = journal.getCallbacks(run.runId);
    if (callbacks) callbacks.error = new Error('Cancelled by user.');
    try {
      return Boolean(
        await appendAndBroadcast(run.runId, {
          type: 'action.cancelled',
          requestId: run.requestId,
          runId: run.runId,
        }),
      );
    } finally {
      finishRun(run.runId);
      void active.processor?.abort(false, 'Cancelled by user.').catch(reportError);
    }
  };
  const cancelRun = async (socket: WebSocket, run: RivetWebAppStoredRun): Promise<void> => {
    const cancelled =
      run.hostId === hostId
        ? await cancelOwnedRun(run)
        : (await coordinator?.cancelRun({ hostId: run.hostId, ownerScope: run.ownerScope, runId: run.runId })) ?? false;
    if (cancelled) return;

    const latest = await store.getRun(run.runId);
    if (!canDeliverRunResult(socket)) return;
    if (latest && latest.status !== 'running') {
      replay(socket, latest, 0);
    } else {
      rejectRun(socket, run.runId);
    }
  };
  const unregisterCoordinator = coordinator?.registerHost(hostId, {
    async cancelRun({ ownerScope, runId }) {
      const run = await store.getRun(runId);
      if (!run || run.ownerScope !== ownerScope) return false;
      return cancelOwnedRun(run);
    },
  });
  const recoverExpiredRuns = async (error: string): Promise<RivetWebAppStoredRun[]> => {
    const interruptedRuns = await store.interruptExpiredRuns(error);
    await journal.publishInterruptedRuns(interruptedRuns);
    return interruptedRuns;
  };
  const leaseManager = createWebAppLeaseManager({
    getActiveRunIds: activeRuns.leaseManagedRunIds,
    leaseDurationMs,
    leaseId,
    leaseRenewIntervalMs,
    async onLeaseLost(runId, recoveredAsInterrupted) {
      const active = activeRuns.get(runId);
      if (!active || !active.durableLeaseActive) return;
      const error = 'Web app action ownership lease was lost.';
      active.interruptionError = error;
      active.abortController.abort(new Error(error));
      void active.processor?.abort(false, error).catch(reportError);
      finishRun(runId);
      if (recoveredAsInterrupted) return;

      const terminalEvent = (await store.getRun(runId))?.events.at(-1);
      if (terminalEvent && isRivetWebAppRunTerminalEvent(terminalEvent)) {
        broadcast(terminalEvent);
        await journal.notifyTerminal(runId, terminalEvent);
      } else {
        journal.deleteCallbacks(runId);
        rejectRunSubscribers(runId);
      }
    },
    recoverExpiredRuns,
    reportError,
    store,
  });

  const startAction = async (
    socket: WebSocket,
    session: RivetWebAppSocketSession,
    message: RivetWebAppActionStartMessage,
  ): Promise<void> => {
    if (disposed) {
      reject(socket, message.requestId, createServerDrainingError());
      return;
    }

    const requestKey = getRequestKey(session.ownerScope, message.requestId);
    const pendingSetup = pendingRunSetups.get(requestKey);
    if (pendingSetup) {
      const run = await pendingSetup;
      if (!run) {
        reject(socket, message.requestId, new Error('The original web app action could not be started.'));
      } else if (run.componentId !== message.componentId) {
        reject(socket, message.requestId, createRequestIdConflictError());
      } else {
        if (await authorizeSocketOperation(socket, session, 'action-start', () => rejectPolicyRevokedAction(socket, message.requestId)) !== 'authorized') {
          return;
        }
        await attachRun(socket, run, 0);
      }
      return;
    }

    let resolveSetup!: (run: RivetWebAppStoredRun | undefined) => void;
    let setupResolved = false;
    const setupPromise = new Promise<RivetWebAppStoredRun | undefined>((resolve) => {
      resolveSetup = resolve;
    });
    const completeSetup = (run: RivetWebAppStoredRun | undefined): void => {
      if (setupResolved) return;
      setupResolved = true;
      resolveSetup(run);
      pendingRunSetups.delete(requestKey);
    };
    pendingRunSetups.set(requestKey, setupPromise);

    let createdRunId: string | undefined;
    let acquiredPermit: RivetWebAppRunPermit | undefined;
    let accepted = false;
    let storedRunCreated = false;
    try {
      const existing = await store.getRunByRequestId(session.ownerScope, message.requestId);
      if (existing) {
        completeSetup(existing);
        if (existing.componentId !== message.componentId) {
          reject(socket, message.requestId, createRequestIdConflictError());
          return;
        }
        if (await authorizeSocketOperation(socket, session, 'action-start', () => rejectPolicyRevokedAction(socket, message.requestId)) !== 'authorized') {
          return;
        }
        await attachRun(socket, existing, 0);
        return;
      }

      if (draining) {
        completeSetup(undefined);
        reject(socket, message.requestId, createServerDrainingError());
        return;
      }

      const runId = nanoid();
      if (!activeRuns.reserve(session.ownerScope, runId, maxActiveRunsPerScope)) {
        completeSetup(undefined);
        reject(socket, message.requestId, new Error('Too many active web app actions.'));
        return;
      }

      try {
        const permit = await session.acquireRunPermit?.({
          componentId: message.componentId,
          ownerScope: session.ownerScope,
          requestId: message.requestId,
          runId,
        });
        if (permit) acquiredPermit = permit;
      } catch (error) {
        activeRuns.release(session.ownerScope, runId);
        completeSetup(undefined);
        throw error;
      }

      createdRunId = runId;
      const authorization = await authorizeSocketOperation(socket, session, 'action-start', () => {});
      if (authorization !== 'authorized') {
        throw authorization === 'unavailable'
          ? createActionUnavailableError()
          : createAccessRevokedError();
      }
      const created = await store.createRun({
        componentId: message.componentId,
        createdAt: Date.now(),
        hostId,
        leaseDurationMs,
        leaseId,
        ownerScope: session.ownerScope,
        requestId: message.requestId,
        runId,
      });
      // From this point the gateway owns cleanup of a newly durable row, even
      // if the immediately following authorization check rejects it.
      storedRunCreated = created.created;
      // `createRun` is durable, asynchronous setup. Recheck immediately
      // afterward so a publication change that wins this race cannot reach
      // processor preparation or graph execution. A newly created durable
      // row is interrupted by the ordinary setup-failure cleanup below.
      const postCreateAuthorization = await authorizeSocketOperation(socket, session, 'action-start', () => {});
      if (postCreateAuthorization !== 'authorized') {
        throw postCreateAuthorization === 'unavailable'
          ? createActionUnavailableError()
          : createAccessRevokedError();
      }
      if (!created.created) {
        activeRuns.release(session.ownerScope, runId);
        acquiredPermit?.release();
        acquiredPermit = undefined;
        createdRunId = undefined;
        completeSetup(created.run);
        if (created.run.componentId !== message.componentId) {
          reject(socket, message.requestId, createRequestIdConflictError());
          return;
        }
        await attachRun(socket, created.run, 0);
        return;
      }
      if (acquiredPermit) {
        const permit = acquiredPermit;
        runPermitReleases.set(runId, () => permit.release());
        acquiredPermit = undefined;
      }
      if (draining) throw createServerDrainingError();

      const abortController = new AbortController();
      const browserStorageHost =
        message.storageRpcVersion === 2 && !session.storedValueStore
          ? new RivetWebAppBrowserStorageRpcHost({
              admission: browserStorageAdmission,
              limits: browserStorageLimits,
              onEvent(event) {
                try {
                  options.onBrowserStorageRpcEvent?.(event);
                } catch {
                  // Observability must never alter action execution.
                }
              },
              requestId: message.requestId,
              runId,
              sendBinary: (frame) => sendWebAppSocketBinary(socket, frame),
              sendJson: (storageMessage) => safeSend(socket, storageMessage),
              signal: abortController.signal,
            })
          : undefined;
      if (!session.storedValueStore) {
        try {
          options.onBrowserStorageRpcEvent?.({
            type: 'protocol-negotiated',
            version: browserStorageHost ? '2' : 'legacy',
          });
        } catch {
          // Observability must never alter action execution.
        }
      }
      if (browserStorageHost) browserStorageHosts.set(runId, { host: browserStorageHost, socket });
      const activeRun: ActiveWebAppRun = {
        abortController,
        durableLeaseActive: true,
        ownerScope: session.ownerScope,
      };
      activeRuns.activate(runId, activeRun);
      trackAcceptedRun(socket, runId);
      subscribe(socket, runId);
      const acceptedEvent = await appendAndBroadcast(runId, {
        type: 'action.accepted',
        requestId: message.requestId,
        runId,
      });
      if (!acceptedEvent) throw new Error('The run store did not accept the new web app action.');
      accepted = true;
      completeSetup({
        ...created.run,
        events: [acceptedEvent],
        lastSequence: acceptedEvent.sequence,
        updatedAt: Date.now(),
      });

      try {
        const prepared = await prepareRivetWebAppAction(session.project, {
          componentId: message.componentId,
          createProcessorOptions: withAbortSignal(session.createProcessorOptions, abortController.signal),
          onActionError: session.onActionError,
          onActionFinish: session.onActionFinish,
          onActionStart: session.onActionStart,
          request: session.request,
          requestRevisionKey: message.revisionKey,
          resolveContext: session.resolveContext,
          revisionKey: session.revisionKey,
          state: message.state,
          storedValueStore: session.storedValueStore ?? browserStorageHost?.store,
          knowledgeStores: session.knowledgeStores,
          llmProfileHealthStore: session.llmProfileHealthStore,
          storage: message.storage,
          uiGraph: session.uiGraph,
        });
        try {
          activeRun.processor = prepared.processor;
          let resolvePreparation!: () => void;
          const preparation = new Promise<void>((resolve) => {
            resolvePreparation = resolve;
          });
          journal.setCallbacks(runId, {
            actionContext: prepared.context,
            onRunFailed: session.onRunFailed,
            onRunFinished: session.onRunFinished,
            preparation,
            requestId: message.requestId,
            runId,
          });
          try {
            await session.onProcessorPrepared?.({
              actionContext: prepared.context,
              processor: prepared.processor,
              requestId: message.requestId,
              runId,
            });
          } finally {
            resolvePreparation();
            const callbacks = journal.getCallbacks(runId);
            if (callbacks) delete callbacks.preparation;
          }
          abortController.signal.throwIfAborted();
        } catch (error) {
          prepared.dispose();
          if (abortController.signal.aborted) throw error;
          reportError(error);
          throw createActionUnavailableError();
        }
        prepared.processor.on('progress', ({ progress }) => {
          void appendAndBroadcast(runId, {
            type: 'action.progress',
            progress,
            requestId: message.requestId,
            runId,
          }).catch(reportError);
        });

        void prepared
          .run()
          .then(
            async (result) => {
              try {
                await browserStorageHost?.commit();
              } catch (error) {
                const callbacks = journal.getCallbacks(runId);
                if (callbacks) callbacks.error = error;
                return await appendAndBroadcast(runId, createRunErrorEvent(activeRun, message.requestId, runId, error));
              }
              const callbacks = journal.getCallbacks(runId);
              if (callbacks) callbacks.result = result;
              const completedEvent = await appendAndBroadcast(
                runId,
                {
                  type: 'action.completed',
                  requestId: message.requestId,
                  runId,
                  statePatch: result.statePatch,
                  storagePatch: result.storagePatch,
                  ...(result.responseTrace == null ? {} : { responseTrace: result.responseTrace }),
                },
                { deferTerminalNotification: true },
              );
              if (completedEvent) {
                activeRun.durableLeaseActive = false;
              }
              if (prepared.processor.isRunning) {
                await prepared.processor.waitForRunCompletion().catch(reportError);
              }
              if (completedEvent) {
                await journal.notifyTerminal(runId, completedEvent);
              }
              return completedEvent;
            },
            (error) => {
              const callbacks = journal.getCallbacks(runId);
              if (callbacks) callbacks.error = error;
              return appendAndBroadcast(runId, createRunErrorEvent(activeRun, message.requestId, runId, error));
            },
          )
          .catch((error) => handleTerminalPersistenceError(runId, error))
          .finally(() => finishRun(runId));
      } catch (error) {
        try {
          const callbacks = journal.getCallbacks(runId);
          if (callbacks) callbacks.error = error;
          await appendAndBroadcast(runId, createRunErrorEvent(activeRun, message.requestId, runId, error));
        } catch (storeError) {
          handleTerminalPersistenceError(runId, storeError);
        }
        finishRun(runId);
      }
    } catch (error) {
      if (createdRunId) {
        if (storedRunCreated) {
          try {
            await appendAndBroadcast(createdRunId, {
              type: 'action.interrupted',
              error: 'Web app action setup failed before execution started.',
              requestId: message.requestId,
              runId: createdRunId,
            });
          } catch (storeError) {
            handleTerminalPersistenceError(createdRunId, storeError);
          }
        }
        finishRun(createdRunId, session.ownerScope);
      }
      acquiredPermit?.release();
      completeSetup(undefined);
      if (!isServerDrainingError(error) && !(error instanceof RivetWebAppActionHttpError)) reportError(error);
      if (!accepted) {
        reject(
          socket,
          message.requestId,
          error instanceof RivetWebAppActionHttpError ? error : createActionUnavailableError(),
        );
      }
    }
  };

  return {
    async dispose(disposeOptions = {}) {
      if (disposed) return;
      disposed = true;
      draining = true;
      await leaseManager.dispose();
      for (const socket of connections) safeSend(socket, { type: 'server.draining' });
      try {
        await Promise.all([...pendingRunSetups.values()]);
        if (disposeOptions.interrupt) {
          const pendingEventWrites = journal.pendingWrites();
          for (const [runId, active] of activeRuns.entries()) {
            const error = 'Web app action server stopped before the run completed.';
            active.interruptionError = error;
            const callbacks = journal.getCallbacks(runId);
            if (callbacks) callbacks.error = new Error(error);
            active.abortController.abort(new Error(error));
            void active.processor?.abort(false, error).catch(reportError);
            finishRun(runId);
          }
          await Promise.all(pendingEventWrites);
          const interruptedRuns = await store.interruptRunsByLease(
            leaseId,
            'Web app action server stopped before the run completed.',
          );
          await journal.publishInterruptedRuns(interruptedRuns);
        }
      } finally {
        remoteRunSubscriptions.dispose();
        unregisterCoordinator?.();
        for (const socket of connections) socket.close(1012, 'Web app action server restarting');
        connections.clear();
        journal.clearSubscribers();
      }
    },
    drain(options = {}) {
      draining = true;
      for (const socket of connections) {
        safeSend(socket, { type: 'server.draining' });
        if (options.closeConnections) socket.close(1012, 'Web app action server restarting');
      }
    },
    getActiveRunCount() {
      return activeRuns.size();
    },
    handleConnection(socket, session) {
      if (disposed) {
        socket.close(1012, 'Web app action server restarting');
        return;
      }
      if (!session.ownerScope.trim()) {
        socket.close(1008, 'Owner scope is required');
        return;
      }
      connections.add(socket);
      const stopPolicyRevocation = session.onPolicyRevoked?.(() => {
        markSocketPolicyRevoked(socket);
      });
      attachWebAppSocketSession(socket, {
        isAuthorized: session.isAuthorized,
        handshakeTimeoutMs,
        heartbeatIntervalMs,
        heartbeatTimeoutMs,
        maxMessageBytes,
        browserStorageRpcLimits: {
          maxActionBytes: browserStorageLimits.maxActionBytes,
          maxValueBytes: browserStorageLimits.maxValueBytes,
          transferTimeoutMs: browserStorageLimits.transferTimeoutMs,
        },
        async onActionCancel(runId) {
          if (await authorizeSocketOperation(socket, session, 'action-cancel', () => rejectPolicyRevokedRun(socket, runId)) !== 'authorized') return;
          const run = await store.getRun(runId);
          if (!canDeliverRunResult(socket)) return;
          if (!run || run.ownerScope !== session.ownerScope) {
            rejectRun(socket, runId);
          } else if (run.status !== 'running') {
            if (await authorizeSocketOperation(socket, session, 'action-cancel', () => rejectPolicyRevokedRun(socket, runId)) !== 'authorized') return;
            replay(socket, run, 0);
          } else {
            if (await authorizeSocketOperation(socket, session, 'action-cancel', () => rejectPolicyRevokedRun(socket, runId)) !== 'authorized') return;
            await cancelRun(socket, run);
          }
        },
        onActionStart: async (message) => {
          if (await authorizeSocketOperation(socket, session, 'action-start', () => rejectPolicyRevokedAction(socket, message.requestId)) !== 'authorized') return;
          await startAction(socket, session, message);
        },
        onStorageBinary(frame) {
          const handled = [...browserStorageHosts.values()].some(
            (entry) => entry.socket === socket && entry.host.handleBinary(normalizeWebSocketBinary(frame)),
          );
          if (!handled) socket.close(1002, 'Unexpected browser storage frame');
        },
        onStorageMessage(message) {
          const entry = browserStorageHosts.get(message.runId);
          if (!entry || entry.socket !== socket) {
            socket.close(1008, 'Browser storage action ownership mismatch');
            return;
          }
          entry.host.handleMessage(message);
        },
        onCleanup() {
          stopPolicyRevocation?.();
          policyRevokedSockets.delete(socket);
          connections.delete(socket);
          activeRunIdsBySocket.delete(socket);
          for (const [runId, ownerSocket] of activeRunOwnerSockets) {
            if (ownerSocket === socket) activeRunOwnerSockets.delete(runId);
          }
          for (const [runId, entry] of browserStorageHosts) {
            if (entry.socket !== socket) continue;
            entry.host.dispose(new Error('Browser storage connection closed.'));
            browserStorageHosts.delete(runId);
          }
          detachSocketRunDelivery(socket);
        },
        onError: reportError,
        onInvalidMessage: (requestId, error) => reject(socket, requestId, error),
        async onRunResume(runId, lastSequence) {
          if (await authorizeSocketOperation(socket, session, 'run-resume', () => rejectPolicyRevokedRun(socket, runId)) !== 'authorized') return;
          const run = await store.getRun(runId);
          if (!canDeliverRunResult(socket)) return;
          if (!run || run.ownerScope !== session.ownerScope) {
            rejectRun(socket, runId);
          } else {
            if (await authorizeSocketOperation(socket, session, 'run-resume', () => rejectPolicyRevokedRun(socket, runId)) !== 'authorized') return;
            await attachRun(socket, run, lastSequence);
          }
        },
      });
    },
    async recoverInterruptedRuns(error = 'Web app action owner lease expired before completion.') {
      return (await recoverExpiredRuns(error)).length;
    },
  };
}

function withAbortSignal(
  createOptions: RivetWebAppCreateProcessorOptions | undefined,
  abortSignal: AbortSignal,
): RivetWebAppCreateProcessorOptions {
  return async (context) => {
    const resolved = typeof createOptions === 'function' ? await createOptions(context) : createOptions;
    return { ...resolved, abortSignal };
  };
}

function getRequestKey(ownerScope: string, requestId: string): string {
  return JSON.stringify([ownerScope, requestId]);
}

function createRequestIdConflictError(): RivetWebAppActionHttpError {
  return new RivetWebAppActionHttpError(
    'The web app action request ID was already used for another component.',
    409,

    'request_id_conflict',
  );
}

function createActionUnavailableError(): RivetWebAppActionHttpError {
  return new RivetWebAppActionHttpError('The web app action could not be started.', 503, 'action_unavailable');
}

function createAccessRevokedError(): RivetWebAppActionHttpError {
  return new RivetWebAppActionHttpError('Web app access was revoked.', 403, 'access_revoked');
}

function createServerDrainingError(): RivetWebAppActionHttpError {
  return new RivetWebAppActionHttpError('Web app action server is draining.', 503, 'server_draining');
}

function isServerDrainingError(error: unknown): error is RivetWebAppActionHttpError {
  return error instanceof RivetWebAppActionHttpError && error.code === 'server_draining';
}

function createRunErrorEvent(
  activeRun: ActiveWebAppRun,
  requestId: string,
  runId: string,
  error: unknown,
): RivetWebAppUnsequencedRunEvent {
  if (activeRun.interruptionError) {
    return { type: 'action.interrupted', error: activeRun.interruptionError, requestId, runId };
  }
  if (activeRun.abortController.signal.aborted) {
    return { type: 'action.cancelled', requestId, runId };
  }
  const responseTrace = getRivetWebAppActionErrorResponseTrace(error);
  return {
    type: 'action.failed',
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof RivetWebAppActionHttpError && error.code
      ? { code: error.code }
      : error instanceof RivetWebAppBrowserStorageRpcError
        ? { code: error.code }
        : {}),
    ...(responseTrace == null ? {} : { responseTrace }),
    requestId,
    runId,
  };
}

function getIntegerOption(name: string, value: number | undefined, fallback: number, minimum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return resolved;
}

function normalizeWebSocketBinary(frame: WebSocket.RawData): Uint8Array {
  if (Array.isArray(frame)) return Buffer.concat(frame);
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
}

import { nanoid } from 'nanoid';
import WebSocket, { type RawData } from 'ws';
import {
  RIVET_WEB_APP_ACTION_PROTOCOL_VERSION,
  isRivetWebAppRunTerminalEvent,
  parseRivetWebAppClientMessage,
  type GraphProcessor,
  type Project,
  type RivetWebAppActionStartMessage,
  type RivetWebAppRunEvent,
  type RivetWebAppServerMessage,
  type UiGraph,
} from '@valerypopoff/rivet2-core';
import {
  prepareRivetWebAppAction,
  RivetWebAppActionHttpError,
  type RivetWebAppActionContext,
  type RivetWebAppCreateProcessorOptions,
  type RivetWebAppHandlerOptions,
  type RivetWebAppActionResult,
} from './webAppHandler.js';
import { startWebSocketHeartbeat } from './webSocketHeartbeat.js';
import type {
  RivetWebAppCoordinatedRun,
  RivetWebAppRunCoordinator,
  RivetWebAppRunCoordinatorSubscription,
} from './webAppRunCoordinator.js';

export type RivetWebAppSocketSession = {
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
  drain(): void;
  getActiveRunCount(): number;
  handleConnection(socket: WebSocket, session: RivetWebAppSocketSession): void;
  recoverInterruptedRuns(error?: string): Promise<number>;
};

export type RivetWebAppWebSocketGatewayOptions = {
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  hostId?: string;
  leaseDurationMs?: number;
  leaseRenewIntervalMs?: number;
  maxActiveRunsPerScope?: number;
  maxMessageBytes?: number;
  onError?: (error: unknown) => void;
  runCoordinator?: RivetWebAppRunCoordinator;
  runStore?: RivetWebAppRunStore;
};

type ActiveRun = {
  abortController: AbortController;
  interruptionError?: string;
  ownerScope: string;
  processor?: Awaited<ReturnType<typeof prepareRivetWebAppAction>>['processor'];
};

type TerminalRunCallbacks = {
  actionContext: RivetWebAppActionContext;
  error?: unknown;
  onRunFailed?: RivetWebAppSocketSession['onRunFailed'];
  onRunFinished?: RivetWebAppSocketSession['onRunFinished'];
  preparation?: Promise<void>;
  requestId: string;
  result?: RivetWebAppActionResult;
  runId: string;
};

type RemoteRunSubscription = {
  closed: boolean;
  coordinatorSubscription?: RivetWebAppRunCoordinatorSubscription;
  lastSequence: number;
  queue: Promise<void>;
};

const DEFAULT_MAX_MESSAGE_BYTES = 1_000_000;
const DEFAULT_MAX_ACTIVE_RUNS_PER_SCOPE = 10;
const DEFAULT_MAX_EVENTS_PER_RUN = 256;
const DEFAULT_MAX_STORED_RUNS = 1_000;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 20_000;

export function createInMemoryRivetWebAppRunStore(
  options: {
    maxEventsPerRun?: number;
    maxStoredRuns?: number;
  } = {},
): RivetWebAppRunStore {
  const runs = new Map<string, RivetWebAppStoredRun>();
  const runIdByRequest = new Map<string, string>();
  const maxEventsPerRun = getIntegerOption('maxEventsPerRun', options.maxEventsPerRun, DEFAULT_MAX_EVENTS_PER_RUN, 2);
  const maxStoredRuns = getIntegerOption('maxStoredRuns', options.maxStoredRuns, DEFAULT_MAX_STORED_RUNS, 1);

  const interruptRuns = (predicate: (run: RivetWebAppStoredRun) => boolean, error: string): RivetWebAppStoredRun[] => {
    const interrupted: RivetWebAppStoredRun[] = [];
    for (const run of runs.values()) {
      if (run.status !== 'running' || !predicate(run)) continue;
      const event = {
        type: 'action.interrupted',
        error,
        requestId: run.requestId,
        runId: run.runId,
        sequence: run.lastSequence + 1,
      } satisfies RivetWebAppRunEvent;
      run.events.push(event);
      run.lastSequence = event.sequence;
      compactRunEvents(run, maxEventsPerRun);
      run.status = 'interrupted';
      run.updatedAt = Date.now();
      interrupted.push(cloneRun(run));
    }
    return interrupted;
  };

  return {
    async appendEvent(runId, leaseId, event) {
      const run = runs.get(runId);
      if (!run || run.status !== 'running' || run.leaseId !== leaseId || run.leaseExpiresAt <= Date.now()) {
        return undefined;
      }
      if (event.runId !== runId || event.requestId !== run.requestId) {
        throw new Error('Web app run event identity does not match its stored run.');
      }

      const sequencedEvent = structuredClone({ ...event, sequence: run.lastSequence + 1 }) as RivetWebAppRunEvent;
      run.events.push(sequencedEvent);
      run.lastSequence = sequencedEvent.sequence;
      compactRunEvents(run, maxEventsPerRun);
      run.updatedAt = Date.now();
      if (isRivetWebAppRunTerminalEvent(sequencedEvent)) {
        run.status = getTerminalStatus(sequencedEvent);
      }
      return sequencedEvent;
    },
    async createRun(input) {
      const requestKey = getRequestKey(input.ownerScope, input.requestId);
      const existingId = runIdByRequest.get(requestKey);
      const existing = existingId ? runs.get(existingId) : undefined;
      if (existing) return { created: false, run: cloneRun(existing) };
      if (runs.has(input.runId)) throw new Error(`Web app run ID "${input.runId}" is already in use.`);

      pruneStoredRuns(runs, runIdByRequest, maxStoredRuns - 1);
      if (runs.size >= maxStoredRuns) {
        throw new Error('Web app run store capacity reached.');
      }

      const { leaseDurationMs, ...runInput } = input;
      if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
        throw new RangeError('leaseDurationMs must be a positive safe integer.');
      }
      const run: RivetWebAppStoredRun = {
        ...runInput,
        events: [],
        lastSequence: 0,
        leaseExpiresAt: Date.now() + leaseDurationMs,
        status: 'running',
        updatedAt: input.createdAt,
      };
      runs.set(run.runId, run);
      runIdByRequest.set(requestKey, run.runId);
      return { created: true, run: cloneRun(run) };
    },
    async getRun(runId) {
      const run = runs.get(runId);
      return run ? cloneRun(run) : undefined;
    },
    async getRunByRequestId(ownerScope, requestId) {
      const runId = runIdByRequest.get(getRequestKey(ownerScope, requestId));
      const run = runId ? runs.get(runId) : undefined;
      return run ? cloneRun(run) : undefined;
    },
    async interruptExpiredRuns(error) {
      const now = Date.now();
      return interruptRuns((run) => run.leaseExpiresAt <= now, error);
    },
    async interruptRunsByLease(leaseId, error) {
      return interruptRuns((run) => run.leaseId === leaseId, error);
    },
    async renewRunLeases(leaseId, runIds, leaseDurationMs) {
      const now = Date.now();
      const leaseExpiresAt = now + leaseDurationMs;
      const renewed: string[] = [];
      for (const runId of runIds) {
        const run = runs.get(runId);
        if (!run) continue;
        if (run.status !== 'running' || run.leaseId !== leaseId || run.leaseExpiresAt <= now) continue;
        run.leaseExpiresAt = leaseExpiresAt;
        run.updatedAt = now;
        renewed.push(run.runId);
      }
      return renewed;
    },
  };
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
  const coordinator = options.runCoordinator;
  const activeRuns = new Map<string, ActiveRun>();
  const pendingRunSetups = new Map<string, Promise<RivetWebAppStoredRun | undefined>>();
  const subscribers = new Map<string, Set<WebSocket>>();
  const connections = new Set<WebSocket>();
  const runsByScope = new Map<string, Set<string>>();
  const eventAppendChains = new Map<string, Promise<void>>();
  const remoteSubscriptions = new Map<WebSocket, Map<string, RemoteRunSubscription>>();
  const terminalCallbacks = new Map<string, TerminalRunCallbacks>();
  let draining = false;
  let disposed = false;

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Observability must never alter action or connection cleanup.
    }
  };

  const broadcast = (event: RivetWebAppServerMessage): void => {
    if (!('runId' in event)) return;
    for (const socket of subscribers.get(event.runId) ?? []) safeSend(socket, event);
  };
  const publishCoordinatedEvent = async (run: RivetWebAppCoordinatedRun, event: RivetWebAppRunEvent): Promise<void> => {
    try {
      await coordinator?.publishEvent({ ...run, event });
    } catch (error) {
      reportError(error);
    }
  };
  const invokeTerminalCallbacks = async (
    callbacks: TerminalRunCallbacks,
    event: RivetWebAppRunEvent,
  ): Promise<void> => {
    try {
      if (event.type === 'action.completed') {
        if (!callbacks.result) {
          reportError(new Error(`Web app run "${callbacks.runId}" completed without an action result.`));
          return;
        }
        await callbacks.onRunFinished?.({
          actionContext: callbacks.actionContext,
          requestId: callbacks.requestId,
          result: callbacks.result,
          runId: callbacks.runId,
        });
        return;
      }

      const error =
        callbacks.error === undefined && (event.type === 'action.failed' || event.type === 'action.interrupted')
          ? event.error
          : callbacks.error;
      await callbacks.onRunFailed?.({
        actionContext: callbacks.actionContext,
        ...(error === undefined ? {} : { error }),
        outcome: getTerminalOutcome(event),
        requestId: callbacks.requestId,
        runId: callbacks.runId,
      });
    } catch (error) {
      reportError(error);
    }
  };
  const notifyTerminalCallbacks = async (runId: string, event: RivetWebAppRunEvent): Promise<void> => {
    if (!isRivetWebAppRunTerminalEvent(event)) return;
    const callbacks = terminalCallbacks.get(runId);
    if (!callbacks) return;
    terminalCallbacks.delete(runId);

    if (callbacks.preparation) {
      void callbacks.preparation.then(() => invokeTerminalCallbacks(callbacks, event));
      return;
    }
    await invokeTerminalCallbacks(callbacks, event);
  };
  const appendAndBroadcast = async (
    runId: string,
    event: RivetWebAppUnsequencedRunEvent,
  ): Promise<RivetWebAppRunEvent | undefined> => {
    const operation = (eventAppendChains.get(runId) ?? Promise.resolve()).then(async () => {
      const storedEvent = await store.appendEvent(runId, leaseId, event);
      if (storedEvent) {
        broadcast(storedEvent);
        const activeRun = activeRuns.get(runId);
        if (activeRun) {
          await publishCoordinatedEvent({ hostId, ownerScope: activeRun.ownerScope, runId }, storedEvent);
        }
        if (isRivetWebAppRunTerminalEvent(storedEvent)) {
          await notifyTerminalCallbacks(runId, storedEvent);
          subscribers.delete(runId);
        }
      }
      return storedEvent;
    });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    eventAppendChains.set(runId, tail);
    void tail.then(() => {
      if (eventAppendChains.get(runId) === tail) eventAppendChains.delete(runId);
    });
    return operation;
  };
  const releaseScopeRun = (ownerScope: string, runId: string): void => {
    const scopeRuns = runsByScope.get(ownerScope);
    scopeRuns?.delete(runId);
    if (scopeRuns?.size === 0) runsByScope.delete(ownerScope);
  };
  const finishRun = (runId: string, fallbackOwnerScope?: string): void => {
    const activeRun = activeRuns.get(runId);
    activeRuns.delete(runId);
    const ownerScope = activeRun?.ownerScope ?? fallbackOwnerScope;
    if (ownerScope) releaseScopeRun(ownerScope, runId);
  };
  const replay = (socket: WebSocket, run: RivetWebAppStoredRun, afterSequence: number): number => {
    let lastSequence = afterSequence;
    for (const event of run.events) {
      if (event.sequence <= afterSequence) continue;
      safeSend(socket, event);
      lastSequence = Math.max(lastSequence, event.sequence);
    }
    return lastSequence;
  };
  const subscribe = (socket: WebSocket, runId: string): void => {
    const runSubscribers = subscribers.get(runId) ?? new Set<WebSocket>();
    runSubscribers.add(socket);
    subscribers.set(runId, runSubscribers);
  };
  const unsubscribe = (socket: WebSocket, runId: string): void => {
    const runSubscribers = subscribers.get(runId);
    runSubscribers?.delete(socket);
    if (runSubscribers?.size === 0) subscribers.delete(runId);
  };
  const closeRemoteSubscription = (socket: WebSocket, runId: string): void => {
    const socketSubscriptions = remoteSubscriptions.get(socket);
    const state = socketSubscriptions?.get(runId);
    if (!state || state.closed) return;
    state.closed = true;
    socketSubscriptions?.delete(runId);
    if (socketSubscriptions?.size === 0) remoteSubscriptions.delete(socket);
    void Promise.resolve(state.coordinatorSubscription?.dispose()).catch(reportError);
  };
  const settleUnavailableRemoteRun = async (
    socket: WebSocket,
    runId: string,
    state: RemoteRunSubscription,
  ): Promise<void> => {
    if (state.closed) return;
    const latest = await store.getRun(runId);
    if (latest && latest.status !== 'running') {
      state.lastSequence = replay(socket, latest, state.lastSequence);
    } else {
      rejectRun(socket, runId);
    }
    closeRemoteSubscription(socket, runId);
  };
  const attachRemoteRun = async (
    socket: WebSocket,
    run: RivetWebAppStoredRun,
    afterSequence: number,
  ): Promise<void> => {
    closeRemoteSubscription(socket, run.runId);
    const state: RemoteRunSubscription = {
      closed: false,
      lastSequence: replay(socket, run, afterSequence),
      queue: Promise.resolve(),
    };
    const socketSubscriptions = remoteSubscriptions.get(socket) ?? new Map<string, RemoteRunSubscription>();
    socketSubscriptions.set(run.runId, state);
    remoteSubscriptions.set(socket, socketSubscriptions);
    if (!coordinator) {
      await settleUnavailableRemoteRun(socket, run.runId, state);
      return;
    }
    const enqueue = (operation: () => Promise<void> | void): void => {
      state.queue = state.queue.then(operation).catch((error) => {
        reportError(error);
        socket.close(1011, 'Run coordinator failed');
      });
    };
    const coordinatedRun = { hostId: run.hostId, ownerScope: run.ownerScope, runId: run.runId };
    const subscription = await coordinator.subscribe({
      ...coordinatedRun,
      onEvent(event) {
        enqueue(async () => {
          if (state.closed || event.runId !== run.runId || event.sequence <= state.lastSequence) return;

          if (event.sequence > state.lastSequence + 1) {
            const latest = await store.getRun(run.runId);
            if (!latest || latest.ownerScope !== run.ownerScope || latest.hostId !== run.hostId) {
              await settleUnavailableRemoteRun(socket, run.runId, state);
              return;
            }
            state.lastSequence = replay(socket, latest, state.lastSequence);
            if (latest.status !== 'running') {
              closeRemoteSubscription(socket, run.runId);
              return;
            }
          }

          if (state.closed || event.sequence <= state.lastSequence) return;
          safeSend(socket, event);
          state.lastSequence = event.sequence;
          if (isRivetWebAppRunTerminalEvent(event)) closeRemoteSubscription(socket, run.runId);
        });
      },
      onUnavailable() {
        enqueue(() => settleUnavailableRemoteRun(socket, run.runId, state));
      },
    });
    if (!subscription) {
      await settleUnavailableRemoteRun(socket, run.runId, state);
      return;
    }
    state.coordinatorSubscription = subscription;
    if (state.closed) {
      await subscription.dispose();
      return;
    }

    const latest = await store.getRun(run.runId);
    if (!latest || latest.ownerScope !== run.ownerScope || latest.hostId !== run.hostId) {
      await settleUnavailableRemoteRun(socket, run.runId, state);
      return;
    }
    state.lastSequence = replay(socket, latest, state.lastSequence);
    if (latest.status !== 'running') closeRemoteSubscription(socket, run.runId);
  };
  const attachRun = async (socket: WebSocket, run: RivetWebAppStoredRun, afterSequence: number): Promise<void> => {
    let snapshot = run;
    if (afterSequence > snapshot.lastSequence) {
      const latest = await store.getRun(run.runId);
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
      await attachRemoteRun(socket, snapshot, afterSequence);
      return;
    }

    if (!activeRuns.has(snapshot.runId)) {
      const latest = await store.getRun(snapshot.runId);
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
  const rejectRun = (socket: WebSocket, runId: string): void => {
    safeSend(socket, {
      type: 'run.rejected',
      runId,
      error: 'The web app action is unavailable.',
      code: 'run_unavailable',
    });
  };
  const rejectRunSubscribers = (runId: string): void => {
    for (const socket of subscribers.get(runId) ?? []) rejectRun(socket, runId);
    subscribers.delete(runId);
  };
  const handleTerminalPersistenceError = (runId: string, error: unknown): void => {
    terminalCallbacks.delete(runId);
    reportError(error);
    rejectRunSubscribers(runId);
  };
  const cancelOwnedRun = async (run: RivetWebAppStoredRun): Promise<boolean> => {
    if (run.hostId !== hostId || run.leaseId !== leaseId || run.status !== 'running') return false;
    const active = activeRuns.get(run.runId);
    if (!active) return false;

    active.abortController.abort(new Error('Cancelled by user.'));
    const callbacks = terminalCallbacks.get(run.runId);
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
  const publishInterruptedRuns = async (runs: RivetWebAppStoredRun[]): Promise<void> => {
    for (const run of runs) {
      const terminalEvent = run.events.at(-1);
      if (!terminalEvent || !isRivetWebAppRunTerminalEvent(terminalEvent)) continue;
      broadcast(terminalEvent);
      await notifyTerminalCallbacks(run.runId, terminalEvent);
      subscribers.delete(run.runId);
      await publishCoordinatedEvent(
        { hostId: run.hostId, ownerScope: run.ownerScope, runId: run.runId },
        terminalEvent,
      );
    }
  };
  const recoverExpiredRuns = async (error: string): Promise<RivetWebAppStoredRun[]> => {
    const interruptedRuns = await store.interruptExpiredRuns(error);
    await publishInterruptedRuns(interruptedRuns);
    return interruptedRuns;
  };
  let leaseMaintenanceRunning = false;
  const maintainLeases = async (): Promise<void> => {
    if (disposed || leaseMaintenanceRunning) return;
    leaseMaintenanceRunning = true;
    const expectedRunIds = new Set(activeRuns.keys());
    try {
      const renewedRunIds = new Set(await store.renewRunLeases(leaseId, [...expectedRunIds], leaseDurationMs));
      const interruptedRuns = await recoverExpiredRuns('Web app action owner lease expired before completion.');
      const interruptedRunIds = new Set(interruptedRuns.map((run) => run.runId));

      for (const runId of expectedRunIds) {
        if (renewedRunIds.has(runId)) continue;
        const active = activeRuns.get(runId);
        if (!active) continue;
        const error = 'Web app action ownership lease was lost.';
        active.interruptionError = error;
        active.abortController.abort(new Error(error));
        void active.processor?.abort(false, error).catch(reportError);
        finishRun(runId);
        if (interruptedRunIds.has(runId)) continue;

        const latest = await store.getRun(runId);
        const terminalEvent = latest?.events.at(-1);
        if (terminalEvent && isRivetWebAppRunTerminalEvent(terminalEvent)) {
          broadcast(terminalEvent);
          await notifyTerminalCallbacks(runId, terminalEvent);
          subscribers.delete(runId);
        } else {
          terminalCallbacks.delete(runId);
          rejectRunSubscribers(runId);
        }
      }
    } catch (error) {
      reportError(error);
    } finally {
      leaseMaintenanceRunning = false;
    }
  };
  const leaseMaintenanceTimer = setInterval(() => void maintainLeases(), leaseRenewIntervalMs);
  leaseMaintenanceTimer.unref?.();
  void maintainLeases();

  const startAction = async (
    socket: WebSocket,
    session: RivetWebAppSocketSession,
    message: RivetWebAppActionStartMessage,
  ): Promise<void> => {
    const requestKey = getRequestKey(session.ownerScope, message.requestId);
    const pendingSetup = pendingRunSetups.get(requestKey);
    if (pendingSetup) {
      const run = await pendingSetup;
      if (!run) {
        reject(socket, message.requestId, new Error('The original web app action could not be started.'));
      } else if (run.componentId !== message.componentId) {
        reject(socket, message.requestId, createRequestIdConflictError());
      } else {
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
    let accepted = false;
    try {
      const existing = await store.getRunByRequestId(session.ownerScope, message.requestId);
      if (existing) {
        completeSetup(existing);
        if (existing.componentId !== message.componentId) {
          reject(socket, message.requestId, createRequestIdConflictError());
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

      const scopeRuns = runsByScope.get(session.ownerScope) ?? new Set<string>();
      if (scopeRuns.size >= maxActiveRunsPerScope) {
        completeSetup(undefined);
        reject(socket, message.requestId, new Error('Too many active web app actions.'));
        return;
      }

      const runId = nanoid();
      createdRunId = runId;
      scopeRuns.add(runId);
      runsByScope.set(session.ownerScope, scopeRuns);
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
      if (!created.created) {
        releaseScopeRun(session.ownerScope, runId);
        createdRunId = undefined;
        completeSetup(created.run);
        if (created.run.componentId !== message.componentId) {
          reject(socket, message.requestId, createRequestIdConflictError());
          return;
        }
        await attachRun(socket, created.run, 0);
        return;
      }
      if (draining) throw createServerDrainingError();

      const abortController = new AbortController();
      const activeRun: ActiveRun = { abortController, ownerScope: session.ownerScope };
      activeRuns.set(runId, activeRun);
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
          uiGraph: session.uiGraph,
        });
        try {
          activeRun.processor = prepared.processor;
          let resolvePreparation!: () => void;
          const preparation = new Promise<void>((resolve) => {
            resolvePreparation = resolve;
          });
          terminalCallbacks.set(runId, {
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
            const callbacks = terminalCallbacks.get(runId);
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
            (result) => {
              const callbacks = terminalCallbacks.get(runId);
              if (callbacks) callbacks.result = result;
              return appendAndBroadcast(runId, {
                type: 'action.completed',
                requestId: message.requestId,
                runId,
                statePatch: result.statePatch,
              });
            },
            (error) => {
              const callbacks = terminalCallbacks.get(runId);
              if (callbacks) callbacks.error = error;
              return appendAndBroadcast(runId, createRunErrorEvent(activeRun, message.requestId, runId, error));
            },
          )
          .catch((error) => handleTerminalPersistenceError(runId, error))
          .finally(() => finishRun(runId));
      } catch (error) {
        try {
          const callbacks = terminalCallbacks.get(runId);
          if (callbacks) callbacks.error = error;
          await appendAndBroadcast(runId, createRunErrorEvent(activeRun, message.requestId, runId, error));
        } catch (storeError) {
          handleTerminalPersistenceError(runId, storeError);
        }
        finishRun(runId);
      }
    } catch (error) {
      if (createdRunId) {
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
        finishRun(createdRunId, session.ownerScope);
      }
      completeSetup(undefined);
      if (!isServerDrainingError(error)) reportError(error);
      if (!accepted) {
        reject(socket, message.requestId, isServerDrainingError(error) ? error : createActionUnavailableError());
      }
    }
  };

  return {
    async dispose(disposeOptions = {}) {
      if (disposed) return;
      disposed = true;
      draining = true;
      clearInterval(leaseMaintenanceTimer);
      for (const socket of connections) safeSend(socket, { type: 'server.draining' });
      try {
        if (disposeOptions.interrupt) {
          const pendingEventWrites = [...eventAppendChains.values()];
          for (const [runId, active] of activeRuns) {
            const error = 'Web app action server stopped before the run completed.';
            active.interruptionError = error;
            const callbacks = terminalCallbacks.get(runId);
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
          await publishInterruptedRuns(interruptedRuns);
        }
      } finally {
        for (const [socket, socketSubscriptions] of remoteSubscriptions) {
          for (const runId of socketSubscriptions.keys()) closeRemoteSubscription(socket, runId);
        }
        unregisterCoordinator?.();
        for (const socket of connections) socket.close(1012, 'Web app action server restarting');
        connections.clear();
        subscribers.clear();
      }
    },
    drain() {
      draining = true;
      for (const socket of connections) safeSend(socket, { type: 'server.draining' });
    },
    getActiveRunCount() {
      return activeRuns.size;
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
      const heartbeat = startWebSocketHeartbeat(socket, {
        intervalMs: heartbeatIntervalMs,
        timeoutMs: heartbeatTimeoutMs,
      });
      let protocolReady = false;
      let handshakeTimeout: ReturnType<typeof setTimeout> | undefined;
      if (handshakeTimeoutMs > 0) {
        handshakeTimeout = setTimeout(() => {
          if (!protocolReady) socket.close(1002, 'Protocol handshake timed out');
        }, handshakeTimeoutMs);
        handshakeTimeout.unref?.();
      }
      socket.on('message', (raw) => {
        heartbeat.markActivity();
        if (getRawDataByteLength(raw) > maxMessageBytes) {
          socket.close(1009, 'Message too large');
          return;
        }
        const parsed = parseSocketMessage(raw);
        const message = parseRivetWebAppClientMessage(parsed);
        if (!message) {
          if (isMessageType(parsed, 'client.hello')) {
            socket.close(1002, 'Unsupported protocol version');
            return;
          }
          reject(socket, readRequestId(parsed) ?? 'invalid-request', new Error('Invalid web app action message.'));
          return;
        }

        if (message.type === 'client.hello') {
          protocolReady = true;
          if (handshakeTimeout) {
            clearTimeout(handshakeTimeout);
            handshakeTimeout = undefined;
          }
          safeSend(socket, {
            type: 'server.ready',
            protocolVersion: RIVET_WEB_APP_ACTION_PROTOCOL_VERSION,
          });
          return;
        }
        if (!protocolReady) {
          socket.close(1002, 'Protocol handshake required');
          return;
        }

        if (message.type === 'action.start') {
          void startAction(socket, session, message).catch((error) => {
            reportError(error);
            socket.close(1011, 'Action setup failed');
          });
        } else if (message.type === 'run.resume') {
          void store
            .getRun(message.runId)
            .then(async (run) => {
              if (!run || run.ownerScope !== session.ownerScope) {
                rejectRun(socket, message.runId);
                return;
              }
              await attachRun(socket, run, message.lastSequence);
            })
            .catch((error) => {
              reportError(error);
              socket.close(1011, 'Run store failed');
            });
        } else if (message.type === 'action.cancel') {
          void store
            .getRun(message.runId)
            .then(async (run) => {
              if (!run || run.ownerScope !== session.ownerScope) {
                rejectRun(socket, message.runId);
                return;
              }
              if (run.status !== 'running') {
                replay(socket, run, 0);
                return;
              }
              await cancelRun(socket, run);
            })
            .catch((error) => {
              reportError(error);
              socket.close(1011, 'Run store failed');
            });
        }
      });

      let connectionCleanedUp = false;
      const cleanupConnection = () => {
        if (connectionCleanedUp) return;
        connectionCleanedUp = true;
        if (handshakeTimeout) clearTimeout(handshakeTimeout);
        heartbeat.stop();
        connections.delete(socket);
        for (const runId of subscribers.keys()) unsubscribe(socket, runId);
        for (const runId of remoteSubscriptions.get(socket)?.keys() ?? []) closeRemoteSubscription(socket, runId);
      };
      socket.once('close', cleanupConnection);
      socket.once('error', cleanupConnection);
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

function safeSend(socket: WebSocket, message: RivetWebAppServerMessage): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function parseSocketMessage(raw: RawData): unknown {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  } catch {
    return undefined;
  }
}

function getRawDataByteLength(raw: RawData): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw);
  if (Array.isArray(raw)) return raw.reduce((total, item) => total + item.byteLength, 0);
  return raw.byteLength;
}

function readRequestId(value: unknown): string | undefined {
  return typeof value === 'object' && value != null && 'requestId' in value && typeof value.requestId === 'string'
    ? value.requestId
    : undefined;
}

function isMessageType(value: unknown, type: string): boolean {
  return typeof value === 'object' && value != null && 'type' in value && value.type === type;
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

function createServerDrainingError(): RivetWebAppActionHttpError {
  return new RivetWebAppActionHttpError('Web app action server is draining.', 503, 'server_draining');
}

function isServerDrainingError(error: unknown): error is RivetWebAppActionHttpError {
  return error instanceof RivetWebAppActionHttpError && error.code === 'server_draining';
}

function createRunErrorEvent(
  activeRun: ActiveRun,
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
  return {
    type: 'action.failed',
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof RivetWebAppActionHttpError && error.code ? { code: error.code } : {}),
    requestId,
    runId,
  };
}

function getTerminalStatus(event: RivetWebAppRunEvent): RivetWebAppStoredRun['status'] {
  switch (event.type) {
    case 'action.completed':
      return 'completed';
    case 'action.failed':
      return 'failed';
    case 'action.cancelled':
      return 'cancelled';
    case 'action.interrupted':
      return 'interrupted';
    default:
      return 'running';
  }
}

function getTerminalOutcome(event: RivetWebAppRunEvent): RivetWebAppRunFailedContext['outcome'] {
  switch (event.type) {
    case 'action.failed':
      return 'failed';
    case 'action.cancelled':
      return 'cancelled';
    case 'action.interrupted':
      return 'interrupted';
    default:
      throw new Error(`Run "${event.runId}" completed successfully and has no failure outcome.`);
  }
}

function cloneRun(run: RivetWebAppStoredRun): RivetWebAppStoredRun {
  return structuredClone(run);
}

function compactRunEvents(run: RivetWebAppStoredRun, maxEvents: number): void {
  if (run.events.length <= maxEvents) return;
  const accepted = run.events.find((event) => event.type === 'action.accepted');
  const tailSize = accepted ? maxEvents - 1 : maxEvents;
  const tail = run.events.filter((event) => event !== accepted).slice(-tailSize);
  run.events = accepted ? [accepted, ...tail] : tail;
}

function pruneStoredRuns(
  runs: Map<string, RivetWebAppStoredRun>,
  runIdByRequest: Map<string, string>,
  targetSize: number,
): void {
  if (runs.size <= targetSize) return;
  const removableRuns = [...runs.values()]
    .filter((run) => run.status !== 'running')
    .sort((left, right) => left.updatedAt - right.updatedAt);
  for (const run of removableRuns) {
    if (runs.size <= targetSize) break;
    runs.delete(run.runId);
    runIdByRequest.delete(getRequestKey(run.ownerScope, run.requestId));
  }
}

function getIntegerOption(name: string, value: number | undefined, fallback: number, minimum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return resolved;
}

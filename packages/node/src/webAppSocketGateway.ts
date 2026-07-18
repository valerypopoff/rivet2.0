import { nanoid } from 'nanoid';
import type WebSocket from 'ws';
import {
  isRivetWebAppRunTerminalEvent,
  type GraphProcessor,
  type Project,
  type RivetWebAppActionStartMessage,
  type RivetWebAppRunEvent,
  type RivetStoredValueStore,
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
import type { RivetWebAppRunCoordinator } from './webAppRunCoordinator.js';
import { createInMemoryRivetWebAppRunStore } from './webAppRunStore.js';
import { createWebAppRunJournal } from './webAppRunJournal.js';
import { createWebAppLeaseManager } from './webAppLeaseManager.js';
import { sendWebAppSocketMessage as safeSend } from './webAppSocketProtocol.js';
import { attachWebAppSocketSession } from './webAppSocketSession.js';
import { createWebAppRemoteRunSubscriptions } from './webAppRemoteRunSubscriptions.js';
import { createWebAppActiveRunRegistry, type ActiveWebAppRun } from './webAppActiveRuns.js';

export { createInMemoryRivetWebAppRunStore } from './webAppRunStore.js';

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
  storedValueStore?: RivetStoredValueStore;
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

const DEFAULT_MAX_MESSAGE_BYTES = 1_000_000;
const DEFAULT_MAX_ACTIVE_RUNS_PER_SCOPE = 10;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 20_000;

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
  const activeRuns = createWebAppActiveRunRegistry();
  const pendingRunSetups = new Map<string, Promise<RivetWebAppStoredRun | undefined>>();
  const connections = new Set<WebSocket>();
  let draining = false;
  let disposed = false;

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Observability must never alter action or connection cleanup.
    }
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
    activeRuns.finish(runId, fallbackOwnerScope);
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
  const rejectRun = (socket: WebSocket, runId: string): void => {
    safeSend(socket, {
      type: 'run.rejected',
      runId,
      error: 'The web app action is unavailable.',
      code: 'run_unavailable',
    });
  };
  const remoteRunSubscriptions = createWebAppRemoteRunSubscriptions({
    coordinator,
    rejectRun,
    replay,
    reportError,
    store,
  });
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
      await remoteRunSubscriptions.attach(socket, snapshot, afterSequence);
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
    getActiveRunIds: () => [...activeRuns.keys()],
    leaseDurationMs,
    leaseId,
    leaseRenewIntervalMs,
    async onLeaseLost(runId, recoveredAsInterrupted) {
      const active = activeRuns.get(runId);
      if (!active) return;
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

      const runId = nanoid();
      if (!activeRuns.reserve(session.ownerScope, runId, maxActiveRunsPerScope)) {
        completeSetup(undefined);
        reject(socket, message.requestId, new Error('Too many active web app actions.'));
        return;
      }

      createdRunId = runId;
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
        activeRuns.release(session.ownerScope, runId);
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
      const activeRun: ActiveWebAppRun = { abortController, ownerScope: session.ownerScope };
      activeRuns.activate(runId, activeRun);
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
          storedValueStore: session.storedValueStore,
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
            (result) => {
              const callbacks = journal.getCallbacks(runId);
              if (callbacks) callbacks.result = result;
              return appendAndBroadcast(runId, {
                type: 'action.completed',
                requestId: message.requestId,
                runId,
                statePatch: result.statePatch,
                storagePatch: result.storagePatch,
              });
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
    drain() {
      draining = true;
      for (const socket of connections) safeSend(socket, { type: 'server.draining' });
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
      attachWebAppSocketSession(socket, {
        handshakeTimeoutMs,
        heartbeatIntervalMs,
        heartbeatTimeoutMs,
        maxMessageBytes,
        async onActionCancel(runId) {
          const run = await store.getRun(runId);
          if (!run || run.ownerScope !== session.ownerScope) {
            rejectRun(socket, runId);
          } else if (run.status !== 'running') {
            replay(socket, run, 0);
          } else {
            await cancelRun(socket, run);
          }
        },
        onActionStart: (message) => startAction(socket, session, message),
        onCleanup() {
          connections.delete(socket);
          for (const runId of journal.subscribedRunIds()) unsubscribe(socket, runId);
          remoteRunSubscriptions.closeSocket(socket);
        },
        onError: reportError,
        onInvalidMessage: (requestId, error) => reject(socket, requestId, error),
        async onRunResume(runId, lastSequence) {
          const run = await store.getRun(runId);
          if (!run || run.ownerScope !== session.ownerScope) {
            rejectRun(socket, runId);
          } else {
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
  return {
    type: 'action.failed',
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof RivetWebAppActionHttpError && error.code ? { code: error.code } : {}),
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

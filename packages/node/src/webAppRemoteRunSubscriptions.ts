import type WebSocket from 'ws';
import { isRivetWebAppRunTerminalEvent, type RivetWebAppRunEvent } from '@valerypopoff/rivet2-core';
import type { RivetWebAppRunCoordinator, RivetWebAppRunCoordinatorSubscription } from './webAppRunCoordinator.js';
import type { RivetWebAppRunStore, RivetWebAppStoredRun } from './webAppSocketGateway.js';
import { sendWebAppSocketMessage } from './webAppSocketProtocol.js';

type RemoteRunSubscription = {
  closed: boolean;
  coordinatorSubscription?: RivetWebAppRunCoordinatorSubscription;
  lastSequence: number;
  queue: Promise<void>;
};

export function createWebAppRemoteRunSubscriptions(options: {
  coordinator?: RivetWebAppRunCoordinator;
  rejectRun(socket: WebSocket, runId: string): void;
  replay(socket: WebSocket, run: RivetWebAppStoredRun, afterSequence: number): number;
  reportError(error: unknown): void;
  store: RivetWebAppRunStore;
}) {
  const subscriptions = new Map<WebSocket, Map<string, RemoteRunSubscription>>();

  const close = (socket: WebSocket, runId: string): void => {
    const socketSubscriptions = subscriptions.get(socket);
    const state = socketSubscriptions?.get(runId);
    if (!state || state.closed) return;
    state.closed = true;
    socketSubscriptions?.delete(runId);
    if (socketSubscriptions?.size === 0) subscriptions.delete(socket);
    void Promise.resolve(state.coordinatorSubscription?.dispose()).catch(options.reportError);
  };

  const settleUnavailable = async (socket: WebSocket, runId: string, state: RemoteRunSubscription): Promise<void> => {
    if (state.closed) return;
    const latest = await options.store.getRun(runId);
    if (latest && latest.status !== 'running') {
      state.lastSequence = options.replay(socket, latest, state.lastSequence);
    } else {
      options.rejectRun(socket, runId);
    }
    close(socket, runId);
  };

  return {
    async attach(socket: WebSocket, run: RivetWebAppStoredRun, afterSequence: number): Promise<void> {
      close(socket, run.runId);
      const state: RemoteRunSubscription = {
        closed: false,
        lastSequence: options.replay(socket, run, afterSequence),
        queue: Promise.resolve(),
      };
      const socketSubscriptions = subscriptions.get(socket) ?? new Map<string, RemoteRunSubscription>();
      socketSubscriptions.set(run.runId, state);
      subscriptions.set(socket, socketSubscriptions);
      if (!options.coordinator) {
        await settleUnavailable(socket, run.runId, state);
        return;
      }

      const enqueue = (operation: () => Promise<void> | void): void => {
        state.queue = state.queue.then(operation).catch((error) => {
          options.reportError(error);
          socket.close(1011, 'Run coordinator failed');
        });
      };
      const subscription = await options.coordinator.subscribe({
        hostId: run.hostId,
        ownerScope: run.ownerScope,
        runId: run.runId,
        onEvent(event) {
          enqueue(() => forwardEvent(socket, run, state, event));
        },
        onUnavailable() {
          enqueue(() => settleUnavailable(socket, run.runId, state));
        },
      });
      if (!subscription) {
        await settleUnavailable(socket, run.runId, state);
        return;
      }
      state.coordinatorSubscription = subscription;
      if (state.closed) {
        await subscription.dispose();
        return;
      }

      const latest = await options.store.getRun(run.runId);
      if (!latest || latest.ownerScope !== run.ownerScope || latest.hostId !== run.hostId) {
        await settleUnavailable(socket, run.runId, state);
        return;
      }
      state.lastSequence = options.replay(socket, latest, state.lastSequence);
      if (latest.status !== 'running') close(socket, run.runId);
    },
    closeSocket(socket: WebSocket): void {
      for (const runId of subscriptions.get(socket)?.keys() ?? []) close(socket, runId);
    },
    dispose(): void {
      for (const socket of subscriptions.keys()) {
        for (const runId of subscriptions.get(socket)?.keys() ?? []) close(socket, runId);
      }
    },
  };

  async function forwardEvent(
    socket: WebSocket,
    run: RivetWebAppStoredRun,
    state: RemoteRunSubscription,
    event: RivetWebAppRunEvent,
  ): Promise<void> {
    if (state.closed || event.runId !== run.runId || event.sequence <= state.lastSequence) return;
    if (event.sequence > state.lastSequence + 1) {
      const latest = await options.store.getRun(run.runId);
      if (!latest || latest.ownerScope !== run.ownerScope || latest.hostId !== run.hostId) {
        await settleUnavailable(socket, run.runId, state);
        return;
      }
      state.lastSequence = options.replay(socket, latest, state.lastSequence);
      if (latest.status !== 'running') {
        close(socket, run.runId);
        return;
      }
    }
    if (state.closed || event.sequence <= state.lastSequence) return;
    sendWebAppSocketMessage(socket, event);
    state.lastSequence = event.sequence;
    if (isRivetWebAppRunTerminalEvent(event)) close(socket, run.runId);
  }
}

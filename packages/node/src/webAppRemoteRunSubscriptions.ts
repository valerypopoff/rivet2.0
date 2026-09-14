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
  /**
   * Kept separate from a socket's transport state: an accepted browser-storage
   * action can keep the socket open after publication access is revoked, while
   * run results must stop immediately.
   */
  canDeliver(socket: WebSocket): boolean;
  coordinator?: RivetWebAppRunCoordinator;
  rejectRun(socket: WebSocket, runId: string): void;
  replay(socket: WebSocket, run: RivetWebAppStoredRun, afterSequence: number): number;
  reportError(error: unknown): void;
  store: RivetWebAppRunStore;
}) {
  const subscriptions = new Map<WebSocket, Map<string, RemoteRunSubscription>>();

  /**
   * A delayed callback belongs to one concrete attachment.  A later resume
   * can replace that attachment for the same socket and run ID, so cleanup
   * from the old callback must never remove the replacement.
   */
  const close = (socket: WebSocket, runId: string, expectedState?: RemoteRunSubscription): void => {
    const socketSubscriptions = subscriptions.get(socket);
    const state = socketSubscriptions?.get(runId);
    if (!state || state.closed || (expectedState && state !== expectedState)) return;
    state.closed = true;
    socketSubscriptions?.delete(runId);
    if (socketSubscriptions?.size === 0) subscriptions.delete(socket);
    void Promise.resolve(state.coordinatorSubscription?.dispose()).catch(options.reportError);
  };

  const settleUnavailable = async (socket: WebSocket, runId: string, state: RemoteRunSubscription): Promise<void> => {
    if (state.closed || !options.canDeliver(socket)) {
      close(socket, runId, state);
      return;
    }
    const latest = await options.store.getRun(runId);
    if (state.closed || !options.canDeliver(socket)) {
      close(socket, runId, state);
      return;
    }
    if (latest && latest.status !== 'running') {
      state.lastSequence = options.replay(socket, latest, state.lastSequence);
    } else {
      options.rejectRun(socket, runId);
    }
    close(socket, runId, state);
  };

  return {
    async attach(socket: WebSocket, run: RivetWebAppStoredRun, afterSequence: number): Promise<void> {
      close(socket, run.runId);
      if (!options.canDeliver(socket)) return;
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
          // Stop this exact attachment before closing its transport. Otherwise
          // a socket that takes time to finish closing can keep accepting
          // coordinator callbacks and retain the subscription indefinitely.
          close(socket, run.runId, state);
          // A revoked page may still need its socket to complete the
          // browser-storage exchange of an action it already started. An
          // unrelated delayed remote-read failure must not turn that narrow
          // exception into an early transport close. Before revocation this
          // remains a real coordinator failure and closes the connection.
          if (options.canDeliver(socket)) socket.close(1011, 'Run coordinator failed');
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
      if (state.closed || !options.canDeliver(socket)) {
        await subscription?.dispose();
        close(socket, run.runId, state);
        return;
      }
      if (!subscription) {
        await settleUnavailable(socket, run.runId, state);
        return;
      }
      state.coordinatorSubscription = subscription;
      if (state.closed || !options.canDeliver(socket)) {
        await subscription.dispose();
        close(socket, run.runId, state);
        return;
      }

      const latest = await options.store.getRun(run.runId);
      if (state.closed || !options.canDeliver(socket)) {
        close(socket, run.runId, state);
        return;
      }
      if (!latest || latest.ownerScope !== run.ownerScope || latest.hostId !== run.hostId) {
        await settleUnavailable(socket, run.runId, state);
        return;
      }
      state.lastSequence = options.replay(socket, latest, state.lastSequence);
      if (latest.status !== 'running') close(socket, run.runId, state);
    },
    closeSocket(socket: WebSocket): void {
      for (const runId of [...(subscriptions.get(socket)?.keys() ?? [])]) close(socket, runId);
    },
    dispose(): void {
      for (const socket of [...subscriptions.keys()]) {
        for (const runId of [...(subscriptions.get(socket)?.keys() ?? [])]) close(socket, runId);
      }
    },
  };

  async function forwardEvent(
    socket: WebSocket,
    run: RivetWebAppStoredRun,
    state: RemoteRunSubscription,
    event: RivetWebAppRunEvent,
  ): Promise<void> {
    if (state.closed || !options.canDeliver(socket) || event.runId !== run.runId || event.sequence <= state.lastSequence) {
      if (!options.canDeliver(socket)) close(socket, run.runId, state);
      return;
    }
    if (event.sequence > state.lastSequence + 1) {
      const latest = await options.store.getRun(run.runId);
      if (state.closed || !options.canDeliver(socket)) {
        close(socket, run.runId, state);
        return;
      }
      if (!latest || latest.ownerScope !== run.ownerScope || latest.hostId !== run.hostId) {
        await settleUnavailable(socket, run.runId, state);
        return;
      }
      state.lastSequence = options.replay(socket, latest, state.lastSequence);
      if (latest.status !== 'running') {
        close(socket, run.runId, state);
        return;
      }
    }
    if (state.closed || !options.canDeliver(socket) || event.sequence <= state.lastSequence) {
      if (!options.canDeliver(socket)) close(socket, run.runId, state);
      return;
    }
    sendWebAppSocketMessage(socket, event);
    state.lastSequence = event.sequence;
    if (isRivetWebAppRunTerminalEvent(event)) close(socket, run.runId, state);
  }
}

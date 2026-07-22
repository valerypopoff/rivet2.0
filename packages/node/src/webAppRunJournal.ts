import type WebSocket from 'ws';
import {
  isRivetWebAppRunTerminalEvent,
  type RivetWebAppRunEvent,
  type RivetWebAppServerMessage,
} from '@valerypopoff/rivet2-core';
import type { RivetWebAppActionContext, RivetWebAppActionResult } from './webAppHandler.js';
import type { RivetWebAppRunCoordinator } from './webAppRunCoordinator.js';
import type {
  RivetWebAppRunFailedContext,
  RivetWebAppRunStore,
  RivetWebAppSocketSession,
  RivetWebAppStoredRun,
  RivetWebAppUnsequencedRunEvent,
} from './webAppSocketGateway.js';
import { sendWebAppSocketMessage } from './webAppSocketProtocol.js';

export type TerminalRunCallbacks = {
  actionContext: RivetWebAppActionContext;
  error?: unknown;
  onRunFailed?: RivetWebAppSocketSession['onRunFailed'];
  onRunFinished?: RivetWebAppSocketSession['onRunFinished'];
  preparation?: Promise<void>;
  requestId: string;
  result?: RivetWebAppActionResult;
  runId: string;
};

export function createWebAppRunJournal(options: {
  coordinator?: RivetWebAppRunCoordinator;
  getRunOwnerScope(runId: string): string | undefined;
  hostId: string;
  leaseId: string;
  reportError(error: unknown): void;
  store: RivetWebAppRunStore;
}) {
  const appendChains = new Map<string, Promise<void>>();
  const subscribers = new Map<string, Set<WebSocket>>();
  const terminalCallbacks = new Map<string, TerminalRunCallbacks>();

  const broadcast = (event: RivetWebAppServerMessage): void => {
    if (!('runId' in event)) return;
    for (const socket of subscribers.get(event.runId) ?? []) sendWebAppSocketMessage(socket, event);
  };

  const publishCoordinatedEvent = async (
    run: { hostId: string; ownerScope: string; runId: string },
    event: RivetWebAppRunEvent,
  ): Promise<void> => {
    try {
      await options.coordinator?.publishEvent({ ...run, event });
    } catch (error) {
      options.reportError(error);
    }
  };

  const invokeTerminalCallbacks = async (callbacks: TerminalRunCallbacks, event: RivetWebAppRunEvent) => {
    try {
      if (event.type === 'action.completed') {
        if (!callbacks.result) {
          options.reportError(new Error(`Web app run "${callbacks.runId}" completed without an action result.`));
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
      options.reportError(error);
    }
  };

  const notifyTerminal = async (runId: string, event: RivetWebAppRunEvent): Promise<void> => {
    if (!isRivetWebAppRunTerminalEvent(event)) return;
    const callbacks = terminalCallbacks.get(runId);
    if (!callbacks) return;
    terminalCallbacks.delete(runId);
    if (callbacks.preparation) {
      void callbacks.preparation.then(() => invokeTerminalCallbacks(callbacks, event));
    } else {
      await invokeTerminalCallbacks(callbacks, event);
    }
  };

  return {
    append(
      runId: string,
      event: RivetWebAppUnsequencedRunEvent,
      appendOptions: { deferTerminalNotification?: boolean } = {},
    ): Promise<RivetWebAppRunEvent | undefined> {
      const operation = (appendChains.get(runId) ?? Promise.resolve()).then(async () => {
        const storedEvent = await options.store.appendEvent(runId, options.leaseId, event);
        if (!storedEvent) return undefined;

        broadcast(storedEvent);
        const ownerScope = options.getRunOwnerScope(runId);
        if (ownerScope) await publishCoordinatedEvent({ hostId: options.hostId, ownerScope, runId }, storedEvent);
        if (isRivetWebAppRunTerminalEvent(storedEvent)) {
          if (!appendOptions.deferTerminalNotification) {
            await notifyTerminal(runId, storedEvent);
          }
          subscribers.delete(runId);
        }
        return storedEvent;
      });
      const tail = operation.then(
        () => undefined,
        () => undefined,
      );
      appendChains.set(runId, tail);
      void tail.then(() => {
        if (appendChains.get(runId) === tail) appendChains.delete(runId);
      });
      return operation;
    },
    broadcast,
    clearSubscribers(): void {
      subscribers.clear();
    },
    deleteCallbacks(runId: string): void {
      terminalCallbacks.delete(runId);
    },
    getCallbacks(runId: string): TerminalRunCallbacks | undefined {
      return terminalCallbacks.get(runId);
    },
    notifyTerminal,
    pendingWrites(): Promise<void>[] {
      return [...appendChains.values()];
    },
    async publishInterruptedRuns(runs: RivetWebAppStoredRun[]): Promise<void> {
      for (const run of runs) {
        const terminalEvent = run.events.at(-1);
        if (!terminalEvent || !isRivetWebAppRunTerminalEvent(terminalEvent)) continue;
        broadcast(terminalEvent);
        await notifyTerminal(run.runId, terminalEvent);
        subscribers.delete(run.runId);
        await publishCoordinatedEvent(
          { hostId: run.hostId, ownerScope: run.ownerScope, runId: run.runId },
          terminalEvent,
        );
      }
    },
    rejectSubscribers(runId: string, reject: (socket: WebSocket) => void): void {
      for (const socket of subscribers.get(runId) ?? []) reject(socket);
      subscribers.delete(runId);
    },
    setCallbacks(runId: string, callbacks: TerminalRunCallbacks): void {
      terminalCallbacks.set(runId, callbacks);
    },
    subscribe(socket: WebSocket, runId: string): void {
      const runSubscribers = subscribers.get(runId) ?? new Set<WebSocket>();
      runSubscribers.add(socket);
      subscribers.set(runId, runSubscribers);
    },
    subscribedRunIds(): IterableIterator<string> {
      return subscribers.keys();
    },
    unsubscribe(socket: WebSocket, runId: string): void {
      const runSubscribers = subscribers.get(runId);
      runSubscribers?.delete(socket);
      if (runSubscribers?.size === 0) subscribers.delete(runId);
    },
  };
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

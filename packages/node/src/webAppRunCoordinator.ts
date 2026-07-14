import type { RivetWebAppRunEvent } from '@valerypopoff/rivet2-core';

export type RivetWebAppCoordinatedRun = {
  hostId: string;
  ownerScope: string;
  runId: string;
};

export type RivetWebAppRunCoordinatorSubscription = {
  dispose(): Promise<void> | void;
};

export type RivetWebAppRunCoordinator = {
  /** Routes cancellation to the process currently identified by run.hostId. */
  cancelRun(run: RivetWebAppCoordinatedRun): Promise<boolean>;
  /**
   * Publishes a persisted event to remote subscribers. Recovery workers may
   * publish for the original host after its ownership lease expires.
   */
  publishEvent(run: RivetWebAppCoordinatedRun & { event: RivetWebAppRunEvent }): Promise<void> | void;
  /** Registers the cancellation endpoint for one live gateway process. */
  registerHost(
    hostId: string,
    handlers: {
      cancelRun(run: Omit<RivetWebAppCoordinatedRun, 'hostId'>): Promise<boolean>;
    },
  ): () => void;
  /**
   * Activates the subscription before resolving. Delivery may be at-least-once;
   * the gateway de-duplicates events by their durable sequence number.
   * onUnavailable is reserved for a definitive routing failure, not a transient
   * broker disconnect or an owner whose lease is awaiting recovery.
   */
  subscribe(
    run: RivetWebAppCoordinatedRun & {
      onEvent(event: RivetWebAppRunEvent): void;
      onUnavailable(): void;
    },
  ): Promise<RivetWebAppRunCoordinatorSubscription | undefined>;
};

type InMemorySubscription = {
  hostId: string;
  onEvent(event: RivetWebAppRunEvent): void;
  onUnavailable(): void;
  ownerScope: string;
};

/**
 * Process-local reference coordinator for tests and multi-gateway local hosts.
 * Production replicas should implement the same contract over their message bus.
 */
export function createInMemoryRivetWebAppRunCoordinator(): RivetWebAppRunCoordinator {
  const hosts = new Map<string, { cancelRun(run: Omit<RivetWebAppCoordinatedRun, 'hostId'>): Promise<boolean> }>();
  const subscriptions = new Map<string, Set<InMemorySubscription>>();

  return {
    async cancelRun(run) {
      return (await hosts.get(run.hostId)?.cancelRun(run)) ?? false;
    },
    publishEvent({ event, hostId, ownerScope, runId }) {
      for (const subscription of subscriptions.get(runId) ?? []) {
        if (subscription.hostId === hostId && subscription.ownerScope === ownerScope) {
          subscription.onEvent(event);
        }
      }
    },
    registerHost(hostId, handlers) {
      if (hosts.has(hostId)) throw new Error(`Web app action coordinator host "${hostId}" is already registered.`);
      hosts.set(hostId, handlers);
      return () => {
        if (hosts.get(hostId) !== handlers) return;
        hosts.delete(hostId);
      };
    },
    async subscribe({ hostId, onEvent, onUnavailable, ownerScope, runId }) {
      const subscription = { hostId, onEvent, onUnavailable, ownerScope };
      const runSubscriptions = subscriptions.get(runId) ?? new Set<InMemorySubscription>();
      runSubscriptions.add(subscription);
      subscriptions.set(runId, runSubscriptions);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          runSubscriptions.delete(subscription);
          if (runSubscriptions.size === 0) subscriptions.delete(runId);
        },
      };
    },
  };
}

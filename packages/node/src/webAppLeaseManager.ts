import type { RivetWebAppRunStore, RivetWebAppStoredRun } from './webAppSocketGateway.js';

export function createWebAppLeaseManager(options: {
  getActiveRunIds(): string[];
  leaseDurationMs: number;
  leaseId: string;
  leaseRenewIntervalMs: number;
  onLeaseLost(runId: string, recoveredAsInterrupted: boolean): Promise<void> | void;
  recoverExpiredRuns(error: string): Promise<RivetWebAppStoredRun[]>;
  reportError(error: unknown): void;
  store: RivetWebAppRunStore;
}) {
  let disposed = false;
  let maintenance: Promise<void> | undefined;

  const maintain = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (maintenance) return maintenance;

    const operation = (async () => {
      const expectedRunIds = options.getActiveRunIds();
      try {
        const renewedRunIds = new Set(
          await options.store.renewRunLeases(options.leaseId, expectedRunIds, options.leaseDurationMs),
        );
        if (disposed) return;

        const interruptedRuns = await options.recoverExpiredRuns(
          'Web app action owner lease expired before completion.',
        );
        if (disposed) return;

        const interruptedRunIds = new Set(interruptedRuns.map((run) => run.runId));
        for (const runId of expectedRunIds) {
          if (!renewedRunIds.has(runId)) await options.onLeaseLost(runId, interruptedRunIds.has(runId));
        }
      } catch (error) {
        if (!disposed) options.reportError(error);
      }
    })();
    const pending = operation.finally(() => {
      if (maintenance === pending) maintenance = undefined;
    });
    maintenance = pending;
    return pending;
  };

  const timer = setInterval(() => void maintain(), options.leaseRenewIntervalMs);
  timer.unref?.();
  void maintain();

  return {
    async dispose(): Promise<void> {
      disposed = true;
      clearInterval(timer);
      await maintenance;
    },
    maintain,
  };
}

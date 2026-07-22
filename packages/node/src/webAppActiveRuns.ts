import type { prepareRivetWebAppAction } from './webAppHandler.js';

export type ActiveWebAppRun = {
  abortController: AbortController;
  durableLeaseActive: boolean;
  interruptionError?: string;
  ownerScope: string;
  processor?: Awaited<ReturnType<typeof prepareRivetWebAppAction>>['processor'];
};

export function createWebAppActiveRunRegistry() {
  const activeRuns = new Map<string, ActiveWebAppRun>();
  const ownerScopeByRunId = new Map<string, string>();
  const runsByScope = new Map<string, Set<string>>();
  const release = (ownerScope: string, runId: string): void => {
    ownerScopeByRunId.delete(runId);
    const scopeRuns = runsByScope.get(ownerScope);
    scopeRuns?.delete(runId);
    if (scopeRuns?.size === 0) runsByScope.delete(ownerScope);
  };

  return {
    activate(runId: string, run: ActiveWebAppRun): void {
      activeRuns.set(runId, run);
    },
    entries(): IterableIterator<[string, ActiveWebAppRun]> {
      return activeRuns.entries();
    },
    finish(runId: string, fallbackOwnerScope?: string): ActiveWebAppRun | undefined {
      const activeRun = activeRuns.get(runId);
      activeRuns.delete(runId);
      const ownerScope = activeRun?.ownerScope ?? fallbackOwnerScope;
      if (ownerScope) release(ownerScope, runId);
      return activeRun;
    },
    get(runId: string): ActiveWebAppRun | undefined {
      return activeRuns.get(runId);
    },
    getOwnerScope(runId: string): string | undefined {
      return activeRuns.get(runId)?.ownerScope ?? ownerScopeByRunId.get(runId);
    },
    has(runId: string): boolean {
      return activeRuns.has(runId);
    },
    leaseManagedRunIds(): string[] {
      return [...activeRuns].flatMap(([runId, run]) => (run.durableLeaseActive ? [runId] : []));
    },
    release,
    reserve(ownerScope: string, runId: string, maxRuns: number): boolean {
      const scopeRuns = runsByScope.get(ownerScope) ?? new Set<string>();
      if (scopeRuns.size >= maxRuns) return false;
      scopeRuns.add(runId);
      runsByScope.set(ownerScope, scopeRuns);
      ownerScopeByRunId.set(runId, ownerScope);
      return true;
    },
    size(): number {
      return activeRuns.size;
    },
  };
}

import { WorkspaceRecoveryDataError, type WorkspaceRecoveryStorage } from './workspaceRecovery.js';

const RETRY_DELAYS = [250, 1_000, 2_500, 30_000];

/** Retry the current in-memory workspace, never an old failed write's snapshot.
 * One bounded loop handles both checkpoint and reload-reference failures. */
export function startWorkspaceRecoveryRetry(
  recovery: WorkspaceRecoveryStorage,
  retry: () => Promise<void>,
  onPersistentFailure: (failed: boolean) => void,
  timers = {
    schedule: (callback: () => void, delay: number) => setTimeout(callback, delay),
    cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  },
): { retryNow: () => void; stop: () => void } {
  let stopped = false;
  let running = false;
  let problem = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelTimer = () => {
    if (timer !== undefined) timers.cancel(timer);
    timer = undefined;
  };
  const reset = () => {
    cancelTimer();
    problem = false;
    failures = 0;
    onPersistentFailure(false);
  };
  const canRetry = () => !stopped && !recovery.retired && recovery.persistsAcrossReload;
  const update = () => {
    if (!canRetry()) {
      cancelTimer();
      return;
    }
    const health = recovery.getHealth();
    if (health.status === 'saved' && health.reloadAvailable) {
      reset();
      return;
    }
    if (health.status === 'unavailable' || !health.reloadAvailable) problem = true;
    if (problem && !running && timer === undefined) {
      timer = timers.schedule(
        () => {
          timer = undefined;
          void attempt();
        },
        RETRY_DELAYS[Math.min(failures, RETRY_DELAYS.length - 1)]!,
      );
    }
  };
  const attempt = async () => {
    if (!canRetry() || running || !problem) return;
    cancelTimer();
    running = true;
    try {
      await retry();
    } catch {
      // Explicit flushes still reject. Automatic attempts are handled here,
      // with one actionable warning rather than repeated error toasts.
    } finally {
      running = false;
      if (canRetry()) {
        const health = recovery.getHealth();
        if (health.status !== 'unavailable' && health.reloadAvailable) reset();
        else {
          failures++;
          onPersistentFailure(failures >= 3);
        }
        update();
      }
    }
  };
  const unsubscribe = recovery.subscribe(update);
  update();
  return {
    retryNow: () => void attempt(),
    stop: () => {
      stopped = true;
      cancelTimer();
      unsubscribe();
    },
  };
}

/** Bootstrap has no live editor to overwrite: retry transient IO, but never
 * reinterpret corrupt or missing authoritative data as an empty workspace. */
export async function retryWorkspaceInitialization(
  initialize: () => Promise<void>,
  isCurrent: () => boolean,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  for (let attempt = 0; isCurrent(); attempt++) {
    try {
      await initialize();
      return;
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof WorkspaceRecoveryDataError || attempt >= 2) throw error;
      await wait(RETRY_DELAYS[attempt]!);
    }
  }
}

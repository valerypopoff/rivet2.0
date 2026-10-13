import type { RuntimeLibraryJobState } from '../../../studio-server-shared/runtime-library-types.js';

export type RuntimeLibraryJobObserver = {
  state(job: RuntimeLibraryJobState | null): void;
  error(error: unknown): void;
};

/** Observation lifetime is independent of the durable job being observed. */
export function pollRuntimeLibraryJob(
  jobId: string,
  getJob: (id: string) => Promise<RuntimeLibraryJobState | null>,
  observer: RuntimeLibraryJobObserver,
): () => void {
  let closed = false,
    polling = false;
  const timer = setInterval(() => {
    if (closed || polling) return;
    polling = true;
    void (async () => {
      try {
        const job = await getJob(jobId);
        if (!closed) observer.state(job);
      } catch (error) {
        if (!closed) {
          try {
            observer.error(error);
          } catch {
            // A broken observer cannot leak an unhandled rejection or affect
            // the durable job. Stop only this observation.
            closed = true;
            clearInterval(timer);
          }
        }
      } finally {
        polling = false;
      }
    })();
  }, 1_000);
  timer.unref();
  return () => {
    closed = true;
    clearInterval(timer);
  };
}

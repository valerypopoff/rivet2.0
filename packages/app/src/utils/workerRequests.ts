import { getError } from '@valerypopoff/rivet2-core';
import { nanoid } from 'nanoid';

export type WorkerRequestOptions = { signal?: AbortSignal; timeoutMs?: number };

/** Request lifetimes only. Worker-specific parsing stays in the host adapter.
 * Failed requests are settled once and never replayed into a replacement. */
export function createWorkerRequests(createWorker: () => Worker) {
  type Request = { responseType: string; resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
  const waiting = new Map<string, Request>();
  let worker: Worker | undefined;
  let hasCancelledWork = false;

  const retire = (failedWorker: Worker, error: unknown) => {
    if (worker !== failedWorker) return;
    worker = undefined;
    hasCancelledWork = false;
    const pending = [...waiting.values()];
    waiting.clear();
    try {
      failedWorker.terminate();
    } catch {
      /* Retired identity cannot deliver another result. */
    }
    for (const request of pending) {
      request.cleanup();
      request.reject(getError(error));
    }
  };

  const getWorker = () => {
    if (worker) return worker;
    const next = createWorker();
    worker = next;
    next.addEventListener('error', (event) =>
      retire(next, new Error(event.message || 'Project deserialize worker failed')),
    );
    next.addEventListener('messageerror', () =>
      retire(next, new Error('Project deserialize worker returned an unreadable message')),
    );
    next.addEventListener('message', (event) => {
      if (worker !== next) return;
      const { id, type, result, error } = event.data ?? {};
      const request = waiting.get(id);
      if (!request || request.responseType !== type) return;
      waiting.delete(id);
      request.cleanup();
      if (error) request.reject(getError(error));
      else request.resolve(result);
      // A cancelled parse may still be queued behind the request that just
      // finished. Retire that generation once no accepted work depends on it.
      if (waiting.size === 0 && hasCancelledWork) retire(next, new Error('Project load cancelled'));
    });
    return next;
  };

  return function request<T>(type: string, data: unknown, options: WorkerRequestOptions = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    return new Promise<T>((resolve, reject) => {
      const current = getWorker();
      const id = nanoid();
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        if (!waiting.delete(id)) return;
        hasCancelledWork = true;
        cleanup();
        reject(getError(options.signal?.reason ?? new DOMException('Project load cancelled', 'AbortError')));
        // Synchronous parsing cannot be interrupted per request. Retire it only
        // when no other accepted request still owns this worker.
        if (waiting.size === 0) retire(current, new Error('Project load cancelled'));
      };
      waiting.set(id, { responseType: `${type}:result`, resolve: (value) => resolve(value as T), reject, cleanup });
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => retire(current, new Error('Project parsing timed out. Please retry.')),
        options.timeoutMs ?? 60_000,
      );
      try {
        current.postMessage({ id, type, data });
      } catch (error) {
        waiting.delete(id);
        cleanup();
        reject(getError(error));
      }
    });
  };
}

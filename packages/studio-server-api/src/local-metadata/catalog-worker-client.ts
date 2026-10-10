import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { serialize } from 'node:v8';
import { performance } from 'node:perf_hooks';
import { recordStudioMetrics } from '../metrics.js';
import type { LocalWorkflowCatalog } from './workflow-catalog.js';

export type AsyncLocalWorkflowCatalog = {
  [K in keyof LocalWorkflowCatalog]: LocalWorkflowCatalog[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};
export type CatalogWorkerClient = AsyncLocalWorkflowCatalog & {
  /** Cancellation only removes work that has not been dispatched. */
  withSignal(signal: AbortSignal): AsyncLocalWorkflowCatalog;
  getPendingOperationCount(): number;
  waitForIdle(signal?: AbortSignal): Promise<void>;
};
type Job = {
  id: number;
  method: string;
  args: Buffer;
  bytes: number;
  admittedAt: number;
  dispatchedAt?: number;
  resolve(value: any): void;
  reject(error: unknown): void;
  cancel?: () => void;
};

/** One connection owner per serving catalog. No generic SQL or callbacks cross
 * the boundary; complete catalog operations retain their transaction semantics. */
export function createCatalogWorker(
  options: { databasePath: string; artifactRoot: string },
  createWorker: (
    entry: ConstructorParameters<typeof Worker>[0],
    options: ConstructorParameters<typeof Worker>[1],
  ) => Worker = (entry, options) => new Worker(entry, options),
): CatalogWorkerClient {
  // Bind this owner to its selected generation even before lazy worker startup.
  options = { ...options };
  let worker: Worker | undefined;
  let workerExited = false;
  let sequence = 0;
  let bytes = 0;
  let failed: Error | undefined;
  let stopped: Promise<unknown> = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const jobs = new Map<number, Job>();
  const queue: Job[] = [];
  const idleWaiters = new Set<() => void>();
  const notifyIdle = () => {
    if (!jobs.size) for (const ready of [...idleWaiters]) ready();
  };
  let active: Job | undefined;
  let startedAt: number | undefined;
  let observedState = { pending: 0, active: 0, reservedBytes: 0, workers: 0 };
  const observeState = () => {
    const next = { pending: jobs.size, active: active ? 1 : 0, reservedBytes: bytes, workers: worker ? 1 : 0 };
    recordStudioMetrics((metrics) =>
      metrics.adjustCatalogState({
        pending: next.pending - observedState.pending,
        active: next.active - observedState.active,
        reservedBytes: next.reservedBytes - observedState.reservedBytes,
        workers: next.workers - observedState.workers,
      }),
    );
    observedState = next;
  };
  const terminateOwner = (owner: Worker | undefined): Promise<unknown> => {
    if (!owner) return Promise.resolve();
    owner.removeAllListeners();
    if (workerExited) return Promise.resolve();
    const ignoreError = () => {};
    // A rejected termination request is not proof that SQL has stopped. Keep
    // leases/reservations until the worker's exit is independently confirmed.
    const exited = new Promise<void>((resolve) => {
      owner.once('exit', () => {
        workerExited = true;
        resolve();
      });
    });
    // Further worker errors during shutdown must not become uncaught exceptions.
    owner.on('error', ignoreError);
    return Promise.resolve()
      .then(() => owner.terminate())
      .catch(async (error) => {
        await exited;
        throw error;
      })
      .finally(() => {
        owner.removeAllListeners();
      });
  };
  const fail = (error: Error) => {
    if (failed) return;
    recordStudioMetrics((metrics) => metrics.recordCatalogEvent('failed'));
    failed = Object.assign(
      new Error(
        'Local storage worker unavailable; operation outcome may be unknown. Reload durable state before retrying.',
        {
          cause: error,
        },
      ),
      { code: 'local_storage_worker_unavailable', status: 503 },
    );
    const pending = [...jobs.values()];
    for (const job of pending) job.cancel?.();
    queue.length = 0;
    active = undefined;
    const lostWorker = worker;
    worker = undefined;
    stopped = terminateOwner(lostWorker);
    // A parent's write lease must outlive the failed worker: rejecting before
    // termination could let maintenance drain while SQL is still running.
    void stopped
      .catch(() => undefined)
      .then(() => {
        for (const job of pending) {
          jobs.delete(job.id);
          bytes -= job.bytes;
          job.reject(failed!);
        }
        observeState();
        notifyIdle();
      });
  };
  const dispatch = () => {
    if (active || failed || !worker) return;
    const job = queue.shift();
    if (!job) {
      worker.unref();
      return;
    }
    active = job;
    job.dispatchedAt = performance.now();
    recordStudioMetrics((metrics) => metrics.observeCatalogOperation('queue', job.dispatchedAt! - job.admittedAt));
    observeState();
    job.cancel?.();
    worker.ref();
    try {
      worker.postMessage({ id: job.id, method: job.method, args: job.args });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const start = () => {
    if (worker || failed) return;
    startedAt = performance.now();
    const entry = new URL('./catalog-worker.js', import.meta.url);
    worker = import.meta.url.endsWith('.ts')
      ? createWorker("require('tsx/cjs'); require(require('node:worker_threads').workerData.entry)", {
          eval: true,
          workerData: { options, entry: fileURLToPath(new URL('./catalog-worker.ts', import.meta.url)) },
        })
      : createWorker(entry, { workerData: { options } });
    recordStudioMetrics((metrics) => metrics.recordCatalogEvent('started'));
    observeState();
    worker.on(
      'message',
      (message: {
        id: number;
        value?: unknown;
        error?: { message: string; name: string; properties: Record<string, unknown> };
      }) => {
        const job = jobs.get(message.id);
        if (!job || job !== active) return fail(new Error('Invalid local storage worker response.'));
        const complete = (terminationError?: unknown) => {
          recordStudioMetrics((metrics) => {
            metrics.observeCatalogOperation(
              job.method === 'close' ? 'shutdown' : 'dispatched',
              performance.now() - job.dispatchedAt!,
            );
            if (startedAt != null) metrics.observeCatalogOperation('startup', performance.now() - startedAt);
            if (message.error || terminationError) metrics.recordCatalogEvent('operation_failed');
            if (job.method === 'close') metrics.recordCatalogEvent('closed');
          });
          startedAt = undefined;
          jobs.delete(job.id);
          bytes -= job.bytes;
          active = undefined;
          observeState();
          if (message.error)
            job.reject(
              Object.assign(new Error(message.error.message), message.error.properties, { name: message.error.name }),
            );
          else if (terminationError) job.reject(terminationError);
          else job.resolve(message.value);
          notifyIdle();
        };
        if (job.method === 'close') {
          const closing = worker!;
          worker = undefined;
          stopped = terminateOwner(closing);
          // Close still owns a pending operation until termination is acknowledged,
          // even if the SQL close RPC itself succeeded (or returned an error).
          void stopped.then(() => complete(), complete);
        } else {
          complete();
          dispatch();
        }
      },
    );
    worker.on('error', fail);
    worker.on('exit', (code) => {
      workerExited = true;
      fail(new Error(`Local storage worker exited (${code}).`));
    });
    worker.unref();
  };
  const busy = () =>
    Object.assign(new Error('Local storage queue is full; retry later.'), {
      status: 503,
      code: 'local_storage_busy',
    });
  const call = (method: string, args: unknown[], signal?: AbortSignal) => {
    if (failed) return Promise.reject(failed);
    if (closing && method !== 'close') return Promise.reject(new Error('Local storage worker is closing.'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    // Reject a full queue before making another potentially large argument copy.
    if (method !== 'close' && jobs.size >= 64) {
      recordStudioMetrics((metrics) => metrics.recordCatalogEvent('count_rejected'));
      return Promise.reject(busy());
    }
    let encoded: Buffer;
    try {
      encoded = serialize(args);
    } catch (error) {
      return Promise.reject(error);
    }
    const weight = encoded.byteLength;
    if (method !== 'close' && bytes + weight > 128 * 1024 * 1024) {
      recordStudioMetrics((metrics) => metrics.recordCatalogEvent('bytes_rejected'));
      return Promise.reject(busy());
    }
    try {
      start();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return Promise.reject(failed);
    }
    return new Promise<any>((resolve, reject) => {
      // Snapshot at admission, not eventual dispatch: caller mutations must not
      // change an operation already waiting behind another SQL command.
      const job: Job = {
        id: sequence++,
        method,
        args: encoded,
        bytes: weight,
        admittedAt: performance.now(),
        resolve,
        reject,
      };
      if (signal) {
        const aborted = () => {
          // The listener is removed at dispatch. Never report cancellation for
          // a write whose transaction may already be running or committed.
          if (!jobs.delete(job.id)) return;
          queue.splice(queue.indexOf(job), 1);
          bytes -= job.bytes;
          job.cancel?.();
          observeState();
          recordStudioMetrics((metrics) => metrics.recordCatalogEvent('cancelled_before_dispatch'));
          reject(signal.reason);
          notifyIdle();
        };
        signal.addEventListener('abort', aborted, { once: true });
        job.cancel = () => signal.removeEventListener('abort', aborted);
      }
      jobs.set(job.id, job);
      queue.push(job);
      bytes += weight;
      observeState();
      dispatch();
    });
  };
  const proxy = (signal?: AbortSignal): CatalogWorkerClient =>
    new Proxy({} as CatalogWorkerClient, {
      get(_target, property) {
        if (property === 'then') return undefined;
        if (property === 'withSignal') return proxy;
        if (property === 'getPendingOperationCount') return () => jobs.size;
        if (property === 'waitForIdle')
          return async (signal?: AbortSignal) => {
            signal?.throwIfAborted();
            if (!jobs.size) return;
            await new Promise<void>((resolve, reject) => {
              const cleanup = () => {
                idleWaiters.delete(ready);
                signal?.removeEventListener('abort', aborted);
              };
              const ready = () => {
                cleanup();
                resolve();
              };
              const aborted = () => {
                cleanup();
                reject(signal!.reason);
              };
              idleWaiters.add(ready);
              signal?.addEventListener('abort', aborted, { once: true });
              if (signal?.aborted) aborted();
            });
          };
        if (property === 'close')
          return () => {
            if (!closePromise) {
              closing = true;
              closePromise = failed
                ? stopped.then(() => undefined)
                : !worker && jobs.size === 0
                  ? Promise.resolve()
                  : call('close', []).then(() => undefined);
            }
            return closePromise;
          };
        if (property === 'mutatePublication')
          return async (
            relativePath: string,
            update: Parameters<LocalWorkflowCatalog['mutatePublication']>[1],
            draft = false,
          ) => {
            const prepared = await call('preparePublication', [relativePath, draft], signal);
            if (!prepared) return null;
            update(prepared.next, prepared.index.revisionId);
            return call('commitPublication', [relativePath, prepared], signal);
          };
        if (property === 'readExecutionSource')
          return (selection: unknown, cache: unknown) => call(String(property), [selection, Boolean(cache)], signal);
        return (...args: unknown[]) => call(String(property), args, signal);
      },
    });
  return proxy();
}

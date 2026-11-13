import { Worker } from 'node:worker_threads';
import { deserialize, serialize } from 'node:v8';
import {
  prototypeFailure,
  type PrototypeDefinition,
  type PrototypeEvent,
  type PrototypeRequest,
  type PrototypeResult,
  type WorkerMessage,
} from './protocol.js';

type Job = {
  id: number;
  request: PrototypeRequest;
  bytes: number;
  resolve(result: PrototypeResult): void;
  reject(error: Error): void;
  event?: (event: PrototypeEvent) => void;
  eventFailure?: Error;
  cleanup(): void;
  settled: boolean;
};
type Slot = {
  worker: Worker;
  ready: boolean;
  retiring: boolean;
  job?: Job;
  startup: Promise<void>;
  started(): void;
  failed(error: Error): void;
  exited: Promise<void>;
};

export class PrototypeCapacityError extends Error {}

type PoolOptions = {
  size: number;
  lifecycle: 'reuse' | 'retire';
  maxQueued?: number;
  maxQueuedBytes?: number;
};

/** Gate A only: fixed immutable fixture per pool, no production routes or owners.
 * Bounds include warming/terminating threads; cancelled business work is never replayed. */
export class PrototypePool {
  readonly #slots = new Set<Slot>();
  readonly #queue: Job[] = [];
  #bytes = 0;
  #nextId = 0;
  #closed = false;
  #startupFailure?: Error;
  #created = 0;
  readonly #definition: PrototypeDefinition;
  readonly #options: Required<PoolOptions>;

  constructor(definition: PrototypeDefinition, options: PoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1 || options.size > 8)
      throw new Error('Prototype thread count must be 1..8.');
    if (options.lifecycle !== 'reuse' && options.lifecycle !== 'retire')
      throw new Error('Invalid prototype lifecycle.');
    this.#options = {
      size: options.size,
      lifecycle: options.lifecycle,
      maxQueued: options.maxQueued ?? 16,
      maxQueuedBytes: options.maxQueuedBytes ?? 2 * 1024 * 1024,
    };
    for (const value of [this.#options.maxQueued, this.#options.maxQueuedBytes]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error('Prototype queue bounds must be positive integers.');
    }
    const encoded = serialize(definition);
    if (encoded.byteLength > 8 * 1024 * 1024) throw new Error('Prototype definition exceeds 8 MiB.');
    // Replacements must receive the same fixture, even if its caller later edits it.
    this.#definition = deserialize(encoded) as PrototypeDefinition;
    this.#fill();
  }

  get stats() {
    return {
      workers: this.#slots.size,
      created: this.#created,
      warming: [...this.#slots].filter((slot) => !slot.ready && !slot.retiring).length,
      active: [...this.#slots].filter((slot) => slot.job).length,
      retiring: [...this.#slots].filter((slot) => slot.retiring).length,
      queued: this.#queue.length,
      queuedBytes: this.#bytes,
    };
  }

  async prepare(): Promise<void> {
    do {
      if (this.#closed) throw new Error('Prototype pool is closed.');
      if (this.#startupFailure) throw this.#startupFailure;
      await Promise.all([...this.#slots].map((slot) => (slot.retiring ? slot.exited : slot.startup)));
    } while ([...this.#slots].some((slot) => !slot.ready || slot.retiring));
    if (this.#closed) throw new Error('Prototype pool closed during preparation.');
    if (this.#startupFailure) throw this.#startupFailure;
  }

  run(
    request: PrototypeRequest,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      retainedBytes?: number;
      onEvent?: (event: PrototypeEvent) => void;
    } = {},
  ): Promise<PrototypeResult> {
    if (this.#closed) return Promise.reject(new Error('Prototype pool is closed.'));
    if (this.#startupFailure) return Promise.reject(this.#startupFailure);
    if (options.signal?.aborted) return Promise.reject(this.#abortError());
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
      return Promise.reject(new Error('Invalid prototype root deadline.'));
    let bytes: number;
    try {
      bytes = options.retainedBytes ?? serialize(request).byteLength;
    } catch (error) {
      return Promise.reject(error);
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(new Error('Invalid retained-byte estimate.'));
    if (this.#queue.length >= this.#options.maxQueued || this.#bytes + bytes > this.#options.maxQueuedBytes)
      return Promise.reject(new PrototypeCapacityError('Prototype queue capacity exceeded.'));
    return new Promise((resolve, reject) => {
      const abort = () => this.#abort(job, this.#abortError());
      const timeout = setTimeout(() => this.#abort(job, new Error('Prototype root deadline exceeded.')), timeoutMs);
      const job: Job = {
        id: ++this.#nextId,
        request,
        bytes,
        resolve,
        reject,
        event: options.onEvent,
        settled: false,
        cleanup: () => {
          clearTimeout(timeout);
          options.signal?.removeEventListener('abort', abort);
        },
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      this.#queue.push(job);
      this.#bytes += bytes;
      if (options.signal?.aborted) abort();
      this.#dispatch();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#queue.splice(0)) this.#reject(job, new Error('Prototype pool closed.'));
    this.#bytes = 0;
    const slots = [...this.#slots];
    for (const slot of slots) this.#retire(slot, new Error('Prototype pool closed.'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(slots.map((slot) => slot.exited)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Prototype thread exit was not confirmed.')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #fill(): void {
    while (!this.#closed && !this.#startupFailure && this.#slots.size < this.#options.size) {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: this.#definition });
      } catch (error) {
        // Retain ownership of any threads already created so close() can reap them.
        this.#stopAdmissions(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let started!: () => void, failed!: (error: Error) => void, exited!: () => void;
      const startup = new Promise<void>((resolve, reject) => {
        started = resolve;
        failed = reject;
      });
      void startup.catch(() => undefined);
      const slot: Slot = {
        worker,
        ready: false,
        retiring: false,
        startup,
        started,
        failed,
        exited: new Promise((resolve) => {
          exited = resolve;
        }),
      };
      this.#created++;
      this.#slots.add(slot);
      const deadline = setTimeout(
        () => this.#fail(slot, new Error('Prototype worker startup exceeded 30 seconds.')),
        30_000,
      );
      worker.on('message', (message: WorkerMessage) => {
        if (slot.retiring || this.#closed) return;
        if (message.kind === 'ready') {
          clearTimeout(deadline);
          slot.ready = true;
          slot.started();
          worker.unref();
          this.#dispatch();
          return;
        }
        const job = slot.job;
        if (!job || job.settled || job.id !== message.id) return;
        if (message.kind === 'event') {
          try {
            job.event?.(message.event);
          } catch (error) {
            // Failed foreground delivery/observation does not cancel accepted work.
            job.eventFailure = error instanceof Error ? error : new Error(String(error));
            job.event = undefined;
          }
          return;
        }
        if (message.kind === 'fatal') {
          this.#retire(slot, new Error(message.error.message));
          return;
        }
        job.settled = true;
        job.cleanup();
        slot.job = undefined;
        job.resolve(
          job.eventFailure && !message.result.failure
            ? { ...message.result, failure: prototypeFailure(job.eventFailure) }
            : message.result,
        );
        if (this.#options.lifecycle === 'retire') this.#retire(slot);
        else {
          worker.unref();
          this.#dispatch();
        }
      });
      worker.once('error', (error) => this.#fail(slot, error));
      worker.once('exit', (code) => {
        clearTimeout(deadline);
        if (!slot.ready) slot.failed(new Error(`Prototype worker exited during startup (${code}).`));
        if (slot.job)
          this.#reject(slot.job, new Error(`Prototype worker exited (${code}); execution was not replayed.`));
        this.#slots.delete(slot);
        exited();
        if (!slot.retiring) this.#stopAdmissions(new Error(`Unexpected prototype worker exit (${code}).`));
        this.#fill();
        this.#dispatch();
      });
    }
  }

  #dispatch(): void {
    if (this.#closed || this.#startupFailure) return;
    for (const slot of this.#slots) {
      if (!slot.ready || slot.retiring || slot.job) continue;
      const job = this.#queue.shift();
      if (!job) break;
      this.#bytes -= job.bytes;
      slot.job = job;
      slot.worker.ref();
      try {
        slot.worker.postMessage(
          { kind: 'run', id: job.id, request: job.request },
          job.request.inputJson ? [job.request.inputJson] : [],
        );
      } catch (error) {
        this.#retire(slot, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #fail(slot: Slot, error: Error): void {
    if (!slot.ready) {
      this.#stopAdmissions(error);
      slot.failed(error);
    }
    this.#retire(slot, error);
  }

  #stopAdmissions(error: Error): void {
    this.#startupFailure ??= error;
    for (const job of this.#queue.splice(0)) this.#reject(job, this.#startupFailure);
    this.#bytes = 0;
  }

  #retire(slot: Slot, error = new Error('Prototype worker retired.')): void {
    if (slot.retiring) return;
    slot.retiring = true;
    if (!slot.ready) slot.failed(error);
    if (slot.job) this.#reject(slot.job, error);
    // The exit handler, not this call or the failed job Promise, releases capacity.
    void slot.worker.terminate().catch(() => undefined);
  }

  #reject(job: Job, error: Error): void {
    if (job.settled) return;
    job.settled = true;
    job.cleanup();
    job.reject(error);
  }

  #abort(job: Job, error: Error): void {
    if (job.settled) return;
    const index = this.#queue.indexOf(job);
    if (index >= 0) {
      this.#queue.splice(index, 1);
      this.#bytes -= job.bytes;
      this.#reject(job, error);
      return;
    }
    const slot = [...this.#slots].find((candidate) => candidate.job === job);
    if (slot) this.#retire(slot, error);
  }

  #abortError(): Error {
    return Object.assign(new Error('Prototype root cancelled.'), { name: 'AbortError' });
  }
}

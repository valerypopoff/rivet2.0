import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

import type { WorkflowRecordingExtractedInput } from './recording-input-filter.js';
import {
  extractWorkflowRecordingInputFromSourceWithTiming,
  type WorkflowRecordingInputExtractionTiming,
  type WorkflowRecordingInputSource,
} from './recording-input-source.js';

type ExtractionJob = {
  id: number;
  source: WorkflowRecordingInputSource;
  resolve: (input: WorkflowRecordingExtractedInput | null) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
  onTiming?: (timing: WorkflowRecordingInputExtractionTiming & { workerQueueAndTransferMs: number }) => void;
  enqueuedAt: number;
};

type WorkerSlot = {
  worker: Worker;
  job?: ExtractionJob;
  /** A cancelled active job keeps its slot until Worker.terminate() finishes. */
  retiring?: boolean;
};

const MAX_WORKERS = availableParallelism() <= 2 ? 1 : 2;

/**
 * Keeps whole-recording JSON.parse work off the API event loop. The extracted
 * input remains the sole result retained by callers; recordings themselves are
 * never moved into a second store.
 */
export class WorkflowRecordingInputExtractor {
  readonly #slots: WorkerSlot[] = [];
  readonly #queue: ExtractionJob[] = [];
  #nextId = 0;
  #retryTimer?: ReturnType<typeof setTimeout>;
  #failures = 0;
  #unavailableUntil = 0;
  readonly #createWorker: () => Worker;

  constructor(createWorker?: () => Worker) {
    this.#createWorker =
      createWorker ?? (() => new Worker(new URL('./recording-input-extractor-worker.js', import.meta.url)));
    this.forceWorker = createWorker != null;
  }
  private readonly forceWorker: boolean;

  /** Prepare one idle worker without reading artifacts or delaying the catalog. */
  prepare(): void {
    if (
      (!this.forceWorker && import.meta.url.endsWith('.ts')) ||
      this.#slots.length > 0 ||
      this.#retryTimer ||
      performance.now() < this.#unavailableUntil
    )
      return;
    try {
      this.#slots.push(this.#createSlot());
    } catch {
      // Preparation is optional. Actual searches retain bounded recovery and
      // report failures normally; opening the catalog must remain successful.
      this.#recover();
    }
  }

  async extract(
    source: WorkflowRecordingInputSource,
    signal?: AbortSignal,
    onTiming?: (timing: WorkflowRecordingInputExtractionTiming & { workerQueueAndTransferMs: number }) => void,
  ): Promise<WorkflowRecordingExtractedInput | null> {
    throwIfAborted(signal);
    // The API's source-mode tests run through tsx, whose loader is not
    // inherited by a plain Worker. Production runs the compiled .js worker.
    // Keep source-mode deterministic rather than creating a worker which can
    // never load its TypeScript entry point.
    if (!this.forceWorker && import.meta.url.endsWith('.ts')) {
      const result = extractWorkflowRecordingInputFromSourceWithTiming(source);
      reportTiming(onTiming, { ...result.timing, workerQueueAndTransferMs: 0 });
      return result.input;
    }
    if (performance.now() < this.#unavailableUntil)
      throw new Error('Recording input workers temporarily unavailable; retry the search.');

    return new Promise<WorkflowRecordingExtractedInput | null>((resolve, reject) => {
      const job: ExtractionJob = {
        id: this.#nextId++,
        source,
        resolve,
        reject,
        signal,
        onTiming,
        enqueuedAt: performance.now(),
      };
      const abort = () => this.#abortJob(job);
      job.abort = abort;
      signal?.addEventListener('abort', abort, { once: true });
      this.#queue.push(job);
      this.#schedule();
    });
  }

  dispose(): void {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    const error = createAbortError();
    for (const job of this.#queue.splice(0)) {
      job.signal?.removeEventListener('abort', job.abort!);
      job.reject(error);
    }
    for (const slot of this.#slots.splice(0)) {
      slot.job?.signal?.removeEventListener('abort', slot.job.abort!);
      slot.job?.reject(error);
      void slot.worker.terminate();
    }
  }

  #schedule(): void {
    if (this.#retryTimer) return;

    // Create a worker only when there is queued work with no already-idle
    // worker to accept it. This reaches the configured concurrency under load
    // without eagerly allocating an unused second worker for a single search.
    while (
      this.#slots.length < MAX_WORKERS &&
      this.#queue.length > this.#slots.filter((slot) => !slot.job && !slot.retiring).length
    ) {
      try {
        this.#slots.push(this.#createSlot());
      } catch {
        this.#recover();
        return;
      }
    }

    for (const slot of this.#slots) {
      if (slot.job || slot.retiring) continue;
      const job = this.#queue.shift();
      if (!job) return;
      if (job.signal?.aborted) {
        job.signal.removeEventListener('abort', job.abort!);
        job.reject(createAbortError());
        continue;
      }
      slot.job = job;
      try {
        // Copy only when dispatched, not while waiting in the worker queue.
        job.source = toWorkerSource(job.source);
        const transferList = job.source.kind === 'artifact' ? [job.source.bytes.buffer] : [];
        slot.worker.ref();
        slot.worker.postMessage({ id: job.id, source: job.source }, transferList);
      } catch (error: unknown) {
        this.#replaceFailedSlot(
          slot,
          error instanceof Error ? error : new Error(`Recording input extractor failed: ${String(error)}`),
        );
      }
    }
  }

  #createSlot(): WorkerSlot {
    const worker = this.#createWorker();
    const slot: WorkerSlot = { worker };
    worker.on(
      'message',
      (message: {
        id: number;
        input?: WorkflowRecordingExtractedInput | null;
        timing?: WorkflowRecordingInputExtractionTiming;
        error?: string;
      }) => {
        const job = slot.job;
        if (!job || job.id !== message.id) return;
        slot.job = undefined;
        worker.unref();
        this.#failures = 0;
        job.signal?.removeEventListener('abort', job.abort!);
        if (message.error) {
          job.reject(new Error(`Recording input extraction failed: ${message.error}`));
        } else {
          if (message.timing) {
            reportTiming(job.onTiming, {
              ...message.timing,
              workerQueueAndTransferMs: Math.max(
                0,
                performance.now() - job.enqueuedAt - message.timing.decompressionMs - message.timing.parseAndExtractMs,
              ),
            });
          }
          job.resolve(message.input ?? null);
        }
        this.#schedule();
      },
    );
    worker.once('error', (error) => this.#replaceFailedSlot(slot, error));
    worker.once('exit', (code) =>
      this.#replaceFailedSlot(slot, new Error(`Recording input extractor exited unexpectedly with code ${code}`)),
    );
    worker.unref();
    return slot;
  }

  #replaceFailedSlot(slot: WorkerSlot, error: Error): void {
    if (!this.#removeSlot(slot)) return;
    const job = slot.job;
    slot.job = undefined;
    job?.signal?.removeEventListener('abort', job.abort!);
    if (slot.retiring) {
      this.#schedule();
      return;
    }

    if (job) job.reject(error);
    void slot.worker.terminate();
    this.#recover();
  }

  #removeSlot(slot: WorkerSlot): boolean {
    const index = this.#slots.indexOf(slot);
    if (index < 0) return false;
    this.#slots.splice(index, 1);
    return true;
  }

  #abortJob(job: ExtractionJob): void {
    const queuedIndex = this.#queue.indexOf(job);
    if (queuedIndex >= 0) {
      this.#queue.splice(queuedIndex, 1);
      job.signal?.removeEventListener('abort', job.abort!);
      job.reject(createAbortError());
      return;
    }
    const slot = this.#slots.find((candidate) => candidate.job === job);
    if (!slot) return;
    slot.job = undefined;
    slot.retiring = true;
    job.signal?.removeEventListener('abort', job.abort!);
    job.reject(createAbortError());
    // Termination is asynchronous. Keep this slot counted until the worker
    // exits so a cancellation storm cannot create more active parsing workers
    // than the pool's configured concurrency.
    void slot.worker.terminate().catch((error: unknown) => {
      this.#replaceFailedSlot(
        slot,
        error instanceof Error ? error : new Error(`Recording input extractor termination failed: ${String(error)}`),
      );
    });
  }

  #recover(): void {
    if (++this.#failures >= 3) {
      this.#unavailableUntil = performance.now() + 1000;
      this.#failures = 0;
      for (const job of this.#queue.splice(0)) {
        job.signal?.removeEventListener('abort', job.abort!);
        job.reject(new Error('Recording input workers unavailable; retry the search.'));
      }
      return;
    }
    if (this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#schedule();
    }, 25 * this.#failures);
  }
}

const extractor = new WorkflowRecordingInputExtractor();

export function prepareWorkflowRecordingInputExtractor(): void {
  extractor.prepare();
}

export function extractWorkflowRecordingInputInWorker(
  source: WorkflowRecordingInputSource,
  signal?: AbortSignal,
  onTiming?: (timing: WorkflowRecordingInputExtractionTiming & { workerQueueAndTransferMs: number }) => void,
): Promise<WorkflowRecordingExtractedInput | null> {
  return extractor.extract(source, signal, onTiming);
}

export function disposeWorkflowRecordingInputExtractor(): void {
  extractor.dispose();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error('Recording input extraction aborted');
  error.name = 'AbortError';
  return error;
}

function toWorkerSource(source: WorkflowRecordingInputSource): WorkflowRecordingInputSource {
  if (source.kind === 'serialized') {
    return source;
  }

  // `Buffer` instances from fs are normally transferable, but the public
  // managed-store seam may supply a view over pooled or shared storage. Copy
  // exactly the artifact bytes so postMessage always owns a detachable buffer
  // and cannot detach a provider-owned allocation.
  const bytes = new Uint8Array(source.bytes.byteLength);
  bytes.set(source.bytes);
  return { ...source, bytes };
}

function reportTiming(
  onTiming:
    | ((timing: WorkflowRecordingInputExtractionTiming & { workerQueueAndTransferMs: number }) => void)
    | undefined,
  timing: WorkflowRecordingInputExtractionTiming & { workerQueueAndTransferMs: number },
): void {
  try {
    onTiming?.(timing);
  } catch {
    // Diagnostic observers must never change recording-search correctness.
  }
}

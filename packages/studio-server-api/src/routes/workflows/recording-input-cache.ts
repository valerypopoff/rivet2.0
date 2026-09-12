import { deserialize, serialize } from 'node:v8';
import { LRUCache } from 'lru-cache';

import type { WorkflowRecordingExtractedInput } from './recording-input-filter.js';
import { RECORDING_INPUT_PAGE_COMPLETE } from './recording-input-filter.js';
import { extractWorkflowRecordingInputInWorker } from './recording-input-extractor.js';
import {
  normalizeWorkflowRecordingInputSource,
  type WorkflowRecordingInputExtractionTiming,
  type WorkflowRecordingInputSource,
} from './recording-input-source.js';

const DEFAULT_MAX_ENTRIES = 16_384;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_ENTRY_MAX_BYTES = 1024 * 1024;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_LOADS = 8;
let nextManagedStorageNamespace = 0;
const managedStorageNamespaces = new WeakMap<object, number>();

type CacheEntry = {
  serializedInput: Buffer;
  retainedBytes: number;
  expiresAt: number;
};

type InFlightLoad = {
  controller: AbortController;
  consumers: number;
  promise: Promise<WorkflowRecordingExtractedInput | null>;
  started: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
};

type WorkflowRecordingInputCacheOptions = {
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  ttlMs?: number;
  maxConcurrentLoads?: number;
  maxEstimatedLoadBytes?: number;
  now?: () => number;
  pageCompletionGraceMs?: number;
  /** Optional diagnostic hook used by the benchmark; it cannot affect loads. */
  onExtractionTiming?: (timing: WorkflowRecordingInputExtractionTiming & { workerQueueAndTransferMs: number }) => void;
};

/**
 * Short-lived, process-local extracted-input cache. Recording artifacts remain
 * authoritative: keys include the managed storage owner plus immutable blob
 * key, or a filesystem artifact's path and stat identity; malformed artifacts
 * are never cached.
 */
export class WorkflowRecordingInputCache {
  // LRUCache performs retention in O(1). Expiry is intentionally checked by
  // this wrapper's injectable clock so tests and cache consumers keep the
  // existing deterministic TTL contract without scanning all entries on each
  // insert.
  readonly #entries: LRUCache<string, CacheEntry>;
  readonly #inFlight = new Map<string, InFlightLoad>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #maxEntryBytes: number;
  readonly #ttlMs: number;
  readonly #maxConcurrentLoads: number;
  readonly #maxEstimatedLoadBytes: number;
  readonly #now: () => number;
  readonly #pageCompletionGraceMs: number;
  readonly #onExtractionTiming:
    | ((timing: WorkflowRecordingInputExtractionTiming & { workerQueueAndTransferMs: number }) => void)
    | undefined;
  #activeLoads = 0;
  #activeBytes = 0;
  readonly #loadWaiters: Array<{ acquire: () => void; weight: number }> = [];

  constructor(options: WorkflowRecordingInputCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxEntryBytes = options.maxEntryBytes ?? DEFAULT_ENTRY_MAX_BYTES;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxConcurrentLoads = Math.max(1, options.maxConcurrentLoads ?? DEFAULT_MAX_CONCURRENT_LOADS);
    this.#maxEstimatedLoadBytes = Math.max(1, options.maxEstimatedLoadBytes ?? 256 * 1024 * 1024);
    this.#now = options.now ?? Date.now;
    this.#pageCompletionGraceMs = options.pageCompletionGraceMs ?? 250;
    this.#onExtractionTiming = options.onExtractionTiming;
    this.#entries = new LRUCache<string, CacheEntry>({
      // LRUCache requires at least one positive structural bound. A disabled
      // cache never reaches set(), so a one-entry shell is sufficient there.
      max: Math.max(1, this.#maxEntries),
      ...(this.#maxBytes > 0
        ? {
            maxSize: this.#maxBytes,
            sizeCalculation: (entry: CacheEntry) => entry.retainedBytes,
          }
        : {}),
      // Do not auto-purge or use a second clock. #takeFresh handles expiry on
      // access, while max/maxSize keep stale-but-unread values bounded.
      ttlAutopurge: false,
    });
  }

  async getOrLoad(
    key: string,
    loadRecordingSource: (signal: AbortSignal) => Promise<WorkflowRecordingInputSource | string | null>,
    signal?: AbortSignal,
    estimatedLoadBytes = 32 * 1024 * 1024,
  ): Promise<WorkflowRecordingExtractedInput | null> {
    throwIfAborted(signal);
    const cached = this.#takeFresh(key);
    if (cached) {
      return deserializeInput(cached.serializedInput);
    }

    let inFlight = this.#inFlight.get(key);
    if (!inFlight) {
      const controller = new AbortController();
      const promise = this.#load(
        key,
        loadRecordingSource,
        controller.signal,
        () => this.#inFlight.get(key) === createdInFlight,
        () => {
          createdInFlight.started = true;
        },
        Number.isFinite(estimatedLoadBytes) && estimatedLoadBytes > 0
          ? estimatedLoadBytes
          : this.#maxEstimatedLoadBytes,
      );
      const createdInFlight: InFlightLoad = { controller, consumers: 0, promise, started: false };
      inFlight = createdInFlight;
      this.#inFlight.set(key, createdInFlight);
      void promise.then(
        () => this.#deleteInFlightIfCurrent(key, createdInFlight),
        () => this.#deleteInFlightIfCurrent(key, createdInFlight),
      );
    }

    inFlight.consumers += 1;
    clearTimeout(inFlight.graceTimer);
    inFlight.graceTimer = undefined;
    try {
      const input = await awaitWithAbort(inFlight.promise, signal);
      return input == null ? null : deserializeInput(serializeInput(input));
    } finally {
      inFlight.consumers -= 1;
      if (inFlight.consumers === 0) {
        if (
          this.#inFlight.get(key) === inFlight &&
          signal?.reason === RECORDING_INPUT_PAGE_COMPLETE &&
          inFlight.started &&
          this.#pageCompletionGraceMs > 0
        ) {
          // Only already-admitted work gets a short handoff window. The same
          // eight cold-load slots remain reserved; queued work is cancelled.
          const abandoned = inFlight;
          abandoned.graceTimer = setTimeout(() => {
            abandoned.controller.abort();
            this.#deleteInFlightIfCurrent(key, abandoned);
          }, this.#pageCompletionGraceMs);
          abandoned.graceTimer.unref();
        } else {
          // Do not let a disconnected request begin an artifact read after it
          // has been waiting behind another bounded cold search. Active reads
          // cannot all be cancelled by every store implementation, but this
          // signal prevents queue promotion and skips caching their result.
          inFlight.controller.abort();
          this.#deleteInFlightIfCurrent(key, inFlight);
        }
      }
    }
  }

  invalidate(key: string): void {
    this.#removeEntry(key);
    // Existing consumers may finish their captured read, but new consumers
    // must not join it and its completion must not replace a newer value.
    const inFlight = this.#inFlight.get(key);
    if (inFlight) {
      this.#deleteInFlightIfCurrent(key, inFlight);
      if (inFlight.consumers === 0) inFlight.controller.abort();
    }
  }

  invalidateByPrefix(prefix: string): void {
    const keys = new Set([...this.#entries.keys(), ...this.#inFlight.keys()]);
    for (const key of keys) {
      if (key.startsWith(prefix)) {
        this.invalidate(key);
      }
    }
  }

  clear(): void {
    this.#entries.clear();
    for (const key of this.#inFlight.keys()) this.invalidate(key);
  }

  get size(): number {
    return this.#entries.size;
  }

  async #load(
    key: string,
    loadRecordingSource: (signal: AbortSignal) => Promise<WorkflowRecordingInputSource | string | null>,
    signal: AbortSignal,
    isCurrent: () => boolean,
    onStarted: () => void,
    estimatedLoadBytes: number,
  ): Promise<WorkflowRecordingExtractedInput | null> {
    // A cold search is not complete when storage returns: parsing a large
    // recording can otherwise enqueue unlimited work behind the small worker
    // pool. Retain the process-wide slot through both phases.
    const input = await this.#runWithLoadSlot(
      async () => {
        onStarted();
        const source = await loadRecordingSource(signal);
        throwIfAborted(signal);
        if (source == null) {
          return null;
        }
        return extractWorkflowRecordingInputInWorker(
          normalizeWorkflowRecordingInputSource(source),
          signal,
          this.#onExtractionTiming,
        );
      },
      signal,
      estimatedLoadBytes,
    );
    if (!input) {
      return null;
    }

    // Cache the tiny extracted input, rather than refusing to cache it merely
    // because unrelated execution history made the source recording large.
    if (isCurrent() && !signal.aborted) {
      this.#store(key, input);
    }

    return input;
  }

  #takeFresh(key: string): CacheEntry | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.#now()) {
      this.invalidate(key);
      return undefined;
    }

    return entry;
  }

  #store(key: string, input: WorkflowRecordingExtractedInput): void {
    const serializedInput = serializeInput(input);
    const retainedBytes = serializedInput.byteLength;
    this.#removeEntry(key);

    if (
      this.#maxEntries <= 0 ||
      this.#maxBytes <= 0 ||
      retainedBytes > this.#maxEntryBytes ||
      retainedBytes > this.#maxBytes
    ) {
      return;
    }

    this.#entries.set(key, {
      serializedInput,
      retainedBytes,
      expiresAt: this.#now() + this.#ttlMs,
    });
  }

  async #runWithLoadSlot<T>(load: () => Promise<T>, signal: AbortSignal, weight: number): Promise<T> {
    await this.#acquireLoadSlot(signal, weight);
    try {
      throwIfAborted(signal);
      return await load();
    } finally {
      this.#activeLoads -= 1;
      this.#activeBytes -= weight;
      this.#promoteWaiters();
    }
  }

  #deleteInFlightIfCurrent(key: string, inFlight: InFlightLoad): void {
    clearTimeout(inFlight.graceTimer);
    if (this.#inFlight.get(key) === inFlight) {
      this.#inFlight.delete(key);
    }
  }

  #removeEntry(key: string): void {
    this.#entries.delete(key);
  }

  #canAdmit(weight: number): boolean {
    // An oversized recording runs alone rather than starving forever.
    return (
      this.#activeLoads === 0 ||
      (this.#activeLoads < this.#maxConcurrentLoads && this.#activeBytes + weight <= this.#maxEstimatedLoadBytes)
    );
  }

  #acquireLoadSlot(signal: AbortSignal, weight: number): Promise<void> {
    throwIfAborted(signal);
    if (this.#loadWaiters.length === 0 && this.#canAdmit(weight)) {
      this.#activeLoads += 1;
      this.#activeBytes += weight;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const acquire = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        const waiterIndex = this.#loadWaiters.findIndex((waiter) => waiter.acquire === acquire);
        if (waiterIndex >= 0) {
          this.#loadWaiters.splice(waiterIndex, 1);
        }
        signal.removeEventListener('abort', abort);
        reject(createAbortError());
        this.#promoteWaiters();
      };

      signal.addEventListener('abort', abort, { once: true });
      this.#loadWaiters.push({ acquire, weight });
      if (signal.aborted) {
        abort();
      }
    });
  }

  #promoteWaiters(): void {
    while (this.#loadWaiters.length > 0 && this.#canAdmit(this.#loadWaiters[0]!.weight)) {
      const next = this.#loadWaiters.shift()!;
      this.#activeLoads += 1;
      this.#activeBytes += next.weight;
      next.acquire();
    }
  }
}

export const workflowRecordingInputCache = new WorkflowRecordingInputCache();

export function getFilesystemRecordingInputCacheKey(options: {
  recordingPath: string;
  encoding: string;
  size: number;
  mtimeMs: number;
}): string {
  return `filesystem:${options.recordingPath}\0${options.encoding}\0${options.size}\0${options.mtimeMs}`;
}

export function getManagedRecordingInputCacheKey(storageOwner: object, recordingBlobKey: string): string {
  let namespace = managedStorageNamespaces.get(storageOwner);
  if (namespace == null) {
    nextManagedStorageNamespace += 1;
    namespace = nextManagedStorageNamespace;
    managedStorageNamespaces.set(storageOwner, namespace);
  }

  // Blob keys are only unique within a managed storage owner. Keep independent
  // hosted tenants and test stores from ever sharing extracted input by key.
  return `managed:${namespace}:${recordingBlobKey}`;
}

export function invalidateFilesystemRecordingInputCache(recordingPath: string): void {
  workflowRecordingInputCache.invalidateByPrefix(`filesystem:${recordingPath}\0`);
}

function serializeInput(input: WorkflowRecordingExtractedInput): Buffer {
  return serialize(input);
}

function deserializeInput(serializedInput: Buffer): WorkflowRecordingExtractedInput {
  return deserialize(serializedInput) as WorkflowRecordingExtractedInput;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error('Recording input extraction aborted');
  error.name = 'AbortError';
  return error;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(createAbortError());
    };

    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

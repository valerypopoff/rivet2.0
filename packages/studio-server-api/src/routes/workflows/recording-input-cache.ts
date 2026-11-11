import { deserialize, serialize } from 'node:v8';
import { LRUCache } from 'lru-cache';
import { recordStudioMetrics } from '../../metrics.js';

import type { WorkflowRecordingExtractedInput } from './recording-input-filter.js';
import { RECORDING_INPUT_CONCURRENT_READS, RECORDING_INPUT_PAGE_COMPLETE } from './recording-input-filter.js';
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
const REQUEST_ID_MAX_ENTRIES = 32_768;
const REQUEST_ID_MAX_ENTRY_BYTES = 4096;
const REQUEST_ID_TTL_MS = 60 * 60 * 1000;
let nextManagedStorageNamespace = 0;
const managedStorageNamespaces = new WeakMap<object, number>();

type CacheEntry = {
  serializedInput: Buffer;
  retainedBytes: number;
  expiresAt: number;
  immutable: boolean;
};

type RequestIdValue = string | number | boolean | null | undefined;
type RequestIdProjection = { exists: boolean; value: { request_id?: RequestIdValue } };

function projectRequestId(input: WorkflowRecordingExtractedInput): RequestIdProjection | undefined {
  const projection: RequestIdProjection = { exists: input.exists, value: {} };
  if (
    input.exists &&
    input.value != null &&
    typeof input.value === 'object' &&
    Object.prototype.hasOwnProperty.call(input.value, 'request_id')
  ) {
    const value = (input.value as { request_id: unknown }).request_id;
    if (value != null && !['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return undefined;
    if (typeof value === 'string' && Buffer.byteLength(value) > REQUEST_ID_MAX_ENTRY_BYTES) return undefined;
    projection.value.request_id = value as RequestIdValue;
  }
  return serializeInput(projection).byteLength <= REQUEST_ID_MAX_ENTRY_BYTES ? projection : undefined;
}

type InFlightLoad = {
  controller: AbortController;
  consumers: number;
  promise: Promise<WorkflowRecordingExtractedInput | null>;
  started: boolean;
  fullInputRequested: boolean;
  requestIdRequested: boolean;
  readonly immutable: boolean;
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
  requestIdMaxEntries?: number;
  requestIdTtlMs?: number;
  onCacheEvent?: (event: RecordingInputCacheEvent) => void;
  /** Optional diagnostic hook used by the benchmark; it cannot affect loads. */
  onExtractionTiming?: (timing: WorkflowRecordingInputExtractionTiming & { workerQueueAndTransferMs: number }) => void;
};

type RecordingInputCacheEvent = 'hit' | 'miss' | 'shared' | 'load' | 'evicted' | 'expired' | 'oversized';

/**
 * Short-lived, process-local extracted-input cache. Recording artifacts remain
 * authoritative: keys include the managed storage owner plus immutable blob
 * key, or a filesystem artifact's path and stat identity; malformed artifacts
 * are never cached.
 */
export class WorkflowRecordingInputCache {
  readonly #events = { hit: 0, miss: 0, shared: 0, load: 0, evicted: 0, expired: 0, oversized: 0 };
  readonly #onCacheEvent: WorkflowRecordingInputCacheOptions['onCacheEvent'];
  // LRUCache performs retention in O(1). Expiry is intentionally checked by
  // this wrapper's injectable clock so tests and cache consumers keep the
  // existing deterministic TTL contract without scanning all entries on each
  // insert.
  readonly #entries: LRUCache<string, CacheEntry>;
  readonly #requestIds: LRUCache<string, CacheEntry>;
  readonly #requestIdTtlMs: number;
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
    this.#onCacheEvent = options.onCacheEvent;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxEntryBytes = options.maxEntryBytes ?? DEFAULT_ENTRY_MAX_BYTES;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxConcurrentLoads = Math.max(1, options.maxConcurrentLoads ?? RECORDING_INPUT_CONCURRENT_READS);
    this.#maxEstimatedLoadBytes = Math.max(1, options.maxEstimatedLoadBytes ?? 256 * 1024 * 1024);
    this.#now = options.now ?? Date.now;
    this.#pageCompletionGraceMs = options.pageCompletionGraceMs ?? 250;
    this.#onExtractionTiming = options.onExtractionTiming;
    this.#requestIdTtlMs = options.requestIdTtlMs ?? REQUEST_ID_TTL_MS;
    this.#requestIds = new LRUCache<string, CacheEntry>({
      max: Math.max(1, options.requestIdMaxEntries ?? REQUEST_ID_MAX_ENTRIES),
      maxSize: Math.max(1, Math.floor(this.#maxBytes * 0.75)),
      sizeCalculation: (entry) => entry.retainedBytes,
      dispose: (_entry, _key, reason) => {
        if (reason === 'evict') this.#record('evicted');
      },
    });
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
      dispose: (_entry, _key, reason) => {
        if (reason === 'evict') this.#record('evicted');
      },
    });
  }

  async getOrLoad(
    key: string,
    loadRecordingSource: (signal: AbortSignal) => Promise<WorkflowRecordingInputSource | string | null>,
    signal?: AbortSignal,
    estimatedLoadBytes = 32 * 1024 * 1024,
    options: { requestIdOnly?: boolean; immutable?: boolean } = {},
  ): Promise<WorkflowRecordingExtractedInput | null> {
    throwIfAborted(signal);
    const requestIdOnly = options.requestIdOnly === true;
    const projection = requestIdOnly ? this.#takeFresh(key, this.#requestIds) : undefined;
    if (projection) {
      this.#record('hit');
      return deserializeInput(projection.serializedInput);
    }
    const cached = this.#takeFresh(key);
    if (cached) {
      this.#record('hit');
      const input = deserializeInput(cached.serializedInput);
      if (!requestIdOnly) return input;
      const selected = projectRequestId(input);
      if (selected) this.#storeRequestId(key, selected, cached.immutable, cached.expiresAt);
      return selected ?? input;
    }

    this.#record('miss');

    let inFlight = this.#inFlight.get(key);
    if (inFlight) this.#record('shared');
    if (!inFlight) {
      // A new source read supersedes every older view, even if it fails or
      // finds the artifact missing. Refresh an existing projection alongside
      // a full-input read so subsequent equality searches see the same source.
      const refreshRequestId = this.#requestIds.delete(key);
      const controller = new AbortController();
      const promise = this.#load(
        key,
        loadRecordingSource,
        controller.signal,
        () => (this.#inFlight.get(key) === createdInFlight ? createdInFlight : undefined),
        () => {
          createdInFlight.started = true;
        },
        Number.isFinite(estimatedLoadBytes) && estimatedLoadBytes > 0
          ? estimatedLoadBytes
          : this.#maxEstimatedLoadBytes,
      );
      const createdInFlight: InFlightLoad = {
        controller,
        consumers: 0,
        promise,
        started: false,
        fullInputRequested: false,
        requestIdRequested: refreshRequestId,
        immutable: options.immutable === true,
      };
      inFlight = createdInFlight;
      this.#inFlight.set(key, createdInFlight);
      void promise.then(
        () => this.#deleteInFlightIfCurrent(key, createdInFlight),
        () => this.#deleteInFlightIfCurrent(key, createdInFlight),
      );
    }

    inFlight.fullInputRequested ||= !requestIdOnly;
    inFlight.requestIdRequested ||= requestIdOnly;
    inFlight.consumers += 1;
    clearTimeout(inFlight.graceTimer);
    inFlight.graceTimer = undefined;
    try {
      const input = await awaitWithAbort(inFlight.promise, signal);
      const selected = input && requestIdOnly ? projectRequestId(input) ?? input : input;
      return selected == null ? null : deserializeInput(serializeInput(selected));
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
          // bounded cold-load slots remain reserved; queued work is cancelled.
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
    this.#requestIds.delete(key);
    // Existing consumers may finish their captured read, but new consumers
    // must not join it and its completion must not replace a newer value.
    const inFlight = this.#inFlight.get(key);
    if (inFlight) {
      this.#deleteInFlightIfCurrent(key, inFlight);
      if (inFlight.consumers === 0) inFlight.controller.abort();
    }
  }

  invalidateByPrefix(prefix: string): void {
    const keys = new Set([...this.#entries.keys(), ...this.#requestIds.keys(), ...this.#inFlight.keys()]);
    for (const key of keys) {
      if (key.startsWith(prefix)) {
        this.invalidate(key);
      }
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#requestIds.clear();
    for (const key of this.#inFlight.keys()) this.invalidate(key);
  }

  get size(): number {
    return this.#entries.size + this.#requestIds.size;
  }

  /** Bounded aggregate diagnostics; never includes keys, filters, or inputs. */
  get diagnostics() {
    return {
      ...this.#events,
      entries: this.size,
      retainedBytes: this.#entries.calculatedSize + this.#requestIds.calculatedSize,
      requestIdEntries: this.#requestIds.size,
      activeLoads: this.#activeLoads,
      queuedLoads: this.#loadWaiters.length,
    };
  }

  #record(event: RecordingInputCacheEvent): void {
    this.#events[event]++;
    try {
      this.#onCacheEvent?.(event);
    } catch {
      /* Diagnostics cannot affect search. */
    }
  }

  async #load(
    key: string,
    loadRecordingSource: (signal: AbortSignal) => Promise<WorkflowRecordingInputSource | string | null>,
    signal: AbortSignal,
    currentLoad: () => InFlightLoad | undefined,
    onStarted: () => void,
    estimatedLoadBytes: number,
  ): Promise<WorkflowRecordingExtractedInput | null> {
    // A cold search is not complete when storage returns: parsing a large
    // recording can otherwise enqueue unlimited work behind the small worker
    // pool. Retain the process-wide slot through both phases.
    const input = await this.#runWithLoadSlot(
      async () => {
        onStarted();
        this.#record('load');
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

    const current = currentLoad();
    if (current && !signal.aborted) {
      const projection = current.requestIdRequested ? projectRequestId(input) : undefined;
      if (projection) this.#storeRequestId(key, projection, current.immutable);
      if (current.fullInputRequested || (current.requestIdRequested && !projection))
        this.#store(key, input, current.immutable);
    }

    return input;
  }

  #takeFresh(key: string, entries = this.#entries): CacheEntry | undefined {
    const entry = entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.#now()) {
      this.#record('expired');
      entries.delete(key);
      return undefined;
    }

    return entry;
  }

  #store(key: string, input: WorkflowRecordingExtractedInput, immutable: boolean): void {
    if (this.#maxEntries <= 0 || this.#maxBytes <= 0) return;
    const serializedInput = serializeInput(input);
    const retainedBytes = serializedInput.byteLength;
    this.#removeEntry(key);

    if (retainedBytes > this.#maxEntryBytes || retainedBytes > this.#maxBytes - this.#requestIds.calculatedSize) {
      this.#record('oversized');
      return;
    }

    this.#makeRoom(retainedBytes);
    this.#entries.set(key, {
      serializedInput,
      retainedBytes,
      expiresAt: this.#now() + this.#ttlMs,
      immutable,
    });
  }

  #storeRequestId(key: string, input: RequestIdProjection, immutable: boolean, sourceExpiresAt?: number): void {
    if (this.#maxEntries <= 0 || this.#maxBytes <= 0) return;
    const serializedInput = serializeInput(input);
    // Include conservative key/wrapper accounting; decoded worker RSS is separate.
    const retainedBytes = serializedInput.byteLength + Buffer.byteLength(key) * 2 + 128;
    if (retainedBytes > this.#requestIds.maxSize) return;
    this.#requestIds.delete(key);
    // Evict from this view first. Otherwise a full projection LRU can evict
    // an unrelated full input and then evict its own old entry as well.
    while (
      this.#requestIds.size >= this.#requestIds.max ||
      this.#requestIds.calculatedSize + retainedBytes > this.#requestIds.maxSize
    ) {
      this.#requestIds.pop();
    }
    this.#makeRoom(retainedBytes);
    this.#requestIds.set(key, {
      serializedInput,
      retainedBytes,
      expiresAt: immutable
        ? this.#now() + this.#requestIdTtlMs
        : Math.min(sourceExpiresAt ?? Number.POSITIVE_INFINITY, this.#now() + this.#ttlMs),
      immutable,
    });
  }

  #makeRoom(bytes: number): void {
    while (
      this.#entries.calculatedSize + this.#requestIds.calculatedSize + bytes > this.#maxBytes &&
      this.#entries.size
    ) {
      this.#entries.pop();
    }
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

/** Deployment memory budget, per API process. Retained inputs only, not worker RSS. */
export function getRecordingInputCacheMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.RIVET_RECORDING_INPUT_CACHE_MAX_MIB?.trim();
  if (!value) return DEFAULT_MAX_BYTES;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 512) {
    throw new Error('RIVET_RECORDING_INPUT_CACHE_MAX_MIB must be an integer from 0 to 512.');
  }
  return Number(value) * 1024 * 1024;
}

export const workflowRecordingInputCache = new WorkflowRecordingInputCache({
  maxBytes: getRecordingInputCacheMaxBytes(),
  onCacheEvent: (event) => recordStudioMetrics((metrics) => metrics.recordRecordingInputCacheEvent(event)),
  onExtractionTiming: (timing) =>
    recordStudioMetrics((metrics) => {
      metrics.observeRecordingInputExtraction('decode', timing.decompressionMs);
      metrics.observeRecordingInputExtraction('parse', timing.parseAndExtractMs);
      metrics.observeRecordingInputExtraction('queue_transfer', timing.workerQueueAndTransferMs);
    }),
});

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

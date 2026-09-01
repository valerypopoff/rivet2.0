import {
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTION_BYTES,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTIVE_BYTES,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_VALUE_BYTES,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_TRANSFER_TIMEOUT_MS,
  RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_CHUNK_BYTES,
  cloneRivetStoredValue,
  decodeRivetWebAppStorageBinaryFrame,
  deserializeRivetWebAppStoredValue,
  encodeRivetWebAppStorageBinaryFrame,
  normalizeRivetStoredValueKey,
  serializeRivetWebAppStoredValue,
  serializeRivetWebAppStoredValuePatch,
  splitRivetWebAppStorageTransfer,
  type RivetStoredValue,
  type RivetStoredValueRecord,
  type RivetStoredValueStore,
  type RivetWebAppBrowserStorageClientMessage,
  type RivetWebAppBrowserStorageServerMessage,
} from '@valerypopoff/rivet2-core';

export type RivetWebAppBrowserStorageRpcLimits = Readonly<{
  maxActionBytes: number;
  maxActiveBytes: number;
  maxValueBytes: number;
  transferTimeoutMs: number;
}>;

export type RivetWebAppBrowserStorageRpcAdmission = Readonly<{
  getActiveBytes(): number;
  reserve(byteLength: number): (() => void) | undefined;
}>;

export type RivetWebAppBrowserStorageRpcEvent =
  | Readonly<{ type: 'protocol-negotiated'; version: 'legacy' | '2' }>
  | Readonly<{
      type: 'transfer';
      byteLength: number;
      direction: 'commit' | 'read';
      durationMs: number;
      outcome: 'cancelled' | 'capacity_rejected' | 'completed' | 'invalid' | 'too_large' | 'unavailable';
      retryable: boolean;
    }>;

export class RivetWebAppBrowserStorageRpcError extends Error {
  constructor(
    message: string,
    readonly code: 'storage_unavailable' | 'storage_invalid' | 'storage_too_large' | 'storage_capacity',
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'RivetWebAppBrowserStorageRpcError';
  }
}

export function createRivetWebAppBrowserStorageRpcAdmission(
  maxActiveBytes = RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTIVE_BYTES,
): RivetWebAppBrowserStorageRpcAdmission {
  assertPositiveSafeInteger(maxActiveBytes, 'maxActiveBytes');
  let activeBytes = 0;
  return {
    getActiveBytes: () => activeBytes,
    reserve(byteLength) {
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || activeBytes + byteLength > maxActiveBytes) {
        return undefined;
      }
      activeBytes += byteLength;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeBytes -= byteLength;
      };
    },
  };
}

type PendingRead = {
  chunks: Uint8Array[];
  declaredBytes: number;
  expectedChunkIndex: number;
  found: boolean;
  reject(error: unknown): void;
  releaseReservation?: () => void;
  resolve(value: RivetStoredValue | undefined): void;
  storageRequestId: string;
  startedAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  transferId?: string;
};

type PendingCommit = {
  byteLength: number;
  reject(error: unknown): void;
  releaseReservation: () => void;
  resolve(): void;
  startedAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  transferId: string;
};

export class RivetWebAppBrowserStorageRpcHost {
  readonly #cache = new Map<string, RivetStoredValue | undefined>();
  readonly #patch: RivetStoredValueRecord = {};
  readonly #requestId: string;
  readonly #runId: string;
  readonly #storageSessionId = crypto.randomUUID();
  readonly #signal: AbortSignal;
  readonly #limits: RivetWebAppBrowserStorageRpcLimits;
  readonly #admission: RivetWebAppBrowserStorageRpcAdmission;
  readonly #onEvent: ((event: RivetWebAppBrowserStorageRpcEvent) => void) | undefined;
  readonly #sendJson: (message: RivetWebAppBrowserStorageServerMessage) => boolean;
  readonly #sendBinary: (frame: Uint8Array) => boolean;
  readonly #abortListener: () => void;
  #operationQueue = Promise.resolve();
  #pendingRead: PendingRead | undefined;
  #pendingCommit: PendingCommit | undefined;
  #transferredBytes = 0;
  #disposed = false;

  readonly store: RivetStoredValueStore = {
    get: (key) => this.#enqueue(() => this.#get(normalizeRivetStoredValueKey(key))),
    set: (key, value) => {
      this.#assertUsable();
      const normalizedKey = normalizeRivetStoredValueKey(key);
      const cloned = cloneRivetStoredValue(value, 'Browser Stored Value');
      this.#cache.set(normalizedKey, cloned);
      Object.defineProperty(this.#patch, normalizedKey, {
        configurable: true,
        enumerable: true,
        value: cloned,
        writable: true,
      });
    },
  };

  constructor(options: {
    admission: RivetWebAppBrowserStorageRpcAdmission;
    limits?: Partial<RivetWebAppBrowserStorageRpcLimits>;
    onEvent?(event: RivetWebAppBrowserStorageRpcEvent): void;
    requestId: string;
    runId: string;
    sendBinary(frame: Uint8Array): boolean;
    sendJson(message: RivetWebAppBrowserStorageServerMessage): boolean;
    signal: AbortSignal;
  }) {
    this.#requestId = options.requestId;
    this.#runId = options.runId;
    this.#signal = options.signal;
    this.#admission = options.admission;
    this.#onEvent = options.onEvent;
    this.#sendJson = options.sendJson;
    this.#sendBinary = options.sendBinary;
    this.#limits = {
      maxActionBytes: options.limits?.maxActionBytes ?? RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTION_BYTES,
      maxActiveBytes: options.limits?.maxActiveBytes ?? RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTIVE_BYTES,
      maxValueBytes: options.limits?.maxValueBytes ?? RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_VALUE_BYTES,
      transferTimeoutMs: options.limits?.transferTimeoutMs ?? RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_TRANSFER_TIMEOUT_MS,
    };
    assertPositiveSafeInteger(this.#limits.maxActionBytes, 'maxActionBytes');
    assertPositiveSafeInteger(this.#limits.maxActiveBytes, 'maxActiveBytes');
    assertPositiveSafeInteger(this.#limits.maxValueBytes, 'maxValueBytes');
    assertPositiveSafeInteger(this.#limits.transferTimeoutMs, 'transferTimeoutMs');
    this.#abortListener = () => this.dispose(this.#signal.reason ?? new DOMException('Action aborted.', 'AbortError'));
    this.#signal.addEventListener('abort', this.#abortListener, { once: true });
  }

  async commit(): Promise<void> {
    await this.#enqueue(async () => {
      const keys = Object.keys(this.#patch);
      if (keys.length === 0) return;
      this.#assertUsable();
      for (const key of keys) {
        const valueBytes = serializeRivetWebAppStoredValue(this.#patch[key]!);
        if (valueBytes.byteLength > this.#limits.maxValueBytes) {
          const error = this.#error(
            'A browser Stored Value exceeds the configured maximum size.',
            'storage_too_large',
            false,
          );
          this.#emitTransfer('commit', valueBytes.byteLength, Date.now(), error);
          throw error;
        }
      }
      const bytes = serializeRivetWebAppStoredValuePatch(this.#patch);
      let rollbackActionBytes: () => void;
      try {
        rollbackActionBytes = this.#reserveActionBytes(bytes.byteLength);
      } catch (error) {
        this.#emitTransfer('commit', bytes.byteLength, Date.now(), error);
        throw error;
      }
      const releaseReservation = this.#admission.reserve(bytes.byteLength);
      if (!releaseReservation) {
        rollbackActionBytes();
        const error = this.#error('Browser storage transfer capacity is temporarily full.', 'storage_capacity', true);
        this.#emitTransfer('commit', bytes.byteLength, Date.now(), error);
        throw error;
      }
      const transferId = crypto.randomUUID();
      const chunks = splitRivetWebAppStorageTransfer(bytes);
      await new Promise<void>((resolve, reject) => {
        const timer = this.#createTimer(() =>
          this.#finishCommit(this.#error('Browser storage commit timed out.', 'storage_unavailable', true)),
        );
        this.#pendingCommit = {
          byteLength: bytes.byteLength,
          reject,
          releaseReservation,
          resolve,
          startedAtMs: Date.now(),
          timer,
          transferId,
        };
        if (
          !this.#sendJson({
            type: 'storage.commit.start',
            requestId: this.#requestId,
            runId: this.#runId,
            storageSessionId: this.#storageSessionId,
            transferId,
            byteLength: bytes.byteLength,
            chunkCount: chunks.length,
          }) ||
          chunks.some(
            (chunk, index) =>
              !this.#sendBinary(encodeRivetWebAppStorageBinaryFrame(this.#storageSessionId, transferId, index, chunk)),
          )
        ) {
          this.#finishCommit(
            this.#error('Browser storage connection closed during commit.', 'storage_unavailable', true),
          );
        }
      });
    });
  }

  handleMessage(message: RivetWebAppBrowserStorageClientMessage): void {
    if (message.requestId !== this.#requestId || message.runId !== this.#runId || this.#disposed) return;
    if (message.storageSessionId !== this.#storageSessionId) {
      this.dispose(this.#error('Browser storage action session mismatch.', 'storage_invalid', false));
      return;
    }
    if (message.type === 'storage.transfer.start') {
      this.#startReadTransfer(message);
      return;
    }
    if (message.type === 'storage.commit.ack') {
      if (this.#pendingCommit?.transferId !== message.transferId) {
        this.dispose(this.#error('Browser acknowledged an unknown storage commit.', 'storage_invalid', false));
      } else {
        this.#finishCommit();
      }
      return;
    }
    if (message.type === 'storage.error') {
      const error = this.#error(message.error || 'Browser storage operation failed.', message.code, message.retryable);
      if (message.transferId && this.#pendingCommit?.transferId === message.transferId) this.#finishCommit(error);
      else if (message.storageRequestId && this.#pendingRead?.storageRequestId === message.storageRequestId) {
        this.#finishRead(error);
      }
    }
  }

  handleBinary(frame: ArrayBuffer | ArrayBufferView): boolean {
    if (this.#disposed) return false;
    const decoded = decodeRivetWebAppStorageBinaryFrame(frame);
    const pending = this.#pendingRead;
    if (
      !decoded ||
      decoded.storageSessionId !== this.#storageSessionId ||
      !pending?.transferId ||
      decoded.transferId !== pending.transferId
    ) {
      return false;
    }
    if (
      decoded.chunkIndex !== pending.expectedChunkIndex ||
      decoded.bytes.byteLength > RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_CHUNK_BYTES
    ) {
      this.#finishRead(
        this.#error('Browser storage transfer chunks are missing or out of order.', 'storage_invalid', false),
      );
      return true;
    }
    const receivedBefore = pending.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (receivedBefore + decoded.bytes.byteLength > pending.declaredBytes) {
      this.#finishRead(this.#error('Browser storage transfer exceeded its declared size.', 'storage_invalid', false));
      return true;
    }
    pending.chunks.push(decoded.bytes);
    pending.expectedChunkIndex += 1;
    const received = receivedBefore + decoded.bytes.byteLength;
    const expectedChunks = expectedChunkCount(pending.declaredBytes);
    if (pending.expectedChunkIndex === expectedChunks) {
      if (received !== pending.declaredBytes) {
        this.#finishRead(
          this.#error('Browser storage transfer size did not match its declaration.', 'storage_invalid', false),
        );
        return true;
      }
      try {
        const bytes = concatenateChunks(pending.chunks, pending.declaredBytes);
        const value = deserializeRivetWebAppStoredValue(bytes);
        this.#sendJson({
          type: 'storage.transfer.ack',
          requestId: this.#requestId,
          runId: this.#runId,
          storageSessionId: this.#storageSessionId,
          storageRequestId: pending.storageRequestId,
          transferId: pending.transferId,
        });
        this.#finishRead(undefined, value);
      } catch {
        this.#finishRead(this.#error('Browser storage value was not valid portable JSON.', 'storage_invalid', false));
      }
    }
    return true;
  }

  dispose(error: unknown = new Error('Browser storage RPC was disposed.')): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#signal.removeEventListener('abort', this.#abortListener);
    this.#finishRead(error);
    this.#finishCommit(error);
    this.#cache.clear();
    for (const key of Object.keys(this.#patch)) delete this.#patch[key];
  }

  async #get(key: string): Promise<RivetStoredValue | undefined> {
    this.#assertUsable();
    if (this.#cache.has(key)) return cloneOptionalValue(this.#cache.get(key));
    const storageRequestId = crypto.randomUUID();
    const value = await new Promise<RivetStoredValue | undefined>((resolve, reject) => {
      const timer = this.#createTimer(() =>
        this.#finishRead(this.#error('Browser storage read timed out.', 'storage_unavailable', true)),
      );
      this.#pendingRead = {
        chunks: [],
        declaredBytes: 0,
        expectedChunkIndex: 0,
        found: false,
        reject,
        resolve,
        storageRequestId,
        startedAtMs: Date.now(),
        timer,
      };
      if (
        !this.#sendJson({
          type: 'storage.get',
          requestId: this.#requestId,
          runId: this.#runId,
          storageSessionId: this.#storageSessionId,
          storageRequestId,
          key,
        })
      ) {
        this.#finishRead(this.#error('Browser storage connection is unavailable.', 'storage_unavailable', true));
      }
    });
    this.#cache.set(key, value);
    return cloneOptionalValue(value);
  }

  #startReadTransfer(
    message: Extract<RivetWebAppBrowserStorageClientMessage, { type: 'storage.transfer.start' }>,
  ): void {
    const pending = this.#pendingRead;
    if (!pending || pending.storageRequestId !== message.storageRequestId || pending.transferId) {
      this.dispose(this.#error('Browser started an unexpected storage transfer.', 'storage_invalid', false));
      return;
    }
    if (!message.found) {
      if (message.byteLength !== 0 || message.chunkCount !== 0) {
        this.#finishRead(
          this.#error('A missing browser value included unexpected payload bytes.', 'storage_invalid', false),
        );
        return;
      }
      this.#sendJson({
        type: 'storage.transfer.ack',
        requestId: this.#requestId,
        runId: this.#runId,
        storageSessionId: this.#storageSessionId,
        storageRequestId: pending.storageRequestId,
        transferId: message.transferId,
      });
      this.#finishRead(undefined, undefined);
      return;
    }
    if (message.byteLength > this.#limits.maxValueBytes) {
      this.#finishRead(
        this.#error('A browser Stored Value exceeds the configured maximum size.', 'storage_too_large', false),
      );
      return;
    }
    if (message.chunkCount !== expectedChunkCount(message.byteLength) || message.byteLength === 0) {
      this.#finishRead(this.#error('Browser storage transfer metadata is inconsistent.', 'storage_invalid', false));
      return;
    }
    try {
      const rollbackActionBytes = this.#reserveActionBytes(message.byteLength);
      const releaseReservation = this.#admission.reserve(message.byteLength);
      if (!releaseReservation) rollbackActionBytes();
      if (!releaseReservation) {
        this.#finishRead(
          this.#error('Browser storage transfer capacity is temporarily full.', 'storage_capacity', true),
        );
        return;
      }
      pending.declaredBytes = message.byteLength;
      pending.found = true;
      pending.releaseReservation = releaseReservation;
      pending.transferId = message.transferId;
    } catch (error) {
      this.#finishRead(error);
    }
  }

  #finishRead(error?: unknown, value?: RivetStoredValue): void {
    const pending = this.#pendingRead;
    if (!pending) return;
    this.#pendingRead = undefined;
    clearTimeout(pending.timer);
    pending.releaseReservation?.();
    this.#emitTransfer('read', pending.declaredBytes, pending.startedAtMs, error);
    if (error !== undefined) pending.reject(error);
    else pending.resolve(value);
  }

  #finishCommit(error?: unknown): void {
    const pending = this.#pendingCommit;
    if (!pending) return;
    this.#pendingCommit = undefined;
    clearTimeout(pending.timer);
    pending.releaseReservation();
    this.#emitTransfer('commit', pending.byteLength, pending.startedAtMs, error);
    if (error !== undefined) pending.reject(error);
    else pending.resolve();
  }

  #reserveActionBytes(byteLength: number): () => void {
    if (this.#transferredBytes + byteLength > this.#limits.maxActionBytes) {
      throw this.#error('Browser storage transfers exceeded the per-action limit.', 'storage_too_large', false);
    }
    this.#transferredBytes += byteLength;
    let rolledBack = false;
    return () => {
      if (rolledBack) return;
      rolledBack = true;
      this.#transferredBytes -= byteLength;
    };
  }

  #createTimer(onTimeout: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(onTimeout, this.#limits.transferTimeoutMs);
    timer.unref?.();
    return timer;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.catch(() => undefined).then(operation);
    this.#operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertUsable(): void {
    this.#signal.throwIfAborted();
    if (this.#disposed) throw this.#error('Browser storage connection is unavailable.', 'storage_unavailable', true);
  }

  #emitTransfer(direction: 'commit' | 'read', byteLength: number, startedAtMs: number, error?: unknown): void {
    let outcome: Extract<RivetWebAppBrowserStorageRpcEvent, { type: 'transfer' }>['outcome'] = 'completed';
    let retryable = false;
    if (error !== undefined) {
      if (this.#signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        outcome = 'cancelled';
      } else if (error instanceof RivetWebAppBrowserStorageRpcError) {
        retryable = error.retryable;
        outcome =
          error.code === 'storage_capacity'
            ? 'capacity_rejected'
            : error.code === 'storage_too_large'
              ? 'too_large'
              : error.code === 'storage_invalid'
                ? 'invalid'
                : 'unavailable';
      } else {
        outcome = 'unavailable';
      }
    }
    try {
      this.#onEvent?.({
        type: 'transfer',
        byteLength,
        direction,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        outcome,
        retryable,
      });
    } catch {
      // Observability must never alter browser storage semantics.
    }
  }

  #error(message: string, code: RivetWebAppBrowserStorageRpcError['code'], retryable: boolean) {
    return new RivetWebAppBrowserStorageRpcError(message, code, retryable);
  }
}

function expectedChunkCount(byteLength: number): number {
  return byteLength === 0 ? 0 : Math.ceil(byteLength / RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_CHUNK_BYTES);
}

function concatenateChunks(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function cloneOptionalValue(value: RivetStoredValue | undefined): RivetStoredValue | undefined {
  return value === undefined ? undefined : cloneRivetStoredValue(value, 'Browser Stored Value');
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`);
}

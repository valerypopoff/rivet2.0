import {
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTION_BYTES,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_VALUE_BYTES,
  RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_TRANSFER_TIMEOUT_MS,
  RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_CHUNK_BYTES,
  decodeRivetWebAppStorageBinaryFrame,
  deserializeRivetWebAppStoredValuePatch,
  encodeRivetWebAppStorageBinaryFrame,
  serializeRivetWebAppStoredValue,
  splitRivetWebAppStorageTransfer,
  type RivetWebAppBrowserStorageClientMessage,
  type RivetWebAppBrowserStorageRpcAdvertisedLimits,
  type RivetWebAppBrowserStorageServerMessage,
} from '@valerypopoff/rivet2-core/web-app-runtime';
import type { RivetStoredValue, RivetStoredValueRecord } from '@valerypopoff/rivet2-core';

class BrowserStorageClientLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserStorageClientLimitError';
  }
}

export type HostedBrowserStorageBridge = Readonly<{
  clearTransportIncompatibility?(): void;
  commit(patch: RivetStoredValueRecord): Promise<void>;
  get(key: string): Promise<RivetStoredValue | undefined>;
  loadSnapshot(): Promise<RivetStoredValueRecord>;
  reportTransportIncompatibility?(message: string): void;
}>;

type IncomingCommit = {
  byteLength: number;
  chunks: Uint8Array[];
  expectedChunkIndex: number;
  timer: ReturnType<typeof setTimeout>;
  transferId: string;
};

/** Browser-side half of one action's storage RPC. No payload leaves this object except over its owning socket. */
export class WebAppClientStorageRpc {
  readonly #bridge: HostedBrowserStorageBridge;
  readonly #requestId: string;
  readonly #runId: () => string | undefined;
  readonly #sendJson: (message: RivetWebAppBrowserStorageClientMessage) => boolean;
  readonly #sendBinary: (frame: Uint8Array) => boolean;
  readonly #onFatal: (error: Error) => void;
  readonly #limits: RivetWebAppBrowserStorageRpcAdvertisedLimits;
  #incomingCommit: IncomingCommit | undefined;
  #storageSessionId: string | undefined;
  #transferredBytes = 0;
  #disposed = false;

  constructor(options: {
    bridge: HostedBrowserStorageBridge;
    limits?: RivetWebAppBrowserStorageRpcAdvertisedLimits;
    onFatal(error: Error): void;
    requestId: string;
    runId(): string | undefined;
    sendBinary(frame: Uint8Array): boolean;
    sendJson(message: RivetWebAppBrowserStorageClientMessage): boolean;
  }) {
    this.#bridge = options.bridge;
    this.#requestId = options.requestId;
    this.#runId = options.runId;
    this.#sendJson = options.sendJson;
    this.#sendBinary = options.sendBinary;
    this.#onFatal = options.onFatal;
    this.#limits = options.limits ?? {
      maxActionBytes: RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTION_BYTES,
      maxValueBytes: RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_VALUE_BYTES,
      transferTimeoutMs: RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_TRANSFER_TIMEOUT_MS,
    };
    assertPositiveSafeInteger(this.#limits.maxActionBytes, 'maxActionBytes');
    assertPositiveSafeInteger(this.#limits.maxValueBytes, 'maxValueBytes');
    assertPositiveSafeInteger(this.#limits.transferTimeoutMs, 'transferTimeoutMs');
    if (this.#limits.maxValueBytes > this.#limits.maxActionBytes) {
      throw new RangeError('maxValueBytes cannot exceed maxActionBytes.');
    }
  }

  async handleMessage(message: RivetWebAppBrowserStorageServerMessage): Promise<void> {
    const runId = this.#runId();
    if (this.#disposed || !runId || message.requestId !== this.#requestId || message.runId !== runId) return;
    if (this.#storageSessionId && this.#storageSessionId !== message.storageSessionId) {
      return this.#fail('The server sent browser storage data for another action.');
    }
    this.#storageSessionId = message.storageSessionId;
    if (message.type === 'storage.get') {
      await this.#sendValue(message.storageRequestId, message.key);
      return;
    }
    if (message.type === 'storage.commit.start') {
      if (this.#incomingCommit) return this.#fail('The server started overlapping browser storage transfers.');
      if (
        message.byteLength < 1 ||
        message.byteLength > this.#limits.maxActionBytes ||
        message.chunkCount !== expectedChunkCount(message.byteLength)
      ) {
        return this.#fail('The server declared an invalid browser storage commit.');
      }
      try {
        this.#reserveBytes(message.byteLength);
      } catch (error) {
        const failure =
          error instanceof Error
            ? error
            : new BrowserStorageClientLimitError('Browser storage transfer limit exceeded.');
        this.#sendError('storage_too_large', failure.message, false, message.transferId);
        this.#fail(failure.message);
        return;
      }
      this.#incomingCommit = {
        byteLength: message.byteLength,
        chunks: [],
        expectedChunkIndex: 0,
        timer: this.#createTimer(() => {
          this.#sendError('storage_unavailable', 'Browser storage commit timed out.', true, message.transferId);
          this.#fail('Browser storage commit timed out.');
        }),
        transferId: message.transferId,
      };
      return;
    }
    if (message.type === 'storage.error') {
      this.#fail(message.error || 'The server rejected a browser storage transfer.');
    }
  }

  async handleBinary(frame: ArrayBuffer | ArrayBufferView): Promise<boolean> {
    if (this.#disposed) return false;
    const decoded = decodeRivetWebAppStorageBinaryFrame(frame);
    if (!decoded) return false;
    if (!this.#storageSessionId || decoded.storageSessionId !== this.#storageSessionId) return false;
    const incoming = this.#incomingCommit;
    if (!incoming || incoming.transferId !== decoded.transferId) {
      return false;
    }
    const receivedBefore = incoming.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (
      decoded.chunkIndex !== incoming.expectedChunkIndex ||
      decoded.bytes.byteLength > RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_CHUNK_BYTES ||
      receivedBefore + decoded.bytes.byteLength > incoming.byteLength
    ) {
      this.#fail('The server sent missing, out-of-order, or oversized browser storage chunks.');
      return true;
    }
    incoming.chunks.push(decoded.bytes);
    incoming.expectedChunkIndex += 1;
    const received = receivedBefore + decoded.bytes.byteLength;
    if (incoming.expectedChunkIndex === expectedChunkCount(incoming.byteLength)) {
      if (received !== incoming.byteLength) {
        this.#fail('The browser storage commit did not match its declared size.');
        return true;
      }
      try {
        const patch = deserializeRivetWebAppStoredValuePatch(concatenateChunks(incoming.chunks, incoming.byteLength));
        for (const value of Object.values(patch)) {
          if (serializeRivetWebAppStoredValue(value).byteLength > this.#limits.maxValueBytes) {
            throw new BrowserStorageClientLimitError('A browser Stored Value exceeds the supported maximum size.');
          }
        }
        await this.#bridge.commit(patch);
        if (this.#disposed || this.#incomingCommit !== incoming) return true;
        this.#clearIncomingCommit();
        if (
          !this.#sendJson({
            type: 'storage.commit.ack',
            requestId: this.#requestId,
            runId: this.#runId()!,
            storageSessionId: this.#storageSessionId,
            transferId: incoming.transferId,
          })
        ) {
          this.#fail('The browser storage connection closed before commit acknowledgement.');
        }
      } catch (error) {
        if (this.#disposed || this.#incomingCommit !== incoming) return true;
        const isLimitError = error instanceof BrowserStorageClientLimitError;
        const message = isLimitError ? error.message : 'Browser storage could not durably commit this action.';
        this.#clearIncomingCommit();
        this.#sendError(
          isLimitError ? 'storage_too_large' : 'storage_unavailable',
          message,
          !isLimitError,
          incoming.transferId,
        );
        this.#fail(message);
      }
    }
    return true;
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearIncomingCommit();
  }

  async #sendValue(storageRequestId: string, key: string): Promise<void> {
    const runId = this.#runId();
    if (!runId) return;
    try {
      const value = await this.#bridge.get(key);
      const found = value !== undefined;
      const bytes = found ? serializeRivetWebAppStoredValue(value) : new Uint8Array();
      if (bytes.byteLength > this.#limits.maxValueBytes) {
        this.#sendError(
          'storage_too_large',
          'A browser Stored Value exceeds the supported maximum size.',
          false,
          undefined,
          storageRequestId,
        );
        return;
      }
      this.#reserveBytes(bytes.byteLength);
      const transferId = crypto.randomUUID();
      const chunks = splitRivetWebAppStorageTransfer(bytes);
      if (
        !this.#sendJson({
          type: 'storage.transfer.start',
          requestId: this.#requestId,
          runId,
          storageSessionId: this.#storageSessionId!,
          storageRequestId,
          transferId,
          byteLength: bytes.byteLength,
          chunkCount: chunks.length,
          found,
        }) ||
        chunks.some(
          (chunk, index) =>
            !this.#sendBinary(encodeRivetWebAppStorageBinaryFrame(this.#storageSessionId!, transferId, index, chunk)),
        )
      ) {
        this.#fail('The browser storage connection closed during transfer.');
      }
    } catch (error) {
      if (error instanceof BrowserStorageClientLimitError) {
        this.#sendError('storage_too_large', error.message, false, undefined, storageRequestId);
        return;
      }
      this.#sendError(
        'storage_unavailable',
        'Browser storage could not read the requested value.',
        true,
        undefined,
        storageRequestId,
      );
    }
  }

  #reserveBytes(byteLength: number): void {
    if (this.#transferredBytes + byteLength > this.#limits.maxActionBytes) {
      throw new BrowserStorageClientLimitError('Browser storage transfers exceeded the per-action limit.');
    }
    this.#transferredBytes += byteLength;
  }

  #sendError(
    code: Extract<RivetWebAppBrowserStorageClientMessage, { type: 'storage.error' }>['code'],
    error: string,
    retryable: boolean,
    transferId?: string,
    storageRequestId?: string,
  ): void {
    const runId = this.#runId();
    if (!runId) return;
    this.#sendJson({
      type: 'storage.error',
      requestId: this.#requestId,
      runId,
      storageSessionId: this.#storageSessionId!,
      code,
      error,
      retryable,
      ...(transferId ? { transferId } : {}),
      ...(storageRequestId ? { storageRequestId } : {}),
    });
  }

  #fail(message: string): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearIncomingCommit();
    this.#onFatal(new Error(message));
  }

  #clearIncomingCommit(): void {
    const incoming = this.#incomingCommit;
    this.#incomingCommit = undefined;
    if (incoming) clearTimeout(incoming.timer);
  }

  #createTimer(onTimeout: () => void): ReturnType<typeof setTimeout> {
    return setTimeout(onTimeout, this.#limits.transferTimeoutMs);
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

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`);
}

import {
  cloneRivetStoredValue,
  cloneRivetStoredValueRecord,
  type RivetStoredValue,
  type RivetStoredValueRecord,
} from './StoredValueStore.js';

export const RIVET_WEB_APP_BROWSER_STORAGE_RPC_CAPABILITY = 'browser-storage-rpc-v2' as const;
export const RIVET_WEB_APP_BROWSER_STORAGE_RPC_VERSION = 2 as const;
export const RIVET_WEB_APP_BROWSER_STORAGE_SAFE_FALLBACK_BYTES = 4 * 1024 * 1024;
export const RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_VALUE_BYTES = 256 * 1024 * 1024;
export const RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTION_BYTES = 512 * 1024 * 1024;
export const RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_MAX_ACTIVE_BYTES = 512 * 1024 * 1024;
export const RIVET_WEB_APP_BROWSER_STORAGE_DEFAULT_TRANSFER_TIMEOUT_MS = 60_000;
export const RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_CHUNK_BYTES = 256 * 1024;

export const RIVET_WEB_APP_BROWSER_STORAGE_BINARY_FRAME_HEADER_BYTES = 40;
export type RivetWebAppBrowserStorageRpcAdvertisedLimits = Readonly<{
  maxActionBytes: number;
  maxValueBytes: number;
  transferTimeoutMs: number;
}>;

const FRAME_MAGIC = new Uint8Array([0x52, 0x56, 0x42, 0x53]); // RVBS

export type RivetWebAppStorageGetMessage = {
  type: 'storage.get';
  requestId: string;
  runId: string;
  storageSessionId: string;
  storageRequestId: string;
  key: string;
};

export type RivetWebAppStorageTransferStartMessage = {
  type: 'storage.transfer.start';
  requestId: string;
  runId: string;
  storageSessionId: string;
  storageRequestId: string;
  transferId: string;
  byteLength: number;
  chunkCount: number;
  found: boolean;
};

export type RivetWebAppStorageTransferAckMessage = {
  type: 'storage.transfer.ack';
  requestId: string;
  runId: string;
  storageSessionId: string;
  storageRequestId: string;
  transferId: string;
};

export type RivetWebAppStorageCommitStartMessage = {
  type: 'storage.commit.start';
  requestId: string;
  runId: string;
  storageSessionId: string;
  transferId: string;
  byteLength: number;
  chunkCount: number;
};

export type RivetWebAppStorageCommitAckMessage = {
  type: 'storage.commit.ack';
  requestId: string;
  runId: string;
  storageSessionId: string;
  transferId: string;
};

export type RivetWebAppStorageErrorMessage = {
  type: 'storage.error';
  requestId: string;
  runId: string;
  storageSessionId: string;
  storageRequestId?: string;
  transferId?: string;
  code: 'storage_unavailable' | 'storage_invalid' | 'storage_too_large' | 'storage_capacity';
  error: string;
  retryable: boolean;
};

export type RivetWebAppBrowserStorageClientMessage =
  | RivetWebAppStorageTransferStartMessage
  | RivetWebAppStorageCommitAckMessage
  | RivetWebAppStorageErrorMessage;

export type RivetWebAppBrowserStorageServerMessage =
  | RivetWebAppStorageGetMessage
  | RivetWebAppStorageTransferAckMessage
  | RivetWebAppStorageCommitStartMessage
  | RivetWebAppStorageErrorMessage;

export function parseRivetWebAppBrowserStorageClientMessage(
  value: unknown,
): RivetWebAppBrowserStorageClientMessage | undefined {
  if (!isRecord(value) || !hasActionIds(value) || typeof value.type !== 'string') return undefined;
  if (!isUuid(value.storageSessionId)) return undefined;
  if (value.type === 'storage.transfer.start') {
    return isNonEmptyString(value.storageRequestId) &&
      isUuid(value.transferId) &&
      isSafeByteLength(value.byteLength) &&
      isSafeChunkCount(value.chunkCount) &&
      typeof value.found === 'boolean'
      ? {
          type: value.type,
          requestId: value.requestId,
          runId: value.runId,
          storageSessionId: value.storageSessionId,
          storageRequestId: value.storageRequestId,
          transferId: value.transferId,
          byteLength: value.byteLength,
          chunkCount: value.chunkCount,
          found: value.found,
        }
      : undefined;
  }
  if (value.type === 'storage.commit.ack') {
    return isUuid(value.transferId)
      ? {
          type: value.type,
          requestId: value.requestId,
          runId: value.runId,
          storageSessionId: value.storageSessionId,
          transferId: value.transferId,
        }
      : undefined;
  }
  if (value.type === 'storage.error') return parseStorageError(value);
  return undefined;
}

export function parseRivetWebAppBrowserStorageServerMessage(
  value: unknown,
): RivetWebAppBrowserStorageServerMessage | undefined {
  if (!isRecord(value) || !hasActionIds(value) || typeof value.type !== 'string') return undefined;
  if (!isUuid(value.storageSessionId)) return undefined;
  if (value.type === 'storage.get') {
    return isNonEmptyString(value.storageRequestId) && typeof value.key === 'string' && value.key.length > 0
      ? {
          type: value.type,
          requestId: value.requestId,
          runId: value.runId,
          storageSessionId: value.storageSessionId,
          storageRequestId: value.storageRequestId,
          key: value.key,
        }
      : undefined;
  }
  if (value.type === 'storage.transfer.ack') {
    return isNonEmptyString(value.storageRequestId) && isUuid(value.transferId)
      ? {
          type: value.type,
          requestId: value.requestId,
          runId: value.runId,
          storageSessionId: value.storageSessionId,
          storageRequestId: value.storageRequestId,
          transferId: value.transferId,
        }
      : undefined;
  }
  if (value.type === 'storage.commit.start') {
    return isUuid(value.transferId) && isSafeByteLength(value.byteLength) && isSafeChunkCount(value.chunkCount)
      ? {
          type: value.type,
          requestId: value.requestId,
          runId: value.runId,
          storageSessionId: value.storageSessionId,
          transferId: value.transferId,
          byteLength: value.byteLength,
          chunkCount: value.chunkCount,
        }
      : undefined;
  }
  if (value.type === 'storage.error') return parseStorageError(value);
  return undefined;
}

export function serializeRivetWebAppStoredValue(value: RivetStoredValue): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function deserializeRivetWebAppStoredValue(bytes: Uint8Array): RivetStoredValue {
  return cloneRivetStoredValue(JSON.parse(new TextDecoder().decode(bytes)), 'Browser Stored Value transfer');
}

export function serializeRivetWebAppStoredValuePatch(patch: RivetStoredValueRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(patch));
}

export function deserializeRivetWebAppStoredValuePatch(bytes: Uint8Array): RivetStoredValueRecord {
  return cloneRivetStoredValueRecord(
    JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>,
    'Browser Stored Value commit',
  );
}

export function splitRivetWebAppStorageTransfer(bytes: Uint8Array): Uint8Array[] {
  if (bytes.byteLength === 0) return [];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_CHUNK_BYTES) {
    chunks.push(
      bytes.slice(offset, Math.min(bytes.byteLength, offset + RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_CHUNK_BYTES)),
    );
  }
  return chunks;
}

export function encodeRivetWebAppStorageBinaryFrame(
  storageSessionId: string,
  transferId: string,
  chunkIndex: number,
  bytes: Uint8Array,
): Uint8Array {
  const sessionUuid = uuidToBytes(storageSessionId);
  const transferUuid = uuidToBytes(transferId);
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffff_ffff) {
    throw new RangeError('Storage transfer chunk index is invalid.');
  }
  const frame = new Uint8Array(RIVET_WEB_APP_BROWSER_STORAGE_BINARY_FRAME_HEADER_BYTES + bytes.byteLength);
  frame.set(FRAME_MAGIC, 0);
  frame.set(sessionUuid, 4);
  frame.set(transferUuid, 20);
  new DataView(frame.buffer).setUint32(36, chunkIndex, false);
  frame.set(bytes, RIVET_WEB_APP_BROWSER_STORAGE_BINARY_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeRivetWebAppStorageBinaryFrame(
  frame: ArrayBuffer | ArrayBufferView,
): { storageSessionId: string; transferId: string; chunkIndex: number; bytes: Uint8Array } | undefined {
  const source =
    frame instanceof ArrayBuffer
      ? new Uint8Array(frame)
      : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  if (source.byteLength < RIVET_WEB_APP_BROWSER_STORAGE_BINARY_FRAME_HEADER_BYTES) return undefined;
  for (let index = 0; index < FRAME_MAGIC.length; index += 1) {
    if (source[index] !== FRAME_MAGIC[index]) return undefined;
  }
  return {
    storageSessionId: bytesToUuid(source.slice(4, 20)),
    transferId: bytesToUuid(source.slice(20, 36)),
    chunkIndex: new DataView(
      source.buffer,
      source.byteOffset,
      RIVET_WEB_APP_BROWSER_STORAGE_BINARY_FRAME_HEADER_BYTES,
    ).getUint32(36, false),
    bytes: source.slice(RIVET_WEB_APP_BROWSER_STORAGE_BINARY_FRAME_HEADER_BYTES),
  };
}

function parseStorageError(value: Record<string, unknown>): RivetWebAppStorageErrorMessage | undefined {
  return isStorageErrorCode(value.code) && typeof value.error === 'string' && typeof value.retryable === 'boolean'
    ? {
        type: 'storage.error',
        requestId: value.requestId as string,
        runId: value.runId as string,
        storageSessionId: value.storageSessionId as string,
        code: value.code,
        error: value.error,
        retryable: value.retryable,
        ...(isNonEmptyString(value.storageRequestId) ? { storageRequestId: value.storageRequestId } : {}),
        ...(isUuid(value.transferId) ? { transferId: value.transferId } : {}),
      }
    : undefined;
}

function hasActionIds(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { requestId: string; runId: string } {
  return isNonEmptyString(value.requestId) && isNonEmptyString(value.runId);
}
function isStorageErrorCode(value: unknown): value is RivetWebAppStorageErrorMessage['code'] {
  return (
    value === 'storage_unavailable' ||
    value === 'storage_invalid' ||
    value === 'storage_too_large' ||
    value === 'storage_capacity'
  );
}

function isSafeByteLength(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeChunkCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function uuidToBytes(value: string): Uint8Array {
  if (!isUuid(value)) throw new Error('Storage transfer ID must be a UUID.');
  return Uint8Array.from(
    value
      .replaceAll('-', '')
      .match(/.{2}/g)!
      .map((part) => Number.parseInt(part, 16)),
  );
}

function bytesToUuid(value: Uint8Array): string {
  const hex = [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

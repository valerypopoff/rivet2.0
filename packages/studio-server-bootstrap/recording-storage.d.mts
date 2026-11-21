export type RecordingArtifactEncoding = 'identity' | 'gzip' | 'br';
export type RecordingStorageCapabilities = {
  readableEncodings: RecordingArtifactEncoding[];
  writableEncodings: RecordingArtifactEncoding[];
  coordinationProtocol: number;
};
export const DEFAULT_MANAGED_RECORDING_ENCODING: RecordingArtifactEncoding;
export const RECORDING_STORAGE_COORDINATION_PROTOCOL: 1;
export const RECORDING_STORAGE_LOCK: readonly [number, number];
type QueryClient = {
  query(sql: string, values?: readonly number[]): Promise<{ rows: Array<{ acquired?: boolean; released?: boolean }> }>;
};
export function recordingStorageCapabilities(): RecordingStorageCapabilities;
export function acquireRecordingStorageLock(
  client: QueryClient,
  mode: 'shared' | 'exclusive',
): Promise<() => Promise<void>>;
export function assertRecordingPublicationLock(client: QueryClient): Promise<void>;
export function assertRecordingTransactionLock(client: QueryClient, mode: 'shared' | 'exclusive'): Promise<void>;

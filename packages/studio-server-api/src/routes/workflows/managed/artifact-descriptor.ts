import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip, brotliCompress, brotliDecompress, constants } from 'node:zlib';
import type { WorkflowRecordingArtifactEncoding } from '@valerypopoff/rivet-studio-server-shared/workflow-recording-types.js';
import { recordingMemory } from '../recording-memory.js';

export const MAX_MANAGED_ARTIFACT_BYTES = 100 * 1024 * 1024;
export class ManagedArtifactIntegrityError extends Error {}
export class ManagedArtifactSizeError extends Error {}
export type ManagedArtifactDescriptor = {
  key: string;
  encoding: WorkflowRecordingArtifactEncoding;
  hash: string;
  storedBytes: number;
  decodedBytes: number;
};
const zip = promisify(gzip);
const unzip = promisify(gunzip);
const brotli = promisify(brotliCompress);
const unbrotli = promisify(brotliDecompress);
export const RECORDING_BROTLI_QUALITY = 4;
// Covers observed native/transient overhead on 5/32/99 MiB incompressible
// inputs with margin. Decoded/encoded payload reservations remain separate.
const BROTLI_WORKSPACE_BYTES = 32 * 1024 * 1024;

/** The SQL-owned object key carries the expected descriptor. Object metadata
 * cannot redefine the integrity contract by being replaced alongside bytes. */
export function parseManagedArtifactDescriptor(key: string): ManagedArtifactDescriptor | null {
  const match = /\.artifact-v1\.([a-f0-9]{64})\.(\d+)\.(\d+)\.(identity|gzip|br)$/.exec(key);
  if (!match) {
    if (key.includes('.artifact-v1.')) throw new Error('Malformed managed artifact descriptor.');
    return null;
  }
  const storedBytes = Number(match[2]),
    decodedBytes = Number(match[3]);
  if (![storedBytes, decodedBytes].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_MANAGED_ARTIFACT_BYTES))
    throw new ManagedArtifactSizeError('Managed artifact exceeds the supported size.');
  const encoding = match[4] as ManagedArtifactDescriptor['encoding'];
  if (encoding === 'identity' && storedBytes !== decodedBytes) throw new Error('Invalid managed artifact sizes.');
  return { key, encoding, hash: match[1]!, storedBytes, decodedBytes };
}

export async function prepareManagedTextArtifact(
  key: string,
  text: string | Buffer,
  compress: boolean | WorkflowRecordingArtifactEncoding = false,
  level = 6,
) {
  const decoded = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  if (decoded.length > MAX_MANAGED_ARTIFACT_BYTES)
    throw new ManagedArtifactSizeError('Managed artifact exceeds the supported size.');
  const encoding = typeof compress === 'boolean' ? (compress ? 'gzip' : 'identity') : compress;
  if (!['identity', 'gzip', 'br'].includes(encoding)) throw new Error('Unsupported managed artifact encoding.');
  const bytes =
    encoding === 'gzip'
      ? await zip(decoded, { level })
      : encoding === 'br'
        ? await recordingMemory.workspace(BROTLI_WORKSPACE_BYTES, () =>
            brotli(decoded, { params: { [constants.BROTLI_PARAM_QUALITY]: RECORDING_BROTLI_QUALITY } }),
          )
        : decoded;
  const descriptorKey = `${key}.artifact-v1.${createHash('sha256').update(bytes).digest('hex')}.${bytes.length}.${decoded.length}.${encoding}`;
  return { bytes, descriptor: parseManagedArtifactDescriptor(descriptorKey)! };
}

export function verifyManagedArtifactBytes(bytes: Uint8Array, descriptor: ManagedArtifactDescriptor): void {
  const expected = parseManagedArtifactDescriptor(descriptor.key);
  if (
    !expected ||
    expected.hash !== descriptor.hash ||
    expected.encoding !== descriptor.encoding ||
    expected.storedBytes !== descriptor.storedBytes ||
    expected.decodedBytes !== descriptor.decodedBytes
  )
    throw new ManagedArtifactIntegrityError('Managed artifact descriptor differs from its immutable key.');
  if (
    bytes.byteLength !== descriptor.storedBytes ||
    createHash('sha256').update(bytes).digest('hex') !== descriptor.hash
  )
    throw new ManagedArtifactIntegrityError('Managed artifact failed its size or checksum check.');
}

export async function decodeManagedArtifactBytes(
  bytes: Uint8Array,
  descriptor: ManagedArtifactDescriptor | null,
): Promise<Uint8Array> {
  if (bytes.byteLength > MAX_MANAGED_ARTIFACT_BYTES) throw new Error('Managed artifact exceeds the supported size.');
  if (descriptor) verifyManagedArtifactBytes(bytes, descriptor);
  try {
    const decoded =
      descriptor?.encoding === 'gzip'
        ? await unzip(bytes, { maxOutputLength: Math.max(1, descriptor.decodedBytes) })
        : descriptor?.encoding === 'br'
          ? await unbrotli(bytes, { maxOutputLength: Math.max(1, descriptor.decodedBytes) })
          : bytes;
    if (descriptor && decoded.byteLength !== descriptor.decodedBytes)
      throw new Error('Managed artifact decoded size differs.');
    return decoded;
  } catch (error) {
    throw new ManagedArtifactIntegrityError(
      error instanceof Error ? error.message : 'Managed artifact decode failed.',
      {
        cause: error,
      },
    );
  }
}

export async function decodeManagedArtifact(
  bytes: Uint8Array,
  descriptor: ManagedArtifactDescriptor | null,
): Promise<string> {
  const decoded = await decodeManagedArtifactBytes(bytes, descriptor);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch (error) {
    throw new ManagedArtifactIntegrityError('Managed artifact is not valid UTF-8.', { cause: error });
  }
}

import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

export const MAX_MANAGED_ARTIFACT_BYTES = 100 * 1024 * 1024;
export type ManagedArtifactDescriptor = {
  key: string;
  encoding: 'identity' | 'gzip';
  hash: string;
  storedBytes: number;
  decodedBytes: number;
};
const zip = promisify(gzip);
const unzip = promisify(gunzip);

/** The SQL-owned object key carries the expected descriptor. Object metadata
 * cannot redefine the integrity contract by being replaced alongside bytes. */
export function parseManagedArtifactDescriptor(key: string): ManagedArtifactDescriptor | null {
  const match = /\.artifact-v1\.([a-f0-9]{64})\.(\d+)\.(\d+)\.(identity|gzip)$/.exec(key);
  if (!match) {
    if (key.includes('.artifact-v1.')) throw new Error('Malformed managed artifact descriptor.');
    return null;
  }
  const storedBytes = Number(match[2]),
    decodedBytes = Number(match[3]);
  if (![storedBytes, decodedBytes].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_MANAGED_ARTIFACT_BYTES))
    throw new Error('Managed artifact exceeds the supported size.');
  const encoding = match[4] as ManagedArtifactDescriptor['encoding'];
  if (encoding === 'identity' && storedBytes !== decodedBytes) throw new Error('Invalid managed artifact sizes.');
  return { key, encoding, hash: match[1]!, storedBytes, decodedBytes };
}

export async function prepareManagedTextArtifact(key: string, text: string, compress = false, level = 6) {
  const decoded = Buffer.from(text, 'utf8');
  if (decoded.length > MAX_MANAGED_ARTIFACT_BYTES) throw new Error('Managed artifact exceeds the supported size.');
  const bytes = compress ? await zip(decoded, { level }) : decoded;
  const descriptorKey = `${key}.artifact-v1.${createHash('sha256').update(bytes).digest('hex')}.${bytes.length}.${decoded.length}.${compress ? 'gzip' : 'identity'}`;
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
    throw new Error('Managed artifact descriptor differs from its immutable key.');
  if (
    bytes.byteLength !== descriptor.storedBytes ||
    createHash('sha256').update(bytes).digest('hex') !== descriptor.hash
  )
    throw new Error('Managed artifact failed its size or checksum check.');
}

export async function decodeManagedArtifact(
  bytes: Uint8Array,
  descriptor: ManagedArtifactDescriptor | null,
): Promise<string> {
  if (bytes.byteLength > MAX_MANAGED_ARTIFACT_BYTES) throw new Error('Managed artifact exceeds the supported size.');
  if (descriptor) verifyManagedArtifactBytes(bytes, descriptor);
  const decoded =
    descriptor?.encoding === 'gzip'
      ? await unzip(bytes, { maxOutputLength: Math.max(1, descriptor.decodedBytes) })
      : bytes;
  if (descriptor && decoded.byteLength !== descriptor.decodedBytes)
    throw new Error('Managed artifact decoded size differs.');
  return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
}

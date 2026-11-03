import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Leave room below exec's 32 MiB bound for channel framing and exit status.
export const providerPhaseReceiptLimit = 31 * 1024 * 1024;
const phases = new Set(['prepare', 'upgrade', 'autoscaling', 'settle', 'cleanup']);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function filename(phase, workerId) {
  assert.ok(phases.has(phase), 'Unknown receipt phase');
  assert.match(workerId, /^[1-9][0-9]*:[0-9]+$/, 'Invalid receipt worker identity');
  return `${phase}-${workerId.replace(':', '-')}.json`;
}

export function describeProviderPhaseReceipt(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= providerPhaseReceiptLimit);
  return { protocol: 1, bytes: bytes.length, sha256: hash(bytes) };
}

export function assertProviderPhaseReceipt(value) {
  assert.equal(value?.protocol, 1, 'Unknown phase receipt protocol');
  assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= providerPhaseReceiptLimit);
  assert.match(value.sha256, /^[a-f0-9]{64}$/, 'Invalid phase receipt checksum');
  return value;
}

export async function writeProviderPhaseReceipt(directory, phase, workerId, bytes) {
  const name = filename(phase, workerId),
    receipt = describeProviderPhaseReceipt(bytes);
  const folder = path.join(directory, 'phase-receipts');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(folder);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Receipt directory must be a real directory');
  await fs.writeFile(path.join(folder, name), bytes, { flag: 'wx', mode: 0o600 });
  return receipt;
}

export async function readProviderPhaseReceipt(directory, phase, workerId, receipt) {
  const name = filename(phase, workerId);
  assertProviderPhaseReceipt(receipt);
  const folder = path.join(directory, 'phase-receipts'),
    file = path.join(folder, name);
  const parent = await fs.lstat(folder),
    stat = await fs.lstat(file);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink(), 'Receipt directory must be a real directory');
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size === receipt.bytes,
    'Receipt file identity or size changed',
  );
  const bytes = await fs.readFile(file);
  assert.deepEqual(describeProviderPhaseReceipt(bytes), receipt, 'Phase receipt contents changed');
  return bytes;
}

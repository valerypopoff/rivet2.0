import os from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { localSourceBundleLimit } from '../local-metadata/source-budget.js';

const MIB = 1048576;

/** Same conservative decoded-object headroom as local copy capacity, not a process memory guarantee. */
export function selectRestoreSourceBudget(
  resources = {
    availableMemoryBytes: typeof process.availableMemory === 'function' ? process.availableMemory() : os.freemem(),
    heapLimitBytes: getHeapStatistics().heap_size_limit,
  },
  retained?: number,
): number {
  const { availableMemoryBytes, heapLimitBytes } = resources;
  if (![availableMemoryBytes, heapLimitBytes].every((bytes) => Number.isSafeInteger(bytes) && bytes > 0))
    throw new Error('Insufficient restore memory headroom.');
  const capacity = Math.floor((Math.min(availableMemoryBytes, heapLimitBytes) * 0.75 - 64 * MIB) / (8 * MIB));
  const configured = process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB ? localSourceBundleLimit() / MIB : 128;
  const selected = Math.min(128, configured, capacity) * MIB;
  if (retained !== undefined) {
    if (!Number.isSafeInteger(retained) || retained < MIB || retained > selected)
      throw new Error('Insufficient restore memory headroom.');
    return retained;
  }
  if (selected < MIB) throw new Error('Insufficient restore memory headroom.');
  return selected;
}

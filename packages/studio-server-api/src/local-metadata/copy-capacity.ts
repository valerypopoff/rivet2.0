import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { getHeapStatistics } from 'node:v8';
import type { LocalMetadataSourceRoots } from './source-identity.js';
import { localSourceBundleLimit } from './source-budget.js';

/** Disk estimates cover the installation; memory estimates cover one decoded
 * bundle. Exact source readers also enforce this budget while copying. */
export async function inspectLocalCopyCapacity(
  source: LocalMetadataSourceRoots,
  controlRoot: string,
  resources?: {
    availableMemoryBytes: number;
    heapLimitBytes: number;
    freeDiskBytes?: number;
  },
) {
  let payloadBytes = 0,
    operationalBytes = 0;
  let measurementComplete = true;
  const maxPayloadBytes = localSourceBundleLimit();
  const recordingBundles = new Map<string, number>();
  let libraryBytes = 0;
  const add = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid local copy size.');
    payloadBytes += bytes;
    if (!Number.isSafeInteger(payloadBytes)) throw new Error('Local copy size is unsupported.');
  };
  const walk = async (root: string, recording = false): Promise<void> => {
    if (!measurementComplete) return;
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink()) {
      // Runtime package links are checked for confinement by the archive writer.
      return;
    }
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(root)) await walk(path.join(root, name), recording);
      return;
    }
    if (!stat.isFile()) throw new Error('Local source contains an unsupported entry.');
    add(stat.size);
    if (stat.size > maxPayloadBytes) {
      measurementComplete = false;
      return;
    }
    let decodedBytes = stat.size;
    if (recording && root.endsWith('.gz')) {
      // Old bundles lack reliable expanded sizes. Count actual gzip output in
      // bounded chunks before the aggregate importer ever allocates it.
      const input = createReadStream(root);
      const output = createGunzip();
      input.on('error', (error) => output.destroy(error));
      input.pipe(output);
      decodedBytes = 0;
      try {
        for await (const chunk of output) {
          add((chunk as Buffer).length);
          decodedBytes += (chunk as Buffer).length;
          if (decodedBytes > maxPayloadBytes) {
            measurementComplete = false;
            break;
          }
        }
      } finally {
        input.destroy();
        output.destroy();
      }
    }
    if (recording) {
      const directory = path.dirname(root);
      const bytes = (recordingBundles.get(directory) ?? 0) + decodedBytes;
      recordingBundles.set(directory, bytes);
      if (bytes > maxPayloadBytes) measurementComplete = false;
    }
    if (root.startsWith(source.runtimeLibraries + path.sep)) {
      // Tar headers/padding are also bounded; the actual archive is checked
      // before allocating its buffer.
      libraryBytes += stat.size + 1024;
      if (libraryBytes > maxPayloadBytes) measurementComplete = false;
    }
    if (recording && path.basename(root) === 'metadata.json') {
      if (stat.size > 1024 * 1024) throw new Error('Recording metadata exceeds the supported size.');
      const metadata = JSON.parse(await fs.readFile(root, 'utf8')) as Record<string, unknown>;
      for (const name of ['recordingUncompressedBytes', 'projectUncompressedBytes', 'datasetUncompressedBytes']) {
        const value = metadata[name];
        if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0))
          throw new Error('Recording metadata declares an invalid size.');
      }
    }
  };
  await walk(source.workflows);
  await walk(source.recordings, true);
  await walk(source.runtimeLibraries);
  try {
    await walk(path.join(source.appData, 'settings'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const name of ['evaluation-runs.sqlite', 'llm-profile-health.sqlite']) {
    for (const suffix of ['', '-wal', '-journal']) {
      try {
        const stat = await fs.lstat(path.join(source.appData, name + suffix));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid operational database path.');
        operationalBytes += stat.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  const disk = await fs.statfs(controlRoot);
  const freeBytes = resources?.freeDiskBytes ?? disk.bavail * disk.bsize;
  const requiredBytes = 4 * payloadBytes + 2 * operationalBytes + 32 * 1024 * 1024;
  const availableMemoryBytes =
    resources?.availableMemoryBytes ??
    (typeof process.availableMemory === 'function' ? process.availableMemory() : os.freemem());
  const heapLimitBytes = resources?.heapLimitBytes ?? getHeapStatistics().heap_size_limit;
  if ([freeBytes, availableMemoryBytes, heapLimitBytes].some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new Error('Invalid resource capacity measurement.');
  // Conservative headroom, not a measured high-water or a hard process limit.
  // Decoded graphs, duplicate verifier snapshots and archive buffers coexist.
  const estimatedWorkingBytes = 8 * maxPayloadBytes + 64 * 1024 * 1024;
  const memoryBudgetBytes = Math.floor(Math.min(availableMemoryBytes, heapLimitBytes) * 0.75);
  const reasons: Array<'payload-budget' | 'disk-space' | 'memory-headroom'> = [];
  if (!measurementComplete) reasons.push('payload-budget');
  if (freeBytes < requiredBytes) reasons.push('disk-space');
  if (estimatedWorkingBytes > memoryBudgetBytes) reasons.push('memory-headroom');
  return {
    payloadBytes,
    operationalBytes,
    freeBytes,
    requiredBytes,
    maxPayloadBytes,
    estimatedWorkingBytes,
    memoryBudgetBytes,
    measurementComplete,
    reasons,
    fits: reasons.length === 0,
  };
}

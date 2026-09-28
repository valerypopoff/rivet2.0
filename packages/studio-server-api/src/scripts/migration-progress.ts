import fs from 'node:fs/promises';
import path from 'node:path';
import { syncDirectory, syncFileDescriptor } from '../routes/workflows/filesystem-transaction-primitives.js';

export type MigrationProgressEvent = {
  jobId: string;
  domain: 'folder' | 'project' | 'recording' | 'operational-data' | 'runtime-libraries' | 'app-settings';
  id: string;
  sourceHash: string;
};

type ProgressState = {
  offset: number;
  tail: string;
  decoder: TextDecoder;
  items: Set<string>;
  byDomain: Record<string, number>;
  lastItem: { domain: string; id: string } | null;
};

const progressStates = new Map<string, ProgressState>();
const progressReads = new Map<string, Promise<ReturnType<typeof summarizeProgress>>>();
const progressDomains = new Set<MigrationProgressEvent['domain']>([
  'folder',
  'project',
  'recording',
  'operational-data',
  'runtime-libraries',
  'app-settings',
]);

function summarizeProgress(state: ProgressState) {
  return { completed: state.items.size, byDomain: { ...state.byDomain }, lastItem: state.lastItem };
}

/** A progress receipt is not the recovery authority: retries always compare target content. */
export async function recordMigrationProgress(event: Omit<MigrationProgressEvent, 'jobId'>): Promise<void> {
  const filePath = process.env.RIVET_MIGRATION_PROGRESS_PATH;
  const jobId = process.env.RIVET_MIGRATION_PROGRESS_JOB_ID;
  if (!filePath || !jobId) return;
  let created = false;
  const file = await fs
    .open(filePath, 'ax', 0o600)
    .then((handle) => {
      created = true;
      return handle;
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      return fs.open(filePath, 'a', 0o600);
    });
  try {
    await file.writeFile(`${JSON.stringify({ ...event, jobId })}\n`);
    await syncFileDescriptor(file.fd);
    if (created) await syncDirectory(path.dirname(filePath));
  } finally {
    await file.close();
  }
}

export async function readMigrationProgress(
  filePath: string,
  jobId: string,
): Promise<ReturnType<typeof summarizeProgress>> {
  const key = `${filePath}\0${jobId}`;
  const pending = progressReads.get(key);
  if (pending) return pending;
  const read = readProgressIncrementally(filePath, jobId, key);
  progressReads.set(key, read);
  try {
    return await read;
  } finally {
    progressReads.delete(key);
  }
}

async function readProgressIncrementally(
  filePath: string,
  jobId: string,
  key: string,
): Promise<ReturnType<typeof summarizeProgress>> {
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      progressStates.delete(key);
      return { completed: 0, byDomain: {}, lastItem: null };
    }
    throw error;
  }
  let state = progressStates.get(key);
  if (!state || size < state.offset) {
    state = { offset: 0, tail: '', decoder: new TextDecoder(), items: new Set(), byDomain: {}, lastItem: null };
    progressStates.set(key, state);
  }
  if (size === state.offset) return summarizeProgress(state);
  const file = await fs.open(filePath, 'r');
  try {
    while (state.offset < size) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - state.offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, state.offset);
      if (bytesRead === 0) break;
      state.offset += bytesRead;
      const lines = `${state.tail}${state.decoder.decode(buffer.subarray(0, bytesRead), { stream: true })}`.split('\n');
      state.tail = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        let event: MigrationProgressEvent;
        try {
          event = JSON.parse(line) as MigrationProgressEvent;
        } catch {
          // A crash can tear an append. Receipts never authorize an import.
          continue;
        }
        if (
          event.jobId !== jobId ||
          !progressDomains.has(event.domain) ||
          typeof event.id !== 'string' ||
          !event.id ||
          typeof event.sourceHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(event.sourceHash)
        )
          continue;
        const itemKey = `${event.domain}\0${event.id}`;
        if (!state.items.has(itemKey)) {
          state.items.add(itemKey);
          state.byDomain[event.domain] = (state.byDomain[event.domain] ?? 0) + 1;
        }
        state.lastItem = { domain: event.domain, id: event.id };
      }
    }
  } finally {
    await file.close();
  }
  return summarizeProgress(state);
}

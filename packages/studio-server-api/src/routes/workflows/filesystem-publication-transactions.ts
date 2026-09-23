import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadProjectAndAttachedDataFromString } from '@valerypopoff/rivet2-node';

import {
  getWorkflowDatasetPath,
  getWorkflowProjectSettingsPath,
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import { syncDirectory, writeDurableExclusive as writeExclusive } from './filesystem-transaction-primitives.js';

export const FILESYSTEM_PUBLICATION_TRANSACTIONS_DIR = '.rivet-publication-transactions';

const JOURNAL = 'journal.json';
const JOURNAL_STAGED = 'journal.pending';
const COMMITTED = 'committed';
const COMMITTED_STAGED = 'committed.pending';
const VERSION = 1;
const MAX_CLEANUP_ARTIFACTS = 4096;
// New snapshots use UUIDs; older persisted snapshot IDs may be safe tokens.
const SNAPSHOT_FILE = /^[a-z0-9_-]{1,128}(?:\.rivet-project|\.rivet-data|\.json)$/i;
const PROBE_FILE = /^\.probe-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type FileState = { exists: false } | { exists: true; size: number; sha256: string };
type Artifact = {
  path: string;
  old: FileState;
  next: FileState;
};
type Journal = {
  version: typeof VERSION;
  id: string;
  project: string;
  artifacts: Artifact[];
  garbage: Array<{ path: string; state: FileState }>;
};

export type PublicationFileChange = { path: string; contents: string | Buffer | null };
export type PublicationTransactionCheckpoint = 'staged' | 'journal-staged' | 'prepared' | 'backed-up' | 'promoted' | 'validated' | 'marker-staged' | 'committed' | 'cleanup';

/** Only tests use this to simulate a process that vanishes without running catch/finally recovery. */
export class FilesystemPublicationTransactionInterruption extends Error {
  constructor(readonly checkpoint: PublicationTransactionCheckpoint) {
    super(`Simulated publication transaction interruption at ${checkpoint}`);
  }
}

let checkpointHook: ((checkpoint: PublicationTransactionCheckpoint) => void | Promise<void>) | null = null;

export function setFilesystemPublicationTransactionCheckpointForTests(
  hook: ((checkpoint: PublicationTransactionCheckpoint) => void | Promise<void>) | null,
): void {
  checkpointHook = hook;
}

async function checkpoint(value: PublicationTransactionCheckpoint): Promise<void> {
  await checkpointHook?.(value);
}

function transactionRoot(root: string): string {
  return path.join(root, FILESYSTEM_PUBLICATION_TRANSACTIONS_DIR);
}

function relativePath(root: string, target: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Publication artifact must be beneath the workflow root');
  }
  return relative.replace(/\\/g, '/');
}

function canonicalPath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\')) {
    throw new Error('Invalid publication journal path');
  }
  const resolved = path.resolve(root, ...relative.split('/'));
  if (relativePath(root, resolved) !== relative) throw new Error('Publication journal path escapes workflow root');
  return resolved;
}

function assertAllowedPath(root: string, projectPath: string, target: string): void {
  const publishedRoot = path.join(root, '.published');
  if (
    target === projectPath ||
    target === getWorkflowDatasetPath(projectPath) ||
    target === getWorkflowProjectSettingsPath(projectPath)
  ) return;
  if (path.dirname(target) === publishedRoot && SNAPSHOT_FILE.test(path.basename(target))) return;
  throw new Error(`Unexpected publication artifact ${relativePath(root, target)}`);
}

function stateForBytes(bytes: Buffer): FileState {
  return { exists: true, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function readState(filePath: string): Promise<FileState> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) throw new Error(`Publication artifact is not a regular file: ${filePath}`);
    return stateForBytes(await fs.readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

function equalState(left: FileState, right: FileState): boolean {
  return left.exists === right.exists && (!left.exists || (right.exists && left.size === right.size && left.sha256 === right.sha256));
}

async function assertState(filePath: string, expected: FileState): Promise<void> {
  if (!equalState(await readState(filePath), expected)) throw new Error(`Publication artifact checksum mismatch: ${filePath}`);
}

function parseState(value: unknown): FileState {
  if (typeof value !== 'object' || value == null || !('exists' in value)) throw new Error('Invalid publication file state');
  if (value.exists === false) return { exists: false };
  if (
    value.exists !== true || !('size' in value) || !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 || !('sha256' in value) ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
  ) throw new Error('Invalid publication file state');
  return { exists: true, size: value.size as number, sha256: value.sha256 };
}

function parseJournal(root: string, id: string, value: unknown): Journal {
  if (typeof value !== 'object' || value == null) throw new Error('Invalid publication journal');
  const raw = value as Record<string, unknown>;
  if (raw.version !== VERSION || raw.id !== id || typeof raw.project !== 'string' || !Array.isArray(raw.artifacts)) {
    throw new Error('Invalid publication journal header');
  }
  const projectPath = canonicalPath(root, raw.project);
  if (!projectPath.endsWith(PROJECT_EXTENSION) || raw.artifacts.length === 0 || raw.artifacts.length > 64 || !Array.isArray(raw.garbage) || raw.garbage.length > MAX_CLEANUP_ARTIFACTS) {
    throw new Error('Invalid publication journal project or artifact count');
  }
  const seen = new Set<string>();
  const artifacts = raw.artifacts.map((value) => {
    if (typeof value !== 'object' || value == null) throw new Error('Invalid publication journal artifact');
    const artifact = value as Record<string, unknown>;
    if (typeof artifact.path !== 'string' || seen.has(artifact.path)) throw new Error('Duplicate publication artifact');
    seen.add(artifact.path);
    assertAllowedPath(root, projectPath, canonicalPath(root, artifact.path));
    return { path: artifact.path, old: parseState(artifact.old), next: parseState(artifact.next) };
  });
  const garbage = raw.garbage.map((value) => {
    if (typeof value !== 'object' || value == null) throw new Error('Invalid publication cleanup artifact');
    const item = value as Record<string, unknown>;
    if (typeof item.path !== 'string' || seen.has(item.path)) throw new Error('Duplicate publication cleanup artifact');
    seen.add(item.path);
    const target = canonicalPath(root, item.path);
    if (path.dirname(target) !== path.join(root, '.published') || !SNAPSHOT_FILE.test(path.basename(target))) {
      throw new Error('Publication cleanup may only remove frozen snapshot artifacts');
    }
    return { path: item.path, state: parseState(item.state) };
  });
  return { version: VERSION, id, project: raw.project, artifacts, garbage };
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function ensureSafeParent(root: string, filePath: string): Promise<void> {
  const rootPath = path.resolve(root);
  const parentPath = path.dirname(filePath);
  relativePath(rootPath, filePath);
  await fs.mkdir(rootPath, { recursive: true });
  const [realRoot, rootStat] = await Promise.all([fs.realpath(rootPath), fs.stat(rootPath)]);
  let current = rootPath;
  for (const segment of path.relative(rootPath, parentPath).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await fs.lstat(current);
    const realCurrent = await fs.realpath(current);
    const relative = path.relative(realRoot, realCurrent);
    if (
      !stat.isDirectory() || stat.isSymbolicLink() || relative.startsWith('..') ||
      path.isAbsolute(relative) || stat.dev !== rootStat.dev
    ) throw new Error('Publication artifacts and journal must remain on the workflow filesystem');
  }
}

function stagedPath(transactionPath: string, index: number): string { return path.join(transactionPath, `${index}.new`); }
function backupPath(transactionPath: string, index: number): string { return path.join(transactionPath, `${index}.old`); }

async function validateContents(filePath: string, canonicalFilePath = filePath): Promise<void> {
  // Dataset sidecars are copied byte-for-byte; the checksum is their validation.
  if (canonicalFilePath.endsWith('.rivet-data')) return;
  const contents = await fs.readFile(filePath, 'utf8');
  if (canonicalFilePath.endsWith(PROJECT_EXTENSION)) loadProjectAndAttachedDataFromString(contents);
  else {
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid publication JSON object');
  }
}

async function verifyArtifacts(root: string, journal: Journal, generation: 'old' | 'next'): Promise<void> {
  for (const artifact of journal.artifacts) {
    const target = canonicalPath(root, artifact.path);
    await ensureSafeParent(root, target);
    await assertState(target, artifact[generation]);
    if (artifact[generation].exists) await validateContents(target);
  }
}

async function restoreOld(root: string, transactionPath: string, journal: Journal): Promise<void> {
  for (let index = journal.artifacts.length - 1; index >= 0; index--) {
    const artifact = journal.artifacts[index]!;
    const target = canonicalPath(root, artifact.path);
    await ensureSafeParent(root, target);
    const backup = backupPath(transactionPath, index);
    const backupState = await readState(backup);
    const current = await readState(target);
    if (backupState.exists) {
      if (!artifact.old.exists || !equalState(backupState, artifact.old)) throw new Error(`Invalid publication backup ${artifact.path}`);
      if (current.exists) {
        if (!equalState(current, artifact.next) && !equalState(current, artifact.old)) throw new Error(`Unrecognized publication artifact ${artifact.path}`);
        await fs.unlink(target);
      }
      await fs.rename(backup, target);
      await syncDirectory(path.dirname(target));
      await syncDirectory(transactionPath);
    } else if (artifact.old.exists) {
      if (!equalState(current, artifact.old)) throw new Error(`Missing publication backup ${artifact.path}`);
    } else if (current.exists) {
      if (!equalState(current, artifact.next)) throw new Error(`Unrecognized new publication artifact ${artifact.path}`);
      await fs.unlink(target);
      await syncDirectory(path.dirname(target));
    }
  }
  await verifyArtifacts(root, journal, 'old');
}

async function cleanup(transactionPath: string, journal: Journal | null): Promise<void> {
  const allowed = new Set(journal ? [JOURNAL, COMMITTED, JOURNAL_STAGED, COMMITTED_STAGED] : [JOURNAL_STAGED]);
  for (let index = 0; index < (journal?.artifacts.length ?? 64); index++) {
    const staged = stagedPath(transactionPath, index);
    const backup = backupPath(transactionPath, index);
    allowed.add(path.basename(staged));
    if (journal) allowed.add(path.basename(backup));
  }
  if (!(await fs.readdir(transactionPath)).every((entry) => allowed.has(entry))) {
    throw new Error('Unexpected publication recovery evidence');
  }
  await unlinkIfPresent(path.join(transactionPath, JOURNAL_STAGED));
  await unlinkIfPresent(path.join(transactionPath, COMMITTED_STAGED));
  for (let index = 0; index < (journal?.artifacts.length ?? 64); index++) {
    const staged = stagedPath(transactionPath, index);
    const backup = backupPath(transactionPath, index);
    await unlinkIfPresent(staged);
    if (journal) {
      const backupState = await readState(backup);
      if (backupState.exists && !equalState(backupState, journal.artifacts[index]!.old)) {
        throw new Error(`Invalid publication backup ${journal.artifacts[index]!.path}`);
      }
      await unlinkIfPresent(backup);
    }
  }
  const remaining = await fs.readdir(transactionPath);
  if (!remaining.every((entry) => allowed.has(entry) && (entry === JOURNAL || entry === COMMITTED))) {
    throw new Error('Unexpected publication recovery evidence');
  }
  await unlinkIfPresent(path.join(transactionPath, JOURNAL));
  await syncDirectory(transactionPath);
  await unlinkIfPresent(path.join(transactionPath, COMMITTED));
  await syncDirectory(transactionPath);
  await fs.rmdir(transactionPath);
}

async function cleanupCommittedGarbage(root: string, journal: Journal): Promise<void> {
  for (const item of journal.garbage) {
    const target = canonicalPath(root, item.path);
    await ensureSafeParent(root, target);
    const current = await readState(target);
    if (!current.exists) continue;
    if (!equalState(current, item.state)) throw new Error(`Changed publication cleanup artifact ${item.path}`);
    await fs.unlink(target);
    await syncDirectory(path.dirname(target));
  }
}

async function readJournal(root: string, id: string, filePath: string): Promise<Journal> {
  return parseJournal(root, id, JSON.parse(await fs.readFile(filePath, 'utf8')));
}

async function recoverDirectory(root: string, transactionPath: string): Promise<boolean> {
  const id = path.basename(transactionPath);
  const journalPath = path.join(transactionPath, JOURNAL);
  const committedPath = path.join(transactionPath, COMMITTED);
  const [journalExists, markerExists] = await Promise.all([readState(journalPath), readState(committedPath)]);
  if (!journalExists.exists && !markerExists.exists) {
    const entries = await fs.readdir(transactionPath);
    if (!entries.every((entry) => entry === JOURNAL_STAGED || (/^\d+\.new$/.test(entry) && Number(entry.slice(0, -4)) < 64))) {
      throw new Error(`Unprepared publication transaction ${id} contains unexpected evidence`);
    }
    await cleanup(transactionPath, null);
    return false;
  }
  const journal = journalExists.exists
    ? await readJournal(root, id, journalPath)
    : await readJournal(root, id, committedPath);
  try {
    if (markerExists.exists) {
      const marker = await readJournal(root, id, committedPath);
      if (JSON.stringify(marker) !== JSON.stringify(journal)) throw new Error('Publication commit marker differs from journal');
      await verifyArtifacts(root, journal, 'next');
    } else {
      await restoreOld(root, transactionPath, journal);
    }
  } catch (error) {
    throw new Error(`Project ${journal.project}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  try {
    if (markerExists.exists) await cleanupCommittedGarbage(root, journal);
    await cleanup(transactionPath, journal);
    return false;
  } catch (error) {
    console.error(`[workflow-storage] Publication transaction ${id} (${journal.project}) cleanup deferred:`, error);
    return true;
  }
}

export async function recoverFilesystemPublicationTransactions(root: string): Promise<boolean> {
  let entries: string[];
  const transactionsPath = transactionRoot(root);
  try {
    await ensureSafeParent(root, path.join(transactionsPath, 'probe'));
    entries = await fs.readdir(transactionsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let pending = false;
  const transactionDevice = (await fs.stat(transactionsPath)).dev;
  for (const id of entries) {
    if (PROBE_FILE.test(id)) {
      await unlinkIfPresent(path.join(transactionsPath, id));
      continue;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`Unexpected publication transaction entry ${id}`);
    }
    const transactionPath = path.join(transactionsPath, id);
    try {
      const stat = await fs.lstat(transactionPath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== transactionDevice) {
        throw new Error('Publication transaction is not a same-filesystem directory');
      }
      pending = (await recoverDirectory(root, transactionPath)) || pending;
    } catch (error) {
      throw new Error(`Publication transaction ${id} recovery failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return pending;
}

export async function probeFilesystemPublicationStorage(root: string): Promise<void> {
  await ensureSafeParent(root, path.join(transactionRoot(root), 'probe'));
  const publishedRoot = path.join(root, '.published');
  await ensureSafeParent(root, path.join(publishedRoot, 'probe'));
  // The journal and snapshot directories may have been created on this boot.
  // Their names must survive a crash before either directory can hold a
  // committed publication generation.
  await syncDirectory(root);
  for (const entry of await fs.readdir(publishedRoot)) {
    if (PROBE_FILE.test(entry)) await unlinkIfPresent(path.join(publishedRoot, entry));
  }
  const probe = path.join(transactionRoot(root), `.probe-${randomUUID()}`);
  const renamed = path.join(publishedRoot, path.basename(probe));
  try {
    await writeExclusive(probe, 'publication-probe');
    await fs.rename(probe, renamed);
    await syncDirectory(transactionRoot(root));
    await syncDirectory(publishedRoot);
    if (await fs.readFile(renamed, 'utf8') !== 'publication-probe') throw new Error('Publication storage rename probe failed');
  } finally {
    await unlinkIfPresent(probe);
    await unlinkIfPresent(renamed);
  }
}

export async function saveFilesystemPublicationTransaction(options: {
  root: string;
  projectPath: string;
  changes: PublicationFileChange[];
  cleanupPaths?: string[];
}): Promise<void> {
  const root = path.resolve(options.root);
  const projectPath = path.resolve(options.projectPath);
  if (!projectPath.endsWith(PROJECT_EXTENSION) || options.changes.length === 0 || options.changes.length > 64) {
    throw new Error('Invalid publication transaction');
  }
  const changes = options.changes.map((change) => ({ ...change, path: path.resolve(change.path) }));
  const seen = new Set<string>();
  for (const change of changes) {
    assertAllowedPath(root, projectPath, change.path);
    if (seen.has(change.path)) throw new Error('Duplicate publication transaction artifact');
    seen.add(change.path);
    await ensureSafeParent(root, change.path);
  }
  const cleanupPaths = [...new Set((options.cleanupPaths ?? []).map((filePath) => path.resolve(filePath)))];
  if (cleanupPaths.length > MAX_CLEANUP_ARTIFACTS) throw new Error('Too many publication cleanup artifacts');
  for (const cleanupPath of cleanupPaths) {
    if (seen.has(cleanupPath) || path.dirname(cleanupPath) !== path.join(root, '.published') || !SNAPSHOT_FILE.test(path.basename(cleanupPath))) {
      throw new Error('Invalid publication cleanup artifact');
    }
    await ensureSafeParent(root, cleanupPath);
  }
  await ensureSafeParent(root, path.join(transactionRoot(root), 'probe'));
  await syncDirectory(root);
  if (await recoverFilesystemPublicationTransactions(root)) {
    throw new Error('A previous publication is awaiting transaction cleanup. Retry shortly.');
  }
  const id = randomUUID();
  const transactionPath = path.join(transactionRoot(root), id);
  await fs.mkdir(transactionPath);
  await syncDirectory(transactionRoot(root));
  let markerWritten = false;
  let committed = false;
  try {
    const artifacts: Artifact[] = [];
    for (const [index, change] of changes.entries()) {
      const old = await readState(change.path);
      const bytes = change.contents == null ? null : Buffer.from(change.contents);
      if (bytes) {
        await writeExclusive(stagedPath(transactionPath, index), bytes);
        await validateContents(stagedPath(transactionPath, index), change.path);
      }
      artifacts.push({ path: relativePath(root, change.path), old, next: bytes ? stateForBytes(bytes) : { exists: false } });
      await checkpoint('staged');
    }
    const garbage = await Promise.all(cleanupPaths.map(async (filePath) => ({
      path: relativePath(root, filePath), state: await readState(filePath),
    })));
    const journal: Journal = { version: VERSION, id, project: relativePath(root, projectPath), artifacts, garbage };
    await writeExclusive(path.join(transactionPath, JOURNAL_STAGED), `${JSON.stringify(journal)}\n`);
    await checkpoint('journal-staged');
    await fs.rename(path.join(transactionPath, JOURNAL_STAGED), path.join(transactionPath, JOURNAL));
    await syncDirectory(transactionPath);
    await checkpoint('prepared');
    for (const [index, artifact] of artifacts.entries()) {
      const target = canonicalPath(root, artifact.path);
      if (artifact.old.exists) {
        await assertState(target, artifact.old);
        await fs.rename(target, backupPath(transactionPath, index));
        await syncDirectory(path.dirname(target));
        await syncDirectory(transactionPath);
      }
      await checkpoint('backed-up');
      if (artifact.next.exists) {
        await fs.rename(stagedPath(transactionPath, index), target);
        await syncDirectory(path.dirname(target));
        await syncDirectory(transactionPath);
      }
      await checkpoint('promoted');
    }
    await verifyArtifacts(root, journal, 'next');
    await checkpoint('validated');
    await writeExclusive(path.join(transactionPath, COMMITTED_STAGED), `${JSON.stringify(journal)}\n`);
    await checkpoint('marker-staged');
    await fs.rename(path.join(transactionPath, COMMITTED_STAGED), path.join(transactionPath, COMMITTED));
    markerWritten = true;
    await syncDirectory(transactionPath);
    committed = true;
    await checkpoint('committed');
    await checkpoint('cleanup');
    await cleanupCommittedGarbage(root, journal);
    await cleanup(transactionPath, journal);
  } catch (error) {
    if (error instanceof FilesystemPublicationTransactionInterruption) throw error;
    if (committed) {
      console.error(`[workflow-storage] Committed publication ${id} cleanup deferred:`, error);
      return;
    }
    if (markerWritten) throw new Error(`Publication ${id} has an uncertain commit marker; recovery is required`, { cause: error });
    try {
      await recoverDirectory(root, transactionPath);
    } catch (recoveryError) {
      throw new Error(`Publication ${id} rollback failed; recovery is required`, { cause: recoveryError });
    }
    throw error;
  }
}

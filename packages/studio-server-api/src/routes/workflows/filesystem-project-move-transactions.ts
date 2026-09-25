import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadProjectAndAttachedDataFromString } from '@valerypopoff/rivet2-node';

import { conflict, createHttpError } from '../../utils/httpError.js';
import {
  getProjectSidecarPaths,
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import { syncDirectory, writeDurableExclusive as writeExclusive } from './filesystem-transaction-primitives.js';
import { normalizeStoredWorkflowProjectSettings } from './publication.js';

export const FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR = '.rivet-move-transactions';

const VERSION = 1;
const JOURNAL = 'journal.json';
const JOURNAL_PENDING = 'journal.pending';
const COMMITTED = 'committed';
const COMMITTED_PENDING = 'committed.pending';
const KINDS = ['project', 'dataset', 'settings', 'stats'] as const;
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROBE = /^\.probe-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.renamed)?$/i;

type Kind = typeof KINDS[number];
type FileState = { exists: false } | { exists: true; size: number; sha256: string };
type MoveFile = { kind: Kind; old: FileState; next: FileState };
type MoveJournal = {
  version: typeof VERSION;
  id: string;
  source: string;
  target: string;
  projectId: string;
  caseOnly: boolean;
  files: MoveFile[];
};

export type FilesystemProjectMoveCheckpoint =
  | 'staged' | 'journal-staged' | 'prepared' | 'backed-up'
  | 'promoted' | 'validated' | 'marker-staged' | 'marker-renamed' | 'committed' | 'cleanup';

/** Test-only simulation of a hard stop, without the normal error rollback. */
export class FilesystemProjectMoveInterruption extends Error {
  constructor(readonly checkpoint: FilesystemProjectMoveCheckpoint) {
    super(`Simulated project move interruption at ${checkpoint}`);
  }
}

export class FilesystemProjectMoveCommitUncertainError extends Error {
  constructor(readonly transactionId: string, readonly sourceProjectPath: string, cause: unknown) {
    super(`Project move ${transactionId} has an uncertain commit marker; recovery is required`, { cause });
  }
}

let checkpointHook: ((checkpoint: FilesystemProjectMoveCheckpoint) => void | Promise<void>) | null = null;

export function setFilesystemProjectMoveCheckpointForTests(
  hook: ((checkpoint: FilesystemProjectMoveCheckpoint) => void | Promise<void>) | null,
): void {
  checkpointHook = hook;
}

async function checkpoint(value: FilesystemProjectMoveCheckpoint): Promise<void> {
  await checkpointHook?.(value);
}

function moveRoot(root: string): string {
  return path.join(root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR);
}

function relativePath(root: string, target: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Project move path must remain beneath the workflow root');
  }
  return relative.replace(/\\/g, '/');
}

function canonicalPath(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || path.isAbsolute(relative) ||
    relative.split('/').some((segment) => !segment || segment.startsWith('.') || segment === '..')) {
    throw new Error('Invalid project move journal path');
  }
  const resolved = path.resolve(root, ...relative.split('/'));
  if (relativePath(root, resolved) !== relative) throw new Error('Project move journal path escapes workflow root');
  return resolved;
}

function artifactPath(projectPath: string, kind: Kind): string {
  const sidecars = getProjectSidecarPaths(projectPath);
  return kind === 'project' ? projectPath : sidecars[kind];
}

function stagedPath(transactionPath: string, kind: Kind): string { return path.join(transactionPath, `${kind}.new`); }
function backupPath(transactionPath: string, kind: Kind): string { return path.join(transactionPath, `${kind}.old`); }

function stateForBytes(bytes: Buffer): FileState {
  return { exists: true, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function sameState(left: FileState, right: FileState): boolean {
  return left.exists === right.exists && (!left.exists || (right.exists && left.size === right.size && left.sha256 === right.sha256));
}

async function hasExactEntry(filePath: string): Promise<boolean> {
  try {
    return (await fs.readdir(path.dirname(filePath))).includes(path.basename(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readState(filePath: string, exact = false): Promise<FileState> {
  if (exact && !await hasExactEntry(filePath)) return { exists: false };
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Move artifact is not a regular file: ${filePath}`);
    return stateForBytes(await fs.readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

async function readSourceArtifact(filePath: string, rootDevice: number): Promise<{
  state: FileState;
  bytes?: Buffer;
  mode?: number;
}> {
  if (!await hasExactEntry(filePath)) return { state: { exists: false } };
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== rootDevice) {
    throw new Error(`Project move source must be a regular file on the workflow filesystem: ${filePath}`);
  }
  const bytes = await fs.readFile(filePath);
  return { state: stateForBytes(bytes), bytes, mode: stat.mode };
}

async function assertState(filePath: string, expected: FileState, exact = false): Promise<void> {
  if (!sameState(await readState(filePath, exact), expected)) throw new Error(`Project move checksum mismatch: ${filePath}`);
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function assertSafeParent(root: string, filePath: string): Promise<void> {
  const rootPath = path.resolve(root);
  const parent = path.dirname(filePath);
  relativePath(rootPath, filePath);
  const [realRoot, rootStat] = await Promise.all([fs.realpath(rootPath), fs.stat(rootPath)]);
  let current = rootPath;
  for (const segment of path.relative(rootPath, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    const realCurrent = await fs.realpath(current);
    const relative = path.relative(realRoot, realCurrent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative) || stat.dev !== rootStat.dev) {
      throw new Error('Project, sidecars, and move journal must remain on the workflow filesystem');
    }
  }
}

function parseState(value: unknown): FileState {
  if (typeof value !== 'object' || value == null || !('exists' in value)) throw new Error('Invalid move artifact state');
  if (value.exists === false) return { exists: false };
  if (value.exists !== true || !('size' in value) || !Number.isSafeInteger(value.size) || (value.size as number) < 0 ||
    !('sha256' in value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('Invalid move artifact state');
  }
  return { exists: true, size: value.size as number, sha256: value.sha256 };
}

function parseJournal(root: string, id: string, value: unknown): MoveJournal {
  if (typeof value !== 'object' || value == null) throw new Error('Invalid project move journal');
  const raw = value as Record<string, unknown>;
  if (raw.version !== VERSION || raw.id !== id || typeof raw.source !== 'string' || typeof raw.target !== 'string' ||
    typeof raw.projectId !== 'string' || typeof raw.caseOnly !== 'boolean' || !Array.isArray(raw.files) || raw.files.length !== KINDS.length) {
    throw new Error('Invalid project move journal header');
  }
  const source = canonicalPath(root, raw.source);
  const target = canonicalPath(root, raw.target);
  if (!source.endsWith(PROJECT_EXTENSION) || !target.endsWith(PROJECT_EXTENSION) || source === target ||
    (raw.caseOnly && (path.dirname(source) !== path.dirname(target) || source.toLowerCase() !== target.toLowerCase()))) {
    throw new Error('Invalid project move journal paths');
  }
  const files = raw.files.map((value, index) => {
    if (typeof value !== 'object' || value == null) throw new Error('Invalid project move artifact');
    const file = value as Record<string, unknown>;
    if (file.kind !== KINDS[index]) throw new Error('Unexpected project move artifact');
    const old = parseState(file.old);
    const next = parseState(file.next);
    if (!sameState(next, file.kind === 'stats' ? { exists: false } : old)) throw new Error('Invalid project move target state');
    if (file.kind === 'project' && !old.exists) throw new Error('Project move source is missing');
    return { kind: file.kind as Kind, old, next };
  });
  return { version: VERSION, id, source: raw.source, target: raw.target, projectId: raw.projectId, caseOnly: raw.caseOnly, files };
}

async function readJournal(root: string, id: string, filePath: string): Promise<MoveJournal> {
  return parseJournal(root, id, JSON.parse(await fs.readFile(filePath, 'utf8')));
}

async function validateProjectAndSettings(projectPath: string, projectId: string): Promise<void> {
  const [project] = loadProjectAndAttachedDataFromString(await fs.readFile(projectPath, 'utf8'));
  if (String(project.metadata.id ?? '') !== projectId) throw new Error('Moved project identity changed');
  const settingsPath = getProjectSidecarPaths(projectPath).settings;
  if (await hasExactEntry(settingsPath)) normalizeStoredWorkflowProjectSettings(JSON.parse(await fs.readFile(settingsPath, 'utf8')));
}

async function verifyGeneration(
  root: string,
  journal: MoveJournal,
  generation: 'old' | 'next',
  allowRebuiltStats = false,
): Promise<void> {
  const source = canonicalPath(root, journal.source);
  const target = canonicalPath(root, journal.target);
  await assertSafeParent(root, source);
  await assertSafeParent(root, target);
  for (const file of journal.files) {
    await assertState(artifactPath(source, file.kind), generation === 'old' ? file.old : { exists: false }, true);
    const targetPath = artifactPath(target, file.kind);
    if (generation === 'next' && file.kind === 'stats' && allowRebuiltStats) {
      // A successful move may rebuild this derived cache while committed
      // journal cleanup is deferred. It is not part of the saved generation.
      await readState(targetPath, true);
    } else {
      await assertState(targetPath, generation === 'old' ? { exists: false } : file.next, true);
    }
  }
  await validateProjectAndSettings(generation === 'old' ? source : target, journal.projectId);
}

async function restoreOld(root: string, transactionPath: string, journal: MoveJournal): Promise<void> {
  const source = canonicalPath(root, journal.source);
  const target = canonicalPath(root, journal.target);
  // Prove every remaining artifact before changing any canonical path. A late
  // corrupt backup must not cause an earlier, valid promoted file to be lost.
  for (const file of journal.files) {
    const sourceState = await readState(artifactPath(source, file.kind), true);
    const targetState = await readState(artifactPath(target, file.kind), true);
    const backupState = await readState(backupPath(transactionPath, file.kind));
    if (sourceState.exists && (!sameState(sourceState, file.old) || backupState.exists)) {
      throw new Error(`Unrecognized move source ${file.kind}`);
    }
    if (targetState.exists && !sameState(targetState, file.next)) throw new Error(`Unrecognized move target ${file.kind}`);
    if (backupState.exists && !sameState(backupState, file.old)) throw new Error(`Invalid move backup ${file.kind}`);
    if (file.old.exists && !sourceState.exists && !backupState.exists) throw new Error(`Missing move source and backup ${file.kind}`);
  }
  for (const file of [...journal.files].reverse()) {
    const sourcePath = artifactPath(source, file.kind);
    const targetPath = artifactPath(target, file.kind);
    const currentTarget = await readState(targetPath, true);
    if (currentTarget.exists) {
      if (!sameState(currentTarget, file.next)) throw new Error(`Unrecognized move target ${file.kind}`);
      await fs.unlink(targetPath);
      await syncDirectory(path.dirname(targetPath));
    }
    const backup = backupPath(transactionPath, file.kind);
    const backupState = await readState(backup);
    if (backupState.exists) {
      if (!sameState(backupState, file.old) || await hasExactEntry(sourcePath)) throw new Error(`Invalid move backup ${file.kind}`);
      await fs.rename(backup, sourcePath);
      await syncDirectory(path.dirname(sourcePath));
      await syncDirectory(transactionPath);
    } else {
      await assertState(sourcePath, file.old, true);
    }
  }
  await verifyGeneration(root, journal, 'old');
}

async function validateCleanupEvidence(transactionPath: string, journal: MoveJournal | null): Promise<void> {
  const allowed = new Set([JOURNAL_PENDING, COMMITTED_PENDING]);
  if (journal) {
    allowed.add(JOURNAL);
    allowed.add(COMMITTED);
  }
  for (const kind of KINDS) {
    allowed.add(`${kind}.new`);
    if (journal) allowed.add(`${kind}.old`);
  }
  if (!(await fs.readdir(transactionPath)).every((entry) => allowed.has(entry))) throw new Error('Unexpected project move recovery evidence');
  if (journal) {
    for (const file of journal.files) {
      const backup = await readState(backupPath(transactionPath, file.kind));
      if (backup.exists && !sameState(backup, file.old)) throw new Error(`Invalid project move backup ${file.kind}`);
    }
  }
}

async function cleanup(transactionPath: string, journal: MoveJournal | null): Promise<void> {
  await unlinkIfPresent(path.join(transactionPath, JOURNAL_PENDING));
  await unlinkIfPresent(path.join(transactionPath, COMMITTED_PENDING));
  for (const kind of KINDS) {
    await unlinkIfPresent(stagedPath(transactionPath, kind));
    if (journal) await unlinkIfPresent(backupPath(transactionPath, kind));
  }
  await unlinkIfPresent(path.join(transactionPath, JOURNAL));
  await syncDirectory(transactionPath);
  await unlinkIfPresent(path.join(transactionPath, COMMITTED));
  await syncDirectory(transactionPath);
  await fs.rmdir(transactionPath);
}

async function recoverDirectory(root: string, transactionPath: string): Promise<boolean> {
  const id = path.basename(transactionPath);
  const journalPath = path.join(transactionPath, JOURNAL);
  const markerPath = path.join(transactionPath, COMMITTED);
  const journalState = await readState(journalPath);
  const markerState = await readState(markerPath);
  if (!journalState.exists && !markerState.exists) {
    await validateCleanupEvidence(transactionPath, null);
    await cleanup(transactionPath, null);
    return false;
  }
  const journal = await readJournal(root, id, journalState.exists ? journalPath : markerPath);
  try {
    if (markerState.exists) {
      const marker = await readJournal(root, id, markerPath);
      if (JSON.stringify(marker) !== JSON.stringify(journal)) throw new Error('Project move marker differs from journal');
      await verifyGeneration(root, journal, 'next', true);
    } else {
      await restoreOld(root, transactionPath, journal);
    }
    await validateCleanupEvidence(transactionPath, journal);
  } catch (error) {
    throw new Error(`Project ${journal.source} -> ${journal.target}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  try {
    await cleanup(transactionPath, journal);
    return false;
  } catch (error) {
    console.error(`[workflow-storage] Project move transaction ${id} (${journal.source} -> ${journal.target}) cleanup deferred:`, error);
    return true;
  }
}

export async function recoverFilesystemProjectMoveTransactions(root: string): Promise<boolean> {
  const directory = moveRoot(root);
  let entries: string[];
  try {
    await assertSafeParent(root, path.join(directory, 'probe'));
    entries = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const device = (await fs.stat(directory)).dev;
  let pending = false;
  for (const id of entries) {
    if (PROBE.test(id)) {
      await unlinkIfPresent(path.join(directory, id));
      continue;
    }
    if (!TRANSACTION_ID.test(id)) throw new Error(`Unexpected project move transaction entry ${id}`);
    const transactionPath = path.join(directory, id);
    try {
      const stat = await fs.lstat(transactionPath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== device) throw new Error('Move transaction is not a same-filesystem directory');
      pending = (await recoverDirectory(root, transactionPath)) || pending;
    } catch (error) {
      throw new Error(`Project move transaction ${id} recovery failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return pending;
}

export async function probeFilesystemProjectMoveStorage(root: string): Promise<void> {
  const directory = moveRoot(root);
  await fs.mkdir(directory, { recursive: true });
  await assertSafeParent(root, path.join(directory, 'probe'));
  await syncDirectory(root);
  const probe = path.join(directory, `.probe-${randomUUID()}`);
  const renamed = `${probe}.renamed`;
  try {
    await writeExclusive(probe, 'move-probe');
    await fs.rename(probe, renamed);
    await syncDirectory(directory);
    if (await fs.readFile(renamed, 'utf8') !== 'move-probe') throw new Error('Project move storage rename probe failed');
  } finally {
    await unlinkIfPresent(probe);
    await unlinkIfPresent(renamed);
  }
}

export async function moveProjectWithSidecars(root: string, sourceProjectPath: string, targetProjectPath: string): Promise<void> {
  const source = path.resolve(sourceProjectPath);
  const target = path.resolve(targetProjectPath);
  if (!source.endsWith(PROJECT_EXTENSION) || !target.endsWith(PROJECT_EXTENSION) || source === target) {
    throw new Error('Invalid project move');
  }
  await assertSafeParent(root, source);
  await assertSafeParent(root, target);
  await fs.mkdir(moveRoot(root), { recursive: true });
  await assertSafeParent(root, path.join(moveRoot(root), 'probe'));
  await syncDirectory(root);
  const rootDevice = (await fs.stat(root)).dev;

  const sourceStat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw createHttpError(404, 'Project not found');
    throw error;
  });
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !await hasExactEntry(source)) throw createHttpError(404, 'Project not found');
  const targetStat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const caseOnly = !!targetStat && path.dirname(source) === path.dirname(target) && source.toLowerCase() === target.toLowerCase() &&
    targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino;
  if (targetStat && !caseOnly) throw conflict(`Project already exists: ${path.basename(target)}`);

  const sourceBytes = new Map<Kind, Buffer>();
  const sourceModes = new Map<Kind, number>();
  const files: MoveFile[] = [];
  for (const kind of KINDS) {
    const sourcePath = artifactPath(source, kind);
    const targetPath = artifactPath(target, kind);
    const sourceArtifact = await readSourceArtifact(sourcePath, rootDevice);
    const sourceState = sourceArtifact.state;
    const targetState = await readState(targetPath, true);
    if (targetState.exists || (caseOnly && sourceState.exists && !await hasExactEntry(sourcePath))) {
      const label = kind === 'dataset' ? 'Dataset' : kind === 'settings' ? 'Settings' : kind === 'stats' ? 'Stats' : 'Project';
      throw conflict(`${label} file already exists for project: ${path.basename(target)}`);
    }
    if (sourceArtifact.bytes !== undefined && sourceArtifact.mode !== undefined) {
      sourceBytes.set(kind, sourceArtifact.bytes);
      sourceModes.set(kind, sourceArtifact.mode);
    }
    files.push({ kind, old: sourceState, next: kind === 'stats' ? { exists: false } : sourceState });
  }
  const [project] = loadProjectAndAttachedDataFromString(sourceBytes.get('project')!.toString('utf8'));
  const projectId = String(project.metadata.id ?? '');
  if (sourceBytes.has('settings')) normalizeStoredWorkflowProjectSettings(JSON.parse(sourceBytes.get('settings')!.toString('utf8')));
  const id = randomUUID();
  const journal: MoveJournal = {
    version: VERSION, id, source: relativePath(root, source), target: relativePath(root, target), projectId, caseOnly, files,
  };
  const transactionPath = path.join(moveRoot(root), id);
  await fs.mkdir(transactionPath);
  await syncDirectory(moveRoot(root));
  let markerWritten = false;
  let committed = false;
  try {
    for (const file of files) {
      if (file.next.exists) await writeExclusive(stagedPath(transactionPath, file.kind), sourceBytes.get(file.kind)!, sourceModes.get(file.kind));
      await checkpoint('staged');
    }
    await writeExclusive(path.join(transactionPath, JOURNAL_PENDING), `${JSON.stringify(journal)}\n`);
    await checkpoint('journal-staged');
    await fs.rename(path.join(transactionPath, JOURNAL_PENDING), path.join(transactionPath, JOURNAL));
    await syncDirectory(transactionPath);
    await checkpoint('prepared');
    for (const file of files) {
      if (file.next.exists) await assertState(stagedPath(transactionPath, file.kind), file.next);
    }
    for (const file of files) {
      const sourcePath = artifactPath(source, file.kind);
      const targetPath = artifactPath(target, file.kind);
      if (file.old.exists) {
        await assertState(sourcePath, file.old, true);
        await fs.rename(sourcePath, backupPath(transactionPath, file.kind));
        await syncDirectory(path.dirname(sourcePath));
        await syncDirectory(transactionPath);
      }
      await checkpoint('backed-up');
      if (file.next.exists) {
        await assertState(stagedPath(transactionPath, file.kind), file.next);
        await fs.rename(stagedPath(transactionPath, file.kind), targetPath);
        await syncDirectory(path.dirname(targetPath));
        await syncDirectory(transactionPath);
      }
      await checkpoint('promoted');
    }
    await verifyGeneration(root, journal, 'next');
    await checkpoint('validated');
    await writeExclusive(path.join(transactionPath, COMMITTED_PENDING), `${JSON.stringify(journal)}\n`);
    await checkpoint('marker-staged');
    await fs.rename(path.join(transactionPath, COMMITTED_PENDING), path.join(transactionPath, COMMITTED));
    markerWritten = true;
    await checkpoint('marker-renamed');
    await syncDirectory(transactionPath);
    committed = true;
    await checkpoint('committed');
    await checkpoint('cleanup');
    await validateCleanupEvidence(transactionPath, journal);
    await cleanup(transactionPath, journal);
  } catch (error) {
    if (error instanceof FilesystemProjectMoveInterruption) throw error;
    if (committed) {
      console.error(`[workflow-storage] Committed project move ${id} cleanup deferred:`, error);
      return;
    }
    if (markerWritten) throw new FilesystemProjectMoveCommitUncertainError(id, source, error);
    try {
      await recoverDirectory(root, transactionPath);
    } catch (recoveryError) {
      throw new Error(`Project move ${id} recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`, { cause: recoveryError });
    }
    throw error;
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { fsync as fsyncCallback, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { deserializeDatasets, loadProjectAndAttachedDataFromString } from '@valerypopoff/rivet2-node';

import { getWorkflowsRoot } from '../../security.js';
import { getWorkflowDatasetPath, PROJECT_EXTENSION, WORKFLOW_DATASET_SUFFIX } from './fs-helpers.js';

export const FILESYSTEM_PROJECT_TRANSACTIONS_DIR = '.rivet-transactions';

const JOURNAL_FILE_NAME = 'journal.json';
const COMMITTED_MARKER_FILE_NAME = 'committed';
const PROJECT_STAGED_FILE_NAME = 'project.new';
const DATASET_STAGED_FILE_NAME = 'dataset.new';
const PROJECT_BACKUP_FILE_NAME = 'project.old';
const DATASET_BACKUP_FILE_NAME = 'dataset.old';
const JOURNAL_VERSION = 1;
const CAPABILITY_PROBE_PAYLOAD = Buffer.from('rivet-filesystem-transaction-probe', 'utf8');
const CAPABILITY_PROBE_FILE_PATTERN =
  /^\.probe-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.renamed)?$/i;

export type FilesystemProjectTransactionCheckpoint =
  | 'staged-project'
  | 'staged-dataset'
  | 'prepared'
  | 'project-backed-up'
  | 'dataset-backed-up'
  | 'project-promoted'
  | 'dataset-applied'
  | 'validated'
  | 'committed'
  | 'cleanup';

export class FilesystemProjectTransactionInterruption extends Error {
  constructor(readonly checkpoint: FilesystemProjectTransactionCheckpoint) {
    super(`Simulated filesystem project transaction interruption at ${checkpoint}`);
    this.name = 'FilesystemProjectTransactionInterruption';
  }
}

export class FilesystemProjectTransactionCleanupPendingError extends Error {
  readonly status = 503;
  readonly expose = true;

  constructor() {
    super('A previous project save is still awaiting transaction cleanup. Retry shortly.');
    this.name = 'FilesystemProjectTransactionCleanupPendingError';
  }
}

type ExistingFileState = {
  exists: true;
  size: number;
  sha256: string;
};

type MissingFileState = {
  exists: false;
};

type FileState = ExistingFileState | MissingFileState;

type JournalArtifact = {
  canonicalPath: string;
  stagedFile: string;
  backupFile: string;
  oldState: FileState;
  newState: FileState;
};

type ProjectTransactionJournal = {
  version: typeof JOURNAL_VERSION;
  transactionId: string;
  createdAt: string;
  project: JournalArtifact;
  dataset: JournalArtifact;
};

type PendingOperation = {
  kind: 'read' | 'write';
  grant: (release: () => void) => void;
};

class FilesystemOperationCoordinator {
  #activeReaders = 0;
  #writerActive = false;
  #queue: PendingOperation[] = [];

  async withRead<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.#acquire('read');
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async withWrite<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.#acquire('write');
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async waitForIdle(): Promise<void> {
    await this.withWrite(async () => undefined);
  }

  #acquire(kind: PendingOperation['kind']): Promise<() => void> {
    if (kind === 'read' && !this.#writerActive && !this.#queue.some((entry) => entry.kind === 'write')) {
      this.#activeReaders += 1;
      return Promise.resolve(this.#createRelease('read'));
    }

    if (kind === 'write' && !this.#writerActive && this.#activeReaders === 0 && this.#queue.length === 0) {
      this.#writerActive = true;
      return Promise.resolve(this.#createRelease('write'));
    }

    return new Promise((resolve) => {
      this.#queue.push({ kind, grant: resolve });
    });
  }

  #createRelease(kind: PendingOperation['kind']): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === 'read') {
        this.#activeReaders -= 1;
      } else {
        this.#writerActive = false;
      }
      this.#drain();
    };
  }

  #drain(): void {
    if (this.#writerActive || this.#activeReaders > 0 || this.#queue.length === 0) return;

    if (this.#queue[0]!.kind === 'write') {
      const next = this.#queue.shift()!;
      this.#writerActive = true;
      next.grant(this.#createRelease('write'));
      return;
    }

    while (this.#queue[0]?.kind === 'read') {
      const next = this.#queue.shift()!;
      this.#activeReaders += 1;
      next.grant(this.#createRelease('read'));
    }
  }
}

const operationCoordinator = new FilesystemOperationCoordinator();
const fatalRecoveryErrors = new Map<string, Error>();

function getRootKey(root: string): string {
  return path.resolve(root);
}

function getTransactionsRoot(root: string): string {
  return path.join(root, FILESYSTEM_PROJECT_TRANSACTIONS_DIR);
}

function checksum(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function stateForContents(contents: Buffer): ExistingFileState {
  return {
    exists: true,
    size: contents.byteLength,
    sha256: checksum(contents),
  };
}

async function readFileState(filePath: string): Promise<FileState> {
  try {
    const contents = await fs.readFile(filePath);
    return stateForContents(contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

function assertStateShape(value: unknown, label: string): asserts value is FileState {
  if (typeof value !== 'object' || value == null || !('exists' in value) || typeof value.exists !== 'boolean') {
    throw new Error(`Invalid ${label} file state`);
  }
  if (!value.exists) return;
  if (
    !('size' in value) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    !('sha256' in value) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new Error(`Invalid ${label} file state`);
  }
}

function resolveCanonicalPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw new Error('Transaction journal contains an invalid canonical path');
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split('/'));
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Transaction journal path escapes the workflow root');
  }
  return resolved;
}

function normalizeCanonicalPath(root: string, filePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(filePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Project transaction path must be beneath the workflow root');
  }
  return relative.replace(/\\/g, '/');
}

async function ensureDirectoryBeneathRoot(root: string, directoryPath: string, label: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directoryPath);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must resolve beneath the workflow root`);
  }

  await fs.mkdir(resolvedRoot, { recursive: true });
  const realRoot = await fs.realpath(resolvedRoot);
  let currentPath = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    try {
      const stats = await fs.stat(currentPath);
      if (!stats.isDirectory()) throw new Error(`${label} is not a directory`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await fs.mkdir(currentPath);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
    }

    const realCurrentPath = await fs.realpath(currentPath);
    const realRelative = path.relative(realRoot, realCurrentPath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error(`${label} must resolve beneath the workflow root`);
    }
  }
}

function parseArtifact(value: unknown, label: 'project' | 'dataset'): JournalArtifact {
  if (typeof value !== 'object' || value == null) throw new Error(`Invalid ${label} journal artifact`);
  const record = value as Record<string, unknown>;
  const expectedStaged = label === 'project' ? PROJECT_STAGED_FILE_NAME : DATASET_STAGED_FILE_NAME;
  const expectedBackup = label === 'project' ? PROJECT_BACKUP_FILE_NAME : DATASET_BACKUP_FILE_NAME;
  if (
    typeof record.canonicalPath !== 'string' ||
    record.stagedFile !== expectedStaged ||
    record.backupFile !== expectedBackup
  ) {
    throw new Error(`Invalid ${label} journal artifact`);
  }
  assertStateShape(record.oldState, `${label} old`);
  assertStateShape(record.newState, `${label} new`);
  return {
    canonicalPath: record.canonicalPath,
    stagedFile: expectedStaged,
    backupFile: expectedBackup,
    oldState: record.oldState,
    newState: record.newState,
  };
}

function parseJournal(root: string, transactionId: string, value: unknown): ProjectTransactionJournal {
  if (typeof value !== 'object' || value == null) throw new Error('Invalid project transaction journal');
  const record = value as Record<string, unknown>;
  if (
    record.version !== JOURNAL_VERSION ||
    record.transactionId !== transactionId ||
    typeof record.createdAt !== 'string'
  ) {
    throw new Error('Invalid project transaction journal header');
  }
  const project = parseArtifact(record.project, 'project');
  const dataset = parseArtifact(record.dataset, 'dataset');
  const projectPath = resolveCanonicalPath(root, project.canonicalPath);
  const datasetPath = resolveCanonicalPath(root, dataset.canonicalPath);
  if (!projectPath.endsWith(PROJECT_EXTENSION) || !datasetPath.endsWith(WORKFLOW_DATASET_SUFFIX)) {
    throw new Error('Transaction journal contains unexpected artifact paths');
  }
  if (getWorkflowDatasetPath(projectPath) !== datasetPath) {
    throw new Error('Transaction journal dataset does not belong to its project');
  }
  if (!project.newState.exists) throw new Error('A project transaction must contain a new project generation');
  return {
    version: JOURNAL_VERSION,
    transactionId,
    createdAt: record.createdAt,
    project,
    dataset,
  };
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')
  );
}

function syncFileDescriptor(fileDescriptor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsyncCallback(fileDescriptor, (error) => (error ? reject(error) : resolve()));
  });
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directoryPath, 'r');
    await syncFileDescriptor(handle.fd);
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeDurableExclusive(filePath: string, contents: Buffer | string): Promise<void> {
  const handle = await fs.open(filePath, 'wx');
  try {
    await handle.writeFile(contents);
    await syncFileDescriptor(handle.fd);
  } finally {
    await handle.close();
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function assertRealPathBeneathRoot(root: string, candidatePath: string, label: string): Promise<void> {
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidatePath)]);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must resolve beneath the workflow root`);
  }
}

async function cleanupStaleCapabilityProbes(transactionsRoot: string): Promise<void> {
  const entries = await fs.readdir(transactionsRoot, { withFileTypes: true });
  const staleProbeFiles = entries.filter((entry) => entry.isFile() && CAPABILITY_PROBE_FILE_PATTERN.test(entry.name));
  if (staleProbeFiles.length === 0) return;
  await Promise.all(staleProbeFiles.map((entry) => fs.unlink(path.join(transactionsRoot, entry.name))));
  await syncDirectory(transactionsRoot);
}

async function assertFileMatches(filePath: string, expected: FileState, label: string): Promise<void> {
  const actual = await readFileState(filePath);
  if (actual.exists !== expected.exists) throw new Error(`${label} has unexpected existence state`);
  if (actual.exists && expected.exists && (actual.size !== expected.size || actual.sha256 !== expected.sha256)) {
    throw new Error(`${label} failed size or checksum validation`);
  }
}

async function fileMatches(filePath: string, expected: FileState): Promise<boolean> {
  try {
    await assertFileMatches(filePath, expected, filePath);
    return true;
  } catch {
    return false;
  }
}

async function restoreArtifact(root: string, transactionPath: string, artifact: JournalArtifact): Promise<void> {
  const canonicalPath = resolveCanonicalPath(root, artifact.canonicalPath);
  const backupPath = path.join(transactionPath, artifact.backupFile);
  const backupState = await readFileState(backupPath);
  const canonicalState = await readFileState(canonicalPath);

  if (artifact.oldState.exists) {
    if (backupState.exists) {
      await assertFileMatches(backupPath, artifact.oldState, 'Transaction backup');
      if (canonicalState.exists) {
        if (await fileMatches(canonicalPath, artifact.oldState)) {
          await unlinkIfPresent(backupPath);
          return;
        }
        if (!(await fileMatches(canonicalPath, artifact.newState))) {
          throw new Error(`Cannot safely replace unrecognized canonical artifact ${artifact.canonicalPath}`);
        }
        await fs.unlink(canonicalPath);
      }
      await fs.rename(backupPath, canonicalPath);
      await syncDirectory(path.dirname(canonicalPath));
      await syncDirectory(transactionPath);
      return;
    }

    await assertFileMatches(canonicalPath, artifact.oldState, `Canonical artifact ${artifact.canonicalPath}`);
    return;
  }

  if (backupState.exists) throw new Error(`Unexpected backup exists for ${artifact.canonicalPath}`);
  if (!canonicalState.exists) return;
  if (!(await fileMatches(canonicalPath, artifact.newState))) {
    throw new Error(`Cannot safely remove unrecognized canonical artifact ${artifact.canonicalPath}`);
  }
  await fs.unlink(canonicalPath);
  await syncDirectory(path.dirname(canonicalPath));
}

async function cleanupTransactionDirectory(transactionPath: string): Promise<void> {
  for (const fileName of [
    PROJECT_STAGED_FILE_NAME,
    DATASET_STAGED_FILE_NAME,
    PROJECT_BACKUP_FILE_NAME,
    DATASET_BACKUP_FILE_NAME,
  ]) {
    await unlinkIfPresent(path.join(transactionPath, fileName));
  }

  // Retain the journal and commit marker until all other residue is gone. If
  // cleanup encounters unexpected evidence, recovery can still identify the
  // durable generation and retry later instead of turning an already-committed
  // transaction into an ambiguous orphan.
  const remainingEntries = await fs.readdir(transactionPath);
  const finalEvidence = new Set([JOURNAL_FILE_NAME, COMMITTED_MARKER_FILE_NAME]);
  if (!remainingEntries.every((entry) => finalEvidence.has(entry))) {
    throw new Error('Transaction cleanup found unexpected recovery evidence');
  }
  await unlinkIfPresent(path.join(transactionPath, JOURNAL_FILE_NAME));
  // Persist the ordering: if a crash happens after this point, the structured
  // committed marker is still present and can prove the new generation.
  await syncDirectory(transactionPath);
  await unlinkIfPresent(path.join(transactionPath, COMMITTED_MARKER_FILE_NAME));
  await syncDirectory(transactionPath);
  await fs.rmdir(transactionPath);
}

async function retryableRecoveredTransactionCleanup(
  transactionId: string,
  transactionPath: string,
  generation: 'committed' | 'rolled back',
): Promise<boolean> {
  try {
    await cleanupTransactionDirectory(transactionPath);
    return false;
  } catch (cleanupError) {
    // The canonical pair has already been checksum-validated. Preserve the
    // journal and retry cleanup later; only an unprovable canonical generation
    // should block recovery or readiness.
    console.error(
      `[workflow-storage] ${generation} transaction ${transactionId} cleanup was deferred; startup recovery will retry:`,
      cleanupError,
    );
    return true;
  }
}

async function readTransactionJournal(
  root: string,
  transactionId: string,
  filePath: string,
  label: 'journal' | 'committed marker',
): Promise<ProjectTransactionJournal> {
  try {
    return parseJournal(root, transactionId, JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error) {
    throw new Error(
      `Transaction ${transactionId} has an invalid ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function journalsMatch(left: ProjectTransactionJournal, right: ProjectTransactionJournal): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function recoverCommittedTransaction(
  root: string,
  transactionId: string,
  transactionPath: string,
  journal: ProjectTransactionJournal,
): Promise<boolean> {
  await assertFileMatches(
    resolveCanonicalPath(root, journal.project.canonicalPath),
    journal.project.newState,
    'Committed project',
  );
  await assertFileMatches(
    resolveCanonicalPath(root, journal.dataset.canonicalPath),
    journal.dataset.newState,
    'Committed dataset',
  );
  return retryableRecoveredTransactionCleanup(transactionId, transactionPath, 'committed');
}

async function recoverTransactionDirectory(root: string, transactionPath: string): Promise<boolean> {
  const transactionId = path.basename(transactionPath);
  const journalPath = path.join(transactionPath, JOURNAL_FILE_NAME);
  const markerPath = path.join(transactionPath, COMMITTED_MARKER_FILE_NAME);
  const journalState = await readFileState(journalPath);
  const markerState = await readFileState(markerPath);

  if (!journalState.exists && !markerState.exists) {
    const entries = await fs.readdir(transactionPath);
    const safeUnpreparedFiles = new Set([PROJECT_STAGED_FILE_NAME, DATASET_STAGED_FILE_NAME]);
    if (!entries.every((entry) => safeUnpreparedFiles.has(entry))) {
      throw new Error(`Transaction ${transactionId} has no journal and contains recovery evidence`);
    }
    for (const entry of entries) await unlinkIfPresent(path.join(transactionPath, entry));
    await fs.rmdir(transactionPath);
    return false;
  }

  if (!journalState.exists) {
    // The committed marker deliberately carries a second copy of the safe
    // journal metadata. Cleanup removes the journal first, so an interruption
    // between the two final unlinks can still prove the new generation.
    const markerJournal = await readTransactionJournal(root, transactionId, markerPath, 'committed marker');
    try {
      return await recoverCommittedTransaction(root, transactionId, transactionPath, markerJournal);
    } catch (error) {
      throw new Error(
        `Recovery for project ${markerJournal.project.canonicalPath} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  const journal = await readTransactionJournal(root, transactionId, journalPath, 'journal');

  try {
    if (markerState.exists) {
      const markerContents = await fs.readFile(markerPath, 'utf8');
      // Existing committed transactions used an ID-only marker. Retain support
      // while their journal remains available, but new markers duplicate the
      // journal so a partial final cleanup remains recoverable.
      if (markerContents !== `${transactionId}\n`) {
        const markerJournal = await readTransactionJournal(root, transactionId, markerPath, 'committed marker');
        if (!journalsMatch(journal, markerJournal)) {
          throw new Error('Committed marker does not match its journal');
        }
      }
      return await recoverCommittedTransaction(root, transactionId, transactionPath, journal);
    }

    await restoreArtifact(root, transactionPath, journal.project);
    await restoreArtifact(root, transactionPath, journal.dataset);
    await assertFileMatches(
      resolveCanonicalPath(root, journal.project.canonicalPath),
      journal.project.oldState,
      'Rolled-back project',
    );
    await assertFileMatches(
      resolveCanonicalPath(root, journal.dataset.canonicalPath),
      journal.dataset.oldState,
      'Rolled-back dataset',
    );
    return await retryableRecoveredTransactionCleanup(transactionId, transactionPath, 'rolled back');
  } catch (error) {
    throw new Error(
      `Recovery for project ${journal.project.canonicalPath} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function recoverTransactionsUnlocked(root: string, projectPath?: string): Promise<boolean> {
  const transactionsRoot = getTransactionsRoot(root);
  const expectedProjectPath = projectPath ? normalizeCanonicalPath(root, projectPath) : null;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(transactionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  let cleanupPending = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new Error(`Unexpected file in ${FILESYSTEM_PROJECT_TRANSACTIONS_DIR}: ${entry.name}`);
    }
    const transactionPath = path.join(transactionsRoot, entry.name);
    if (expectedProjectPath) {
      const journalPath = path.join(transactionPath, JOURNAL_FILE_NAME);
      try {
        const journal = parseJournal(root, entry.name, JSON.parse(await fs.readFile(journalPath, 'utf8')));
        if (journal.project.canonicalPath !== expectedProjectPath) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Unprepared residue is safe to inspect regardless of the requested path.
        } else {
          throw error;
        }
      }
    }
    try {
      cleanupPending = (await recoverTransactionDirectory(root, transactionPath)) || cleanupPending;
    } catch (error) {
      throw new Error(
        `Transaction ${entry.name} recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  await fs.rmdir(transactionsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
  });
  return cleanupPending;
}

async function runStorageCapabilityProbe(root: string): Promise<void> {
  const transactionsRoot = getTransactionsRoot(root);
  await fs.mkdir(transactionsRoot, { recursive: true });
  await assertRealPathBeneathRoot(root, transactionsRoot, 'Transaction directory');
  await cleanupStaleCapabilityProbes(transactionsRoot);
  const probePath = path.join(transactionsRoot, `.probe-${randomUUID()}`);
  const renamedProbePath = `${probePath}.renamed`;
  try {
    const [rootStats, transactionsStats] = await Promise.all([fs.stat(root), fs.stat(transactionsRoot)]);
    if (rootStats.dev !== transactionsStats.dev) {
      throw new Error('Workflow files and transaction journals must use the same filesystem device');
    }
    await writeDurableExclusive(probePath, CAPABILITY_PROBE_PAYLOAD);
    await fs.rename(probePath, renamedProbePath);
    await syncDirectory(transactionsRoot);
    const verified = await fs.readFile(renamedProbePath);
    if (!verified.equals(CAPABILITY_PROBE_PAYLOAD)) {
      throw new Error('Filesystem rename probe returned unexpected contents');
    }
  } finally {
    await unlinkIfPresent(probePath).catch(() => undefined);
    await unlinkIfPresent(renamedProbePath).catch(() => undefined);
  }
}

function rememberFatalRecoveryError(
  root: string,
  transactionId: string,
  projectPath: string | null,
  error: unknown,
): Error {
  const safePath = projectPath ? normalizeCanonicalPath(root, projectPath) : 'unknown-project';
  const diagnostic = new Error(
    `Filesystem transaction recovery failed closed for transaction ${transactionId} (${safePath}): ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
  fatalRecoveryErrors.set(getRootKey(root), diagnostic);
  console.error(`[workflow-storage] ${diagnostic.message}`, error);
  return diagnostic;
}

export async function initializeFilesystemProjectTransactions(root: string): Promise<void> {
  await operationCoordinator.withWrite(async () => {
    fatalRecoveryErrors.delete(getRootKey(root));
    try {
      await runStorageCapabilityProbe(root);
      await recoverTransactionsUnlocked(root);
    } catch (error) {
      throw rememberFatalRecoveryError(root, 'startup', null, error);
    }
  });
}

export function checkFilesystemProjectTransactionHealth(root: string): void {
  const error = fatalRecoveryErrors.get(getRootKey(root));
  if (error) throw error;
}

export async function withFilesystemWorkflowStorageRead<T>(operation: () => Promise<T>): Promise<T> {
  return operationCoordinator.withRead(async () => {
    checkFilesystemProjectTransactionHealth(getWorkflowsRoot());
    return operation();
  });
}

export async function withFilesystemWorkflowStorageWrite<T>(operation: () => Promise<T>): Promise<T> {
  return operationCoordinator.withWrite(async () => {
    const root = getWorkflowsRoot();
    checkFilesystemProjectTransactionHealth(root);
    try {
      if (await recoverTransactionsUnlocked(root)) {
        throw new FilesystemProjectTransactionCleanupPendingError();
      }
    } catch (error) {
      if (error instanceof FilesystemProjectTransactionCleanupPendingError) throw error;
      throw rememberFatalRecoveryError(root, 'defensive-write', null, error);
    }
    return operation();
  });
}

export async function withFilesystemWorkflowProjectRead<T>(
  root: string,
  projectPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return operationCoordinator.withWrite(async () => {
    checkFilesystemProjectTransactionHealth(root);
    try {
      await recoverTransactionsUnlocked(root, projectPath);
    } catch (error) {
      throw rememberFatalRecoveryError(root, 'defensive-read', projectPath, error);
    }
    return operation();
  });
}

export async function waitForFilesystemWorkflowStorageIdle(): Promise<void> {
  await operationCoordinator.waitForIdle();
}

export async function recoverFilesystemProjectTransactions(root: string): Promise<void> {
  await operationCoordinator.withWrite(async () => {
    try {
      await recoverTransactionsUnlocked(root);
      fatalRecoveryErrors.delete(getRootKey(root));
    } catch (error) {
      throw rememberFatalRecoveryError(root, 'recovery', null, error);
    }
  });
}

export function resetFilesystemProjectTransactionStateForTests(root?: string): void {
  if (root) {
    fatalRecoveryErrors.delete(getRootKey(root));
  } else {
    fatalRecoveryErrors.clear();
  }
}

export async function saveFilesystemProjectTransaction(options: {
  root: string;
  projectPath: string;
  projectContents: string;
  datasetsContents: string | null;
  /** Resolves a canonical target and normalized contents while the write lock is held. */
  resolveProjectTarget?: () =>
    | {
        projectPath: string;
        projectContents: string;
      }
    | Promise<{
        projectPath: string;
        projectContents: string;
      }>;
  beforeTransaction?: () => void | Promise<void>;
  afterCommit?: () => void | Promise<void>;
  onCheckpoint?: (checkpoint: FilesystemProjectTransactionCheckpoint) => void | Promise<void>;
}): Promise<void> {
  await operationCoordinator.withWrite(async () => {
    const resolvedTarget = await options.resolveProjectTarget?.();
    const projectPath = path.resolve(resolvedTarget?.projectPath ?? options.projectPath);
    const projectContents = resolvedTarget?.projectContents ?? options.projectContents;
    if (!projectPath.endsWith(PROJECT_EXTENSION)) {
      throw new Error(`Project transaction target must end with ${PROJECT_EXTENSION}`);
    }
    const datasetPath = getWorkflowDatasetPath(projectPath);
    normalizeCanonicalPath(options.root, projectPath);
    normalizeCanonicalPath(options.root, datasetPath);
    checkFilesystemProjectTransactionHealth(options.root);
    loadProjectAndAttachedDataFromString(projectContents);
    if (options.datasetsContents != null) deserializeDatasets(options.datasetsContents);

    let cleanupPending: boolean;
    try {
      cleanupPending = await recoverTransactionsUnlocked(options.root, projectPath);
    } catch (error) {
      throw rememberFatalRecoveryError(options.root, 'defensive-save', projectPath, error);
    }
    if (cleanupPending) throw new FilesystemProjectTransactionCleanupPendingError();
    await options.beforeTransaction?.();
    await ensureDirectoryBeneathRoot(options.root, path.dirname(projectPath), 'Project directory');

    const transactionsRoot = getTransactionsRoot(options.root);
    await ensureDirectoryBeneathRoot(options.root, transactionsRoot, 'Transaction directory');
    const [rootStats, parentStats, transactionsStats] = await Promise.all([
      fs.stat(options.root),
      fs.stat(path.dirname(projectPath)),
      fs.stat(transactionsRoot),
    ]);
    if (rootStats.dev !== parentStats.dev || rootStats.dev !== transactionsStats.dev) {
      throw new Error('Project, dataset, and transaction journal must use the same filesystem device');
    }

    const transactionId = randomUUID();
    const transactionPath = path.join(transactionsRoot, transactionId);
    await fs.mkdir(transactionPath, { recursive: false });
    await syncDirectory(transactionsRoot);

    const projectBuffer = Buffer.from(projectContents, 'utf8');
    const datasetBuffer = options.datasetsContents == null ? null : Buffer.from(options.datasetsContents, 'utf8');
    let committed = false;
    let markerWritten = false;

    try {
      const [oldProjectState, oldDatasetState] = await Promise.all([
        readFileState(projectPath),
        readFileState(datasetPath),
      ]);
      await writeDurableExclusive(path.join(transactionPath, PROJECT_STAGED_FILE_NAME), projectBuffer);
      await options.onCheckpoint?.('staged-project');
      if (datasetBuffer) {
        await writeDurableExclusive(path.join(transactionPath, DATASET_STAGED_FILE_NAME), datasetBuffer);
        await options.onCheckpoint?.('staged-dataset');
      }

      const journal: ProjectTransactionJournal = {
        version: JOURNAL_VERSION,
        transactionId,
        createdAt: new Date().toISOString(),
        project: {
          canonicalPath: normalizeCanonicalPath(options.root, projectPath),
          stagedFile: PROJECT_STAGED_FILE_NAME,
          backupFile: PROJECT_BACKUP_FILE_NAME,
          oldState: oldProjectState,
          newState: stateForContents(projectBuffer),
        },
        dataset: {
          canonicalPath: normalizeCanonicalPath(options.root, datasetPath),
          stagedFile: DATASET_STAGED_FILE_NAME,
          backupFile: DATASET_BACKUP_FILE_NAME,
          oldState: oldDatasetState,
          newState: datasetBuffer ? stateForContents(datasetBuffer) : { exists: false },
        },
      };
      await writeDurableExclusive(
        path.join(transactionPath, JOURNAL_FILE_NAME),
        `${JSON.stringify(journal, null, 2)}\n`,
      );
      await syncDirectory(transactionPath);
      await options.onCheckpoint?.('prepared');

      const stagedProjectPath = path.join(transactionPath, PROJECT_STAGED_FILE_NAME);
      const stagedDatasetPath = path.join(transactionPath, DATASET_STAGED_FILE_NAME);
      await assertFileMatches(stagedProjectPath, journal.project.newState, 'Staged project');
      await assertFileMatches(stagedDatasetPath, journal.dataset.newState, 'Staged dataset');
      loadProjectAndAttachedDataFromString(await fs.readFile(stagedProjectPath, 'utf8'));
      if (journal.dataset.newState.exists) deserializeDatasets(await fs.readFile(stagedDatasetPath, 'utf8'));

      if (oldProjectState.exists) {
        await fs.rename(projectPath, path.join(transactionPath, PROJECT_BACKUP_FILE_NAME));
        await syncDirectory(path.dirname(projectPath));
        await syncDirectory(transactionPath);
      }
      await options.onCheckpoint?.('project-backed-up');

      if (oldDatasetState.exists) {
        await fs.rename(datasetPath, path.join(transactionPath, DATASET_BACKUP_FILE_NAME));
        await syncDirectory(path.dirname(datasetPath));
        await syncDirectory(transactionPath);
      }
      await options.onCheckpoint?.('dataset-backed-up');

      await fs.rename(path.join(transactionPath, PROJECT_STAGED_FILE_NAME), projectPath);
      await syncDirectory(path.dirname(projectPath));
      await syncDirectory(transactionPath);
      await options.onCheckpoint?.('project-promoted');

      if (datasetBuffer) {
        await fs.rename(path.join(transactionPath, DATASET_STAGED_FILE_NAME), datasetPath);
        await syncDirectory(path.dirname(datasetPath));
        await syncDirectory(transactionPath);
      }
      await options.onCheckpoint?.('dataset-applied');

      await assertFileMatches(projectPath, journal.project.newState, 'Promoted project');
      await assertFileMatches(datasetPath, journal.dataset.newState, 'Promoted dataset');
      loadProjectAndAttachedDataFromString(await fs.readFile(projectPath, 'utf8'));
      if (journal.dataset.newState.exists) deserializeDatasets(await fs.readFile(datasetPath, 'utf8'));
      await options.onCheckpoint?.('validated');

      // The marker duplicates only the validated journal metadata (never
      // project or dataset contents). That keeps a committed generation
      // provable if cleanup is interrupted after deleting journal.json.
      await writeDurableExclusive(
        path.join(transactionPath, COMMITTED_MARKER_FILE_NAME),
        `${JSON.stringify(journal)}\n`,
      );
      markerWritten = true;
      await syncDirectory(transactionPath);
      committed = true;
      await options.onCheckpoint?.('committed');
      await options.afterCommit?.();
      await options.onCheckpoint?.('cleanup');
      await cleanupTransactionDirectory(transactionPath);
      await fs.rmdir(transactionsRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
      });
    } catch (error) {
      if (error instanceof FilesystemProjectTransactionInterruption) throw error;

      if (committed) {
        console.error(
          `[workflow-storage] Committed transaction ${transactionId} post-commit finalization failed; the save remains committed and startup recovery will clean transaction residue:`,
          error,
        );
        return;
      }

      if (markerWritten) {
        throw rememberFatalRecoveryError(options.root, transactionId, projectPath, error);
      }

      try {
        await recoverTransactionDirectory(options.root, transactionPath);
      } catch (recoveryError) {
        throw rememberFatalRecoveryError(options.root, transactionId, projectPath, recoveryError);
      }
      throw error;
    }
  });
}

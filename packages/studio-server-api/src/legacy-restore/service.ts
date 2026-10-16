import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { terminateChildProcess } from '../utils/exec.js';
import type { RequestHandler } from 'express';
import {
  LegacyRestoreControl,
  restoreBlocksServing,
  canProceedAfterRestoreValidationFailure,
  type RestoreOperation,
} from './control.js';
import { LEGACY_RESTORE_LIMITS } from './archive.js';
import { captureRestoreObjects, preflightRestorePermissions } from './scope.js';
import { captureRestoreSettings } from '../app-settings/settings-repository.js';
import {
  getManagedWorkflowStorageConfig,
  type ManagedWorkflowStorageConfig,
} from '../routes/workflows/storage-config.js';
import { migrationTargetIdentity } from '../vm-migration-target-gate.js';
import type { SettingsRow } from '../scripts/migrate-app-settings.js';
import { syncFileDescriptor, syncDirectory } from '../routes/workflows/filesystem-transaction-primitives.js';
import { conflict } from '../utils/httpError.js';
import { getServerUiAuthMode } from '../server-ui-auth.js';

export function buildRestoreSettings(
  source: readonly SettingsRow[],
  current: readonly SettingsRow[],
  authMode: ReturnType<typeof getServerUiAuthMode>,
): SettingsRow[] {
  return source.map((row) => {
    if (row.key !== 'deployment storage' && !(row.key === 'web app auth' && authMode === 'oauth')) return row;
    const preserved = current.find((value) => value.key === row.key);
    if (!preserved) throw new Error('Preserved settings are incomplete.');
    return preserved;
  });
}

export type LegacyRestoreHooks = { drain(): Promise<void>; restart(): Promise<void> };
let service: LegacyRestoreService | undefined;
let paused = false;
let warmup = false;
let workspaceEpoch = 'initial';
export function getLegacyRestoreWorkspaceEpoch() {
  return workspaceEpoch;
}
export function setLegacyRestoreWorkspaceEpoch(epoch: string) {
  workspaceEpoch = epoch;
}
export function isLegacyRestoreWarmup() {
  return warmup;
}
export function setLegacyRestoreWarmup(value: boolean) {
  warmup = value;
}
let activeRequests = 0;
export function getLegacyRestoreActiveRequests() {
  return activeRequests;
}
export function isLegacyRestorePaused() {
  return paused;
}
export function setLegacyRestorePaused(value: boolean) {
  paused = value;
}
export function setLegacyRestoreService(value: LegacyRestoreService) {
  service = value;
}
export function getLegacyRestoreService() {
  if (!service) throw new Error('Legacy restore requires a managed control backend with restore storage.');
  return service;
}
export const legacyRestoreRequestBarrier: RequestHandler = (req, res, next) => {
  if (process.env.RIVET_LEGACY_RESTORE_ENABLED !== '1') return next();
  const controlRequest =
    req.path.startsWith('/api/legacy-restore') ||
    req.path.startsWith('/ui-auth') ||
    req.path.startsWith('/api/config') ||
    req.path === '/internal/app-settings/proxy-config' ||
    (warmup && req.path === '/internal/executor-runtime-config');
  if (controlRequest) return next();
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    req.path.startsWith('/api/') &&
    (req.get('Sec-Fetch-Site') || req.get('X-Rivet-Workspace-Epoch')) &&
    (req.get('X-Rivet-Workspace-Epoch') || 'initial') !== workspaceEpoch
  ) {
    res.status(409).json({
      code: 'legacy_restore_stale_workspace',
      error: 'Rivet was restored. Reload this page before making changes.',
    });
    return;
  }
  if (!paused) {
    // Read-only observers (including durable-job SSE) do not own writes or run lifetimes.
    // Execution owners and storage disposal account for their actual work independently.
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    activeRequests++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeRequests--;
      res.off('finish', release);
      res.off('close', release);
    };
    res.once('finish', release);
    res.once('close', release);
    return next();
  }
  res
    .set('Retry-After', '5')
    .status(503)
    .json({ code: 'legacy_restore_maintenance', error: 'Rivet is restoring a legacy backup.' });
};

/** One lifecycle-owned job; request/browser lifetimes never own accepted work. */
export class LegacyRestoreService {
  private task?: Promise<void>;
  private child?: ChildProcess;
  private closing = false;
  private cancelling = false;
  private stoppingChild?: Promise<void>;
  private uploadJob?: { abort: AbortController; done: Promise<RestoreOperation> };
  private completion?: Promise<void>;
  private restartRequested = false;
  constructor(
    readonly control: LegacyRestoreControl,
    private readonly target: ManagedWorkflowStorageConfig,
    private readonly root: string,
    private readonly hooks: LegacyRestoreHooks,
  ) {}
  async status() {
    const operation = await this.control.read();
    return {
      available: true,
      operation: operation && {
        ...operation,
        canProceedAnyway: canProceedAfterRestoreValidationFailure(operation),
      },
    };
  }
  /** Retirement cannot abandon local upload/preparation scratch or a pending restart. */
  async assertMayRetire(): Promise<void> {
    const assertIdle = () => {
      if (this.task || this.uploadJob || this.completion || this.child || this.closing || this.restartRequested)
        throw new Error('Restore work blocks planned retirement.');
    };
    assertIdle();
    const operation = await this.control.read();
    // Recheck after the asynchronous journal read: an accepted upload may have started meanwhile.
    assertIdle();
    if (operation && !['completed', 'cancelled'].includes(operation.phase))
      throw new Error('Restore scratch ownership blocks planned retirement.');
  }
  private async ownedRoot() {
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(this.root)) !== path.resolve(this.root))
      throw new Error('Restore storage must be a real dedicated directory.');
  }
  async upload(input: Readable): Promise<RestoreOperation> {
    if (this.closing || this.cancelling || this.restartRequested) throw conflict('Restore service is stopping.');
    if (this.task || this.uploadJob) throw conflict('Restore work is already active.');
    const abort = new AbortController();
    const done = this.uploadArchive(input, abort.signal).finally(() => {
      this.uploadJob = undefined;
    });
    this.uploadJob = { abort, done };
    return done;
  }
  private async uploadArchive(input: Readable, signal: AbortSignal): Promise<RestoreOperation> {
    await this.ownedRoot();
    signal.throwIfAborted();
    const lock = await this.control.lock();
    let launch = false;
    try {
      signal.throwIfAborted();
      const previous = await this.control.read();
      if (previous && !['completed', 'cancelled'].includes(previous.phase))
        throw conflict('Finish or cancel the previous restore.');
      const id = randomUUID();
      const directory = path.join(this.root, id);
      await fs.mkdir(directory, { mode: 0o700 });
      await syncDirectory(this.root);
      const extracted = path.join(directory, 'source');
      await fs.mkdir(extracted, { mode: 0o700 });
      const archive = path.join(directory, 'archive.tar.gz');
      const roots = Object.fromEntries(
        ['workflows', 'recordings', 'appData', 'runtimeLibraries'].map((name) => [name, path.join(extracted, name)]),
      );
      const preserved = captureRestoreSettings();
      let operation: RestoreOperation = {
        id,
        phase: 'uploading',
        destructive: false,
        createdAt: new Date().toISOString(),
        bytes: 0,
        message: 'Uploading backup.',
      };
      await this.control.write(operation, {
        archive,
        roots,
        preserved,
        targetIdentity: migrationTargetIdentity(this.target),
      });
      let bytes = 0;
      const digest = createHash('sha256');
      await pipeline(
        input,
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            if (bytes > LEGACY_RESTORE_LIMITS.archiveBytes) return done(new Error('Backup upload exceeds its limit.'));
            digest.update(chunk);
            done(null, chunk);
          },
        }),
        createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      const file = await fs.open(archive, 'r+');
      try {
        await syncFileDescriptor(file.fd);
      } finally {
        await file.close();
      }
      await syncDirectory(directory);
      signal.throwIfAborted();
      operation = {
        ...operation,
        phase: 'validating',
        bytes,
        archiveDigest: digest.digest('hex'),
        message: 'Validating backup.',
      };
      await this.control.write(operation);
      launch = true;
      return operation;
    } catch (error) {
      const operation = await this.control.read();
      if (operation?.phase === 'uploading')
        await this.control.write({
          ...operation,
          phase: 'failed',
          message: 'Upload failed. Cancel and upload the archive again.',
        });
      throw error;
    } finally {
      await this.control.unlock(lock);
      if (launch) this.launch();
    }
  }
  private launch() {
    if (this.closing || this.cancelling || this.restartRequested || this.task) return;
    this.task = this.run()
      .catch(() => undefined)
      .finally(() => {
        this.task = undefined;
      });
  }
  /** Reconcile durable progress from the existing server poll, including an orphaned predecessor worker. */
  observe(operation: RestoreOperation | null) {
    if (!operation || this.closing || this.cancelling || this.restartRequested || this.uploadJob || this.task || warmup)
      return;
    if (
      ['validating', 'draining', 'clearing', 'importing', 'verifying', 'restarting'].includes(operation.phase) ||
      (paused && ['failed', 'completed', 'cancelled'].includes(operation.phase) && !restoreBlocksServing(operation))
    )
      this.launch();
  }
  async proceedAnyway(id: string, archiveDigest: string) {
    if (this.closing || this.cancelling || this.restartRequested) throw conflict('Restore service is stopping.');
    if (this.uploadJob || paused || warmup) throw conflict('Wait for current restore work to finish.');
    // A failed validator may have committed its journal just before releasing ownership.
    if (this.task) await this.task;
    const lock = await this.control.lock();
    try {
      if (this.closing || this.cancelling || this.restartRequested) throw conflict('Restore service is stopping.');
      if (this.uploadJob || paused || warmup) throw conflict('Wait for current restore work to finish.');
      const operation = await this.control.read();
      if (
        !operation ||
        !canProceedAfterRestoreValidationFailure(operation) ||
        operation.id !== id ||
        operation.archiveDigest !== archiveDigest
      )
        throw conflict('Restore override is stale or unavailable.');
      const payload = await this.control.payload(id);
      await this.control.write(
        {
          ...operation,
          phase: 'validating',
          integrityOverridden: true,
          message: 'Preparing modified backup. Original integrity checks are being bypassed.',
        },
        { ...payload, resumePhase: 'validating' },
      );
    } finally {
      await this.control.unlock(lock);
    }
    // No drain/deletion here. The existing explicit destructive confirmation remains required.
    this.launch();
  }
  async start(id: string, archiveDigest: string, confirmation: string) {
    if (this.closing || this.cancelling || this.restartRequested) throw conflict('Restore service is stopping.');
    if (this.uploadJob) throw conflict('Restore work is active.');
    if (this.task) {
      const ready = await this.control.read();
      if (
        ready?.phase !== 'awaiting-confirmation' ||
        ready.id !== id ||
        ready.archiveDigest !== archiveDigest ||
        confirmation !== 'RESTORE LEGACY BACKUP'
      )
        throw conflict('Restore work is active.');
      // The worker commits readiness before releasing its lock and exiting. Honor the advertised state
      // without racing its final acknowledgement or admitting a second owner.
      await this.task;
    }
    const lock = await this.control.lock();
    try {
      if (this.closing || this.cancelling || this.restartRequested) throw conflict('Restore service is stopping.');
      const operation = await this.control.read();
      if (
        !operation ||
        operation.id !== id ||
        operation.phase !== 'awaiting-confirmation' ||
        operation.archiveDigest !== archiveDigest ||
        confirmation !== 'RESTORE LEGACY BACKUP'
      )
        throw conflict('Restore confirmation is stale or invalid.');
      const payload = await this.control.payload(id);
      if (payload.targetIdentity !== migrationTargetIdentity(getManagedWorkflowStorageConfig()))
        throw conflict('Destination storage changed.');
      await preflightRestorePermissions(this.control.pool, this.target);
      if (this.closing || this.cancelling || this.restartRequested) throw conflict('Restore service is stopping.');
      const current = captureRestoreSettings();
      const expected = buildRestoreSettings(payload.settings as SettingsRow[], current, getServerUiAuthMode());
      await this.control.write(
        { ...operation, phase: 'draining', message: 'Pausing and draining application work.' },
        { ...payload, preserved: current, settings: expected },
      );
      paused = true;
    } finally {
      await this.control.unlock(lock);
    }
    this.launch();
  }
  async cancel(id: string) {
    if (this.closing || this.cancelling || this.restartRequested) throw conflict('Restore service is stopping.');
    const before = await this.control.read();
    if (this.closing || this.cancelling || this.restartRequested) throw conflict('Restore service is stopping.');
    if (
      !before ||
      before.id !== id ||
      before.destructive ||
      !['validating', 'awaiting-confirmation', 'failed'].includes(before.phase)
    )
      throw conflict('Destructive restore cannot be cancelled.');
    if (this.task && paused) throw conflict('Wait for current work before cancelling.');
    this.cancelling = true;
    try {
      await this.stopWorker();
      await this.task;
      const lock = await this.control.lock();
      try {
        if (this.closing || this.restartRequested) throw conflict('Restore service is stopping.');
        const operation = await this.control.read();
        if (
          !operation ||
          operation.id !== id ||
          operation.destructive ||
          !['validating', 'awaiting-confirmation', 'failed'].includes(operation.phase)
        )
          throw conflict('Destructive restore cannot be cancelled.');
        await this.cleanup(id);
        await this.control.write({ ...operation, phase: 'cancelled', message: 'Restore cancelled.' });
        await this.control.forgetPayload(id).catch(() => undefined);
      } finally {
        await this.control.unlock(lock);
      }
    } finally {
      this.cancelling = false;
    }
  }
  async retry(id: string) {
    if (this.closing || this.cancelling || this.restartRequested) throw conflict('Restore service is stopping.');
    if (this.task || this.uploadJob) throw conflict('Restore work is active.');
    const lock = await this.control.lock();
    try {
      if (this.closing || this.cancelling || this.restartRequested) throw conflict('Restore service is stopping.');
      const operation = await this.control.read();
      if (!operation || operation.id !== id || operation.phase !== 'failed' || !operation.destructive)
        throw conflict('Restore cannot be retried.');
      const payload = await this.control.payload(id);
      if (this.closing || this.cancelling || this.restartRequested) throw conflict('Restore service is stopping.');
      if (!['clearing', 'importing', 'verifying', 'restarting'].includes(String(payload.resumePhase)))
        throw conflict('Restore checkpoint is invalid.');
      await this.control.write({
        ...operation,
        phase: payload.resumePhase as 'clearing' | 'importing' | 'verifying',
        message: 'Resuming restore.',
      });
    } finally {
      await this.control.unlock(lock);
    }
    this.launch();
  }
  async recover() {
    let operation = await this.control.read();
    if (operation && ['completed', 'cancelled'].includes(operation.phase))
      await this.control.forgetPayload(operation.id).catch(() => undefined);
    if (operation?.phase === 'uploading') {
      operation = {
        ...operation,
        phase: 'failed',
        message: 'Upload was interrupted. Cancel and upload the archive again.',
      };
      await this.control.write(operation);
    }
    paused = restoreBlocksServing(operation);
    this.observe(operation);
  }
  private async run() {
    let operation = await this.control.read();
    if (!operation) return;
    const operationId = operation.id;
    if (
      !warmup &&
      paused &&
      ['failed', 'completed', 'cancelled'].includes(operation.phase) &&
      !restoreBlocksServing(operation)
    ) {
      // A predecessor can fail before deletion while this API has already disposed its serving resources.
      await this.requestRestart();
      return;
    }
    const drainedPhase = ['draining', 'clearing'].includes(operation.phase);
    try {
      if (operation.phase === 'draining') {
        await this.hooks.drain();
        if (this.closing) return;
        const lock = await this.control.lock();
        try {
          const deadline = Date.now() + 120_000;
          while (!(await this.control.exclusive(lock))) {
            if (Date.now() > deadline) throw new Error('Application writers did not drain.');
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          const objects = await captureRestoreObjects(this.control.pool, this.target);
          const payload = await this.control.payload(operation.id);
          operation = {
            ...operation,
            phase: 'clearing',
            destructive: false,
            message: 'Checking the confirmed source before replacement.',
          };
          await this.control.write(operation, { ...payload, objects, resumePhase: 'clearing' });
        } finally {
          await this.control.unlock(lock);
        }
      }
      if (!this.closing && ['validating', 'clearing', 'importing', 'verifying'].includes(operation.phase))
        await this.worker(operation.id);
      operation = await this.control.read();
      if (operation?.id !== operationId) return;
      if (operation?.phase === 'restarting') await this.requestRestart();
      else if (operation?.phase === 'failed' && !operation.destructive && drainedPhase) await this.requestRestart();
    } catch (error) {
      if (this.closing || this.cancelling || this.restartRequested) return; // The caller owns generation/cancellation recovery.
      const knownMessages = [
        'Supervisor refused restore restart.',
        'Application writers did not drain.',
        'Restore worker stopped.',
      ];
      const name =
        error instanceof Error && ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(error.name)
          ? error.name
          : 'UnknownError';
      const detail = error instanceof Error && knownMessages.includes(error.message) ? error.message : name;
      // Phase/controlled messages only: provider errors can contain credentials or archive paths.
      console.error(`[legacy-restore] ${operation?.phase ?? 'unknown'}: ${detail}`);
      // A killed API can leave a still-running predecessor worker. Never overwrite that owner's checkpoint.
      const lock = await this.control.lock().catch(() => null);
      if (!lock) return;
      let restart = false;
      try {
        const latest = await this.control.read();
        if (latest?.id === operationId && !['completed', 'cancelled', 'awaiting-confirmation'].includes(latest.phase)) {
          if (latest.phase !== 'failed')
            await this.control.write({
              ...latest,
              phase: 'failed',
              message: 'Restore could not continue safely. Reload status and retry.',
            });
          restart = !latest.destructive && drainedPhase;
        }
      } finally {
        await this.control.unlock(lock);
      }
      if (restart) await this.requestRestart();
    }
  }
  private async worker(id: string) {
    const file = fileURLToPath(new URL('./import-worker.js', import.meta.url));
    const source = file.replace(/\.js$/, '.ts');
    const compiled = await fs
      .stat(file)
      .then(() => true)
      .catch(() => false);
    if (this.closing || this.cancelling) return;
    const env = {
      ...process.env,
      RIVET_LEGACY_RESTORE_OPERATION: id,
      RIVET_MIGRATION_TARGET_DATABASE_URL: this.target.databaseUrl,
      RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE: this.target.databaseSslMode,
      RIVET_MIGRATION_TARGET_S3_BUCKET: this.target.objectStorageBucket,
      RIVET_MIGRATION_TARGET_S3_REGION: this.target.objectStorageRegion,
      RIVET_MIGRATION_TARGET_S3_PREFIX: this.target.objectStoragePrefix,
      RIVET_MIGRATION_TARGET_S3_ENDPOINT: this.target.objectStorageEndpoint ?? '',
      RIVET_MIGRATION_TARGET_S3_FORCE_PATH_STYLE: String(this.target.objectStorageForcePathStyle),
      RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID: this.target.objectStorageAccessKeyId,
      RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY: this.target.objectStorageSecretAccessKey,
    };
    await new Promise<void>((resolve, reject) => {
      // The worker and npm descendants share a private process group, so cancellation
      // cannot leave an installer writing after scratch cleanup or owner handoff.
      const child = spawn(process.execPath, compiled ? [file] : ['--import', 'tsx', source], {
        env,
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      this.child = child;
      const deadline = setTimeout(() => void this.stopWorker().catch(() => undefined), 6 * 60 * 60 * 1000);
      deadline.unref();
      const finish = (error?: Error) => {
        clearTimeout(deadline);
        if (this.child === child) this.child = undefined;
        error ? reject(error) : resolve();
      };
      child.once('error', finish);
      child.once('exit', (code) => finish(code === 0 ? undefined : new Error('Restore worker stopped.')));
    });
  }
  private stopWorker(): Promise<void> {
    return (this.stoppingChild ??= this.terminateWorker().finally(() => {
      this.stoppingChild = undefined;
    }));
  }
  private async terminateWorker() {
    const child = this.child;
    if (child && child.exitCode === null && child.pid !== undefined) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const kill = (signal: NodeJS.Signals) => {
        if (process.platform === 'win32') {
          terminateChildProcess(child, signal);
        } else {
          try {
            process.kill(-child.pid!, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      };
      kill('SIGTERM');
      const force = setTimeout(() => kill('SIGKILL'), 5000);
      try {
        await exited;
        // The leader may exit before a descendant. Kill the remaining private group.
        if (process.platform !== 'win32') kill('SIGKILL');
      } finally {
        clearTimeout(force);
      }
    }
  }
  async dispose() {
    this.closing = true;
    const upload = this.uploadJob;
    upload?.abort.abort();
    await upload?.done.catch(() => undefined);
    await this.stopWorker();
    await this.task;
    await this.completion?.catch(() => undefined); // The finalization caller owns reporting; shutdown must still close stores.
  }
  complete(): Promise<void> {
    if (this.completion) return this.completion;
    if (this.closing || this.restartRequested) return Promise.resolve();
    return (this.completion ??= this.finalizeRestore().finally(() => {
      this.completion = undefined;
    }));
  }
  private async finalizeRestore() {
    const lock = await this.control.lock();
    try {
      const operation = await this.control.read();
      if (this.closing || operation?.phase !== 'restarting') return;
      await this.cleanup(operation.id);
      await this.control.write({ ...operation, phase: 'completed', message: 'Legacy backup restored and verified.' });
      // Secret erasure is retried during recovery; it must not invalidate a committed, verified restore.
      await this.control.forgetPayload(operation.id).catch(() => undefined);
    } finally {
      await this.control.unlock(lock);
    }
    // Restart once more without validation-only background-task suppression.
    await this.requestRestart();
  }
  private async requestRestart() {
    if (this.restartRequested) return;
    await this.hooks.restart();
    // Acknowledgement transfers generation replacement to the supervisor. Polls must not
    // re-request it while this process is still alive, or turn a closing listener into failure.
    this.restartRequested = true;
  }
  private async cleanup(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid cleanup ownership.');
    await this.ownedRoot();
    const directory = path.join(this.root, id);
    if (path.dirname(directory) !== path.resolve(this.root)) throw new Error('Invalid cleanup boundary.');
    const writable = async (directory: string): Promise<void> => {
      const stat = await fs.lstat(directory).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
      await fs.chmod(directory, stat.mode | 0o700);
      for (const entry of await fs.readdir(directory, { withFileTypes: true }))
        if (entry.isDirectory() && !entry.isSymbolicLink()) await writable(path.join(directory, entry.name));
    };
    await writable(directory);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

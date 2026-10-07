import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { ProjectBundleError } from '@valerypopoff/rivet2-node';
import { collectProjectBundle, DEFAULT_BUNDLE_MAX_BYTES, type BundleSource } from './project-bundle.js';
import { createHttpError } from '../../utils/httpError.js';
import { getWorkflowsRoot } from '../../security.js';
import { createProjectBundleArchive } from './project-bundle-archive.js';
import type { ProjectBundleJobStatus } from '../../../../studio-server-shared/project-bundle-types.js';

export type { ProjectBundleJobStatus } from '../../../../studio-server-shared/project-bundle-types.js';
type Job = {
  status: ProjectBundleJobStatus;
  controller: AbortController;
  done?: Promise<void>;
  cancelling?: Promise<void>;
  readers: number;
  cleanupFailed?: boolean;
};
const RETENTION_MS = 24 * 60 * 60 * 1000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Owns disposable scratch only. Durable status distinguishes restart interruption from success. */
export class ProjectBundleJobs {
  readonly #root: string;
  readonly #jobs = new Map<string, Job>();
  #initialization?: Promise<void>;
  #cleanup?: Promise<void>;
  #disposed = false;
  #starting = false;
  #cleanupTimer?: ReturnType<typeof setInterval>;
  constructor(
    root: string,
    private readonly retentionMs = RETENTION_MS,
  ) {
    this.#root = path.resolve(root);
  }
  async #initialize() {
    this.#initialization ??= (async () => {
      await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(this.#root)).isSymbolicLink()) throw new Error('Bundle scratch must not be a symlink.');
      for (const name of await fs.readdir(this.#root)) {
        if (!ID.test(name)) continue;
        try {
          const directory = path.join(this.#root, name);
          const directoryStat = await fs.lstat(directory);
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;
          const status = JSON.parse(
            await fs.readFile(path.join(directory, 'status.json'), 'utf8'),
          ) as ProjectBundleJobStatus;
          if (
            status.id !== name ||
            !Number.isFinite(Date.parse(status.expiresAt)) ||
            !['collecting', 'packaging', 'ready', 'failed', 'cancelled', 'interrupted'].includes(status.phase) ||
            !Number.isSafeInteger(status.projects) ||
            status.projects < 0 ||
            !Number.isSafeInteger(status.bytes) ||
            status.bytes < 0 ||
            (status.phase === 'ready' &&
              (!Number.isSafeInteger(status.archiveBytes) ||
                status.archiveBytes! < 1 ||
                !/^[a-f0-9]{64}$/.test(status.archiveHash ?? '')))
          )
            continue;
          if (status.phase === 'collecting' || status.phase === 'packaging') {
            status.phase = 'interrupted';
            status.error = 'Export was interrupted by a server restart. Prepare it again.';
          }
          // Register before cleanup: filesystem failures must not orphan known scratch.
          const job: Job = { status, controller: new AbortController(), readers: 0 };
          this.#jobs.set(name, job);
          try {
            if (status.phase === 'ready') {
              try {
                await this.#assertArchive(path.join(directory, 'bundle.zip'), status);
              } catch {
                status.phase = 'failed';
                status.error = 'Bundle archive is unavailable. Prepare it again.';
              }
            }
            // Older exporters could retain staging after publication; reconcile it too.
            await fs.rm(path.join(directory, 'staging'), { recursive: true, force: true });
            await fs.rm(path.join(directory, 'bundle.partial'), { force: true });
            if (status.phase !== 'ready') {
              await fs.rm(path.join(directory, 'bundle.zip'), { force: true });
              delete status.archiveBytes;
              delete status.archiveHash;
            }
          } catch {
            this.#markCleanupFailed(job);
          }
          await this.#save(job);
        } catch {
          /* Unknown/corrupt scratch is not downloadable. */
        }
      }
      if (!this.#disposed) {
        this.#cleanupTimer = setInterval(() => {
          void this.cleanup().catch(() => {});
        }, 60_000);
        this.#cleanupTimer.unref();
      }
    })().catch((error) => {
      // Keep one owner per attempt, but do not cache a transient mount/I/O failure
      // for the lifetime of the server. No cleanup timer exists on this path.
      this.#initialization = undefined;
      throw error;
    });
    await this.#initialization;
  }
  async #save(job: Job) {
    const directory = path.join(this.#root, job.status.id);
    const temporary = path.join(directory, `status-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(job.status), { mode: 0o600 });
      await fs.rename(temporary, path.join(directory, 'status.json'));
    } catch (error) {
      // Failed replacement must preserve the previous journal and discard only
      // this attempt's temporary file. Directory cleanup remains the fallback.
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  #markCleanupFailed(job: Job) {
    job.cleanupFailed = true;
    job.status.phase = 'failed';
    job.status.error = 'Export scratch cleanup failed. Preparation can be retried after cleanup succeeds.';
    job.status.expiresAt = new Date(0).toISOString();
  }
  async cleanup() {
    await this.#initialize();
    // Serialize removal, and keep failed removals tracked for capacity accounting/retry.
    this.#cleanup ??= (async () => {
      for (const [id, job] of this.#jobs) {
        if (!job.readers && !job.done && Date.parse(job.status.expiresAt) <= Date.now()) {
          await fs.rm(path.join(this.#root, id), { recursive: true, force: true });
          this.#jobs.delete(id);
        }
      }
    })().finally(() => {
      this.#cleanup = undefined;
    });
    await this.#cleanup;
  }
  async start(
    source: BundleSource,
    rootVersion: 'latest' | 'published',
    requestId: string = randomUUID(),
  ): Promise<ProjectBundleJobStatus> {
    if (this.#disposed) throw createHttpError(503, 'Server is shutting down. Retry the export later.');
    await this.cleanup();
    if (!ID.test(requestId)) throw createHttpError(400, 'Invalid export request ID.');
    if (this.#jobs.has(requestId)) return this.status(requestId);
    if (this.#disposed) throw createHttpError(503, 'Server is shutting down. Retry the export later.');
    if (this.#starting || [...this.#jobs.values()].some((job) => job.done || job.cleanupFailed))
      throw createHttpError(409, 'Another project bundle is being prepared. Retry when it finishes.');
    this.#starting = true;
    const id = requestId,
      directory = path.join(this.#root, id);
    const job: Job = {
      status: {
        id,
        phase: 'collecting',
        projects: 0,
        bytes: 0,
        expiresAt: new Date(Date.now() + this.retentionMs).toISOString(),
      },
      controller: new AbortController(),
      readers: 0,
    };
    let directoryCreated = false;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      directoryCreated = true;
      if (this.#disposed) throw createHttpError(503, 'Server is shutting down. Retry the export later.');
      this.#jobs.set(id, job);
      await this.#save(job);
      if (this.#disposed || job.controller.signal.aborted)
        throw createHttpError(503, 'Export start was cancelled. Retry later.');
      job.done = this.#prepare(job, source, rootVersion).finally(() => {
        job.done = undefined;
      });
    } catch (error) {
      if (directoryCreated) {
        try {
          await fs.rm(directory, { recursive: true, force: true });
          this.#jobs.delete(id);
        } catch {
          // Journal creation can fail too. Retain ownership if rolling back the
          // accepted directory fails, rather than turning it into unclaimed scratch.
          this.#markCleanupFailed(job);
          this.#jobs.set(id, job);
          await this.#save(job).catch(() => {});
        }
      }
      throw error;
    } finally {
      this.#starting = false;
    }
    return structuredClone(job.status);
  }
  async #prepare(job: Job, source: BundleSource, rootVersion: 'latest' | 'published') {
    const directory = path.join(this.#root, job.status.id);
    let writer: ReturnType<typeof createProjectBundleArchive> | undefined;
    const signal = job.controller.signal;
    const timeout = setTimeout(
      () => job.controller.abort(new Error('Export exceeded its 30 minute deadline.')),
      30 * 60 * 1000,
    );
    timeout.unref();
    try {
      const configured = Number(process.env.RIVET_PROJECT_BUNDLE_MAX_BYTES ?? DEFAULT_BUNDLE_MAX_BYTES);
      if (!Number.isSafeInteger(configured) || configured < 1 || configured > 8 * 1024 ** 3)
        throw new ProjectBundleError('Invalid project bundle size limit.');
      const scratchLimit = Number(process.env.RIVET_PROJECT_BUNDLE_SCRATCH_MAX_BYTES ?? 2 * 1024 ** 3);
      if (!Number.isSafeInteger(scratchLimit) || scratchLimit < 1 || scratchLimit > 32 * 1024 ** 3)
        throw new ProjectBundleError('Invalid project bundle size limit for scratch.');
      const reserveBytes = Number(process.env.RIVET_PROJECT_BUNDLE_FREE_SPACE_RESERVE_BYTES ?? 32 * 1024 * 1024);
      if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 1024 * 1024 || reserveBytes > 1024 ** 3)
        throw new ProjectBundleError('Invalid project bundle free-space reserve (1 MiB to 1 GiB).');
      const archive = path.join(directory, 'bundle.partial');
      writer = createProjectBundleArchive({
        archive,
        directory,
        signal,
        scratchLimit,
        reserveBytes,
        retainedBytes: () =>
          [...this.#jobs.values()].reduce(
            (sum, entry) => sum + (entry === job ? 0 : entry.status.archiveBytes ?? 0),
            0,
          ),
        progress: (bytes) => {
          job.status.archiveBytes = bytes;
        },
      });
      const captured = await collectProjectBundle({
        source,
        rootVersion,
        signal: writer.signal,
        maxBytes: configured,
        writeFile: writer.writeFile,
        progress: (_phase, projects, bytes) => {
          job.status.projects = projects;
          job.status.bytes = bytes;
        },
      });
      await writer.writeFile(
        'README.txt',
        'Rivet project bundle\n\nExtract the complete ZIP. Install a release of @valerypopoff/rivet2-node that exports loadProjectBundle (bundle schema 1).\n' +
          'Older npm releases cannot load this bundle. Create run.mjs in the extracted directory:\n\n' +
          'import { loadProjectBundle } from "@valerypopoff/rivet2-node";\n' +
          'const bundle = await loadProjectBundle("./rivet-bundle.json");\n' +
          'const runner = bundle.createProcessor({ inputs: {} }); // Add your graph inputs. Main Graph is selected by default.\n' +
          'try { console.log(await runner.run()); } finally { runner.dispose(); }\n\n' +
          'Run node run.mjs from this directory. Configure your provider credentials and environment variables first.\n' +
          'All targets are frozen saved snapshots from export time, including Saved latest targets of a published root. Unsaved editor changes are excluded.\n' +
          'Datasets are included; modifications during execution remain in memory. Project/dataset files may contain sensitive values.\n' +
          'Configure credentials, custom providers, external services and local file paths separately. Install required Code-node packages locally.\n' +
          'Plugin declarations (no automatic installation):\n' +
          JSON.stringify(captured.manifest.plugins, null, 2),
      );
      job.status.phase = 'packaging';
      await this.#save(job);
      const completed = await writer.finish();
      await captured.verify();
      await writer.checkCapacity();
      job.status.archiveBytes = completed.bytes;
      job.status.archiveHash = completed.sha256;
      signal.throwIfAborted();
      await fs.rename(archive, path.join(directory, 'bundle.zip'));
      job.status.phase = 'ready';
      job.status.expiresAt = new Date(Date.now() + this.retentionMs).toISOString();
      await this.#save(job);
    } catch (error) {
      await writer?.abort(error);
      // Collection can wrap an abort as a dependency failure; preserve the writer's
      // deliberate capacity error while still redacting raw filesystem exceptions.
      error = writer?.error ?? error;
      job.status.phase = signal.aborted ? 'cancelled' : 'failed';
      // Deliberate domain errors only; nested storage/SQL/file exceptions may contain secrets and paths.
      job.status.error =
        error instanceof ProjectBundleError
          ? error.message
          : 'Could not prepare the bundle. Check dependencies, source integrity and available disk space, then retry.';
      try {
        await fs.rm(path.join(directory, 'bundle.zip'), { force: true });
        await fs.rm(path.join(directory, 'bundle.partial'), { force: true });
        delete job.status.archiveBytes;
        delete job.status.archiveHash;
      } catch {
        // A failed archive unlink still owns disk until cleanup succeeds.
        // Never forget its retained bytes or admit another export around it.
        this.#markCleanupFailed(job);
      }
      await this.#save(job).catch(() => {});
    } finally {
      clearTimeout(timeout);
    }
  }
  async status(id: string): Promise<ProjectBundleJobStatus> {
    await this.cleanup();
    const job = this.#requireJob(id);
    await this.#settleTerminalJob(job);
    return structuredClone(job.status);
  }
  async #settleTerminalJob(job: Job) {
    // Terminal acknowledgement includes writer drain, durable publication and
    // release of the packaging slot. Otherwise retry can receive 409, or a ready
    // archive can escape before its journal write fails and revokes readiness.
    if (!['collecting', 'packaging'].includes(job.status.phase)) await job.done;
  }
  #requireJob(id: string): Job {
    const job = this.#jobs.get(id);
    if (!ID.test(id) || !job) throw createHttpError(404, 'Project bundle export not found or expired.');
    return job;
  }
  async #assertArchive(archive: string, status: ProjectBundleJobStatus) {
    const stat = await fs.lstat(archive);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== status.archiveBytes)
      throw new Error('Archive unavailable');
  }
  async download(id: string) {
    await this.cleanup();
    const job = this.#requireJob(id);
    await this.#settleTerminalJob(job);
    const status = structuredClone(job.status);
    if (status.phase !== 'ready') throw createHttpError(409, 'Project bundle is not ready.');
    const archive = path.join(this.#root, id, 'bundle.zip');
    // Reserve before asynchronous filesystem work: expiry/cancellation must not unlink an active download.
    job.readers += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        job.readers -= 1;
      }
    };
    try {
      await this.#assertArchive(archive, status);
      return { archive, status, release };
    } catch {
      release();
      throw createHttpError(409, 'Bundle archive is unavailable. Prepare it again.');
    }
  }
  async cancel(id: string) {
    await this.cleanup();
    const job = this.#requireJob(id);
    // Retries/multiple windows share one journal update and removal operation.
    job.cancelling ??= this.#cancel(job).finally(() => {
      job.cancelling = undefined;
    });
    await job.cancelling;
  }
  async #cancel(job: Job) {
    job.controller.abort();
    await job.done;
    job.status.phase = 'cancelled';
    job.status.expiresAt = new Date(0).toISOString();
    // Protect the journal write from concurrent expiry, then use the single removal owner.
    job.readers += 1;
    try {
      await this.#save(job);
    } finally {
      job.readers -= 1;
    }
    await this.cleanup();
  }
  async dispose() {
    this.#disposed = true;
    // An initialization failure has already rejected the requesting operation.
    // Still drain any resources created before it failed during shutdown.
    await this.#initialization?.catch(() => {});
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer);
    for (const job of this.#jobs.values()) if (job.done) job.controller.abort();
    await Promise.all([...this.#jobs.values()].map((job) => job.done));
  }
}

/** Deployment mounts supply disk-backed storage; standalone callers may choose their own base. */
export function getProjectBundleScratchRoot() {
  const configured = process.env.RIVET_PROJECT_BUNDLE_SCRATCH_ROOT?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error('RIVET_PROJECT_BUNDLE_SCRATCH_ROOT must be an absolute directory path.');
  }
  return path.join(
    configured || os.tmpdir(),
    `rivet-project-bundles-${createHash('sha256').update(getWorkflowsRoot()).digest('hex').slice(0, 16)}`,
  );
}

export const projectBundleJobs = new ProjectBundleJobs(getProjectBundleScratchRoot());

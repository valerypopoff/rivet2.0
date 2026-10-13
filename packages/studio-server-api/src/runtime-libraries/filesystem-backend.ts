import type { RuntimeLibraryJobObserver } from './job-observation.js';

import type {
  JobStatus,
  RuntimeLibrariesState,
  RuntimeLibraryReplicaCleanupResult,
  RuntimeLibraryJobLogEntry,
  RuntimeLibraryJobState,
  RuntimeLibraryPackageSpec,
} from '../../../studio-server-shared/runtime-library-types.js';
import { ensureDirectories, getRootPath, readManifest, prepareLocalRuntimeLibraries } from './manifest.js';
import { jobRunner } from './job-runner.js';
import type { RuntimeLibrariesBackend } from './backend.js';
import { conflict, createHttpError } from '../utils/httpError.js';

function mapRuntimeLibrariesFilesystemError(error: unknown, operation: 'read' | 'write'): Error {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code !== 'EACCES' && code !== 'EPERM') {
    return error instanceof Error ? error : new Error(String(error));
  }

  const targetDir = getRootPath().replace(/\\/g, '/');
  return createHttpError(
    500,
    operation === 'write'
      ? `Runtime-library storage is not writable. Check server permissions for ${targetDir}.`
      : `Runtime-library storage is not readable. Check server permissions for ${targetDir}.`,
    { expose: true },
  );
}

function mapJob(
  job: {
    id: string;
    type: 'install' | 'remove';
    status: JobStatus;
    packages: Array<{ name: string; version: string }>;
    logs: string[];
    logEntries: RuntimeLibraryJobLogEntry[];
    error?: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    lastProgressAt: string;
    cancelRequestedAt?: string | null;
  } | null,
): RuntimeLibraryJobState | null {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    packages: job.packages,
    logs: job.logs,
    logEntries: job.logEntries,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastProgressAt: job.lastProgressAt,
    cancelRequestedAt: job.cancelRequestedAt ?? null,
  };
}

class FilesystemRuntimeLibrariesBackend implements RuntimeLibrariesBackend {
  private draining = false;

  beginDrain(): void {
    this.draining = true;
  }

  private assertAdmission(): void {
    if (this.draining) throw new Error('Runtime-library services are draining.');
  }

  async initialize(): Promise<void> {
    this.assertAdmission();
    try {
      ensureDirectories();
    } catch (error) {
      throw mapRuntimeLibrariesFilesystemError(error, 'write');
    }
  }

  async checkHealth(): Promise<void> {
    await this.getState();
  }

  async prepareForExecution(): Promise<void> {
    this.assertAdmission();
    await prepareLocalRuntimeLibraries();
  }

  async dispose(): Promise<void> {
    this.beginDrain();
    await jobRunner.drain(true);
  }

  async getState(): Promise<RuntimeLibrariesState> {
    try {
      ensureDirectories();
    } catch (error) {
      throw mapRuntimeLibrariesFilesystemError(error, 'write');
    }

    let manifest;
    try {
      manifest = readManifest();
    } catch (error) {
      throw mapRuntimeLibrariesFilesystemError(error, 'read');
    }

    const activeJob = jobRunner.getActiveJob();

    return {
      backend: 'filesystem',
      packages: manifest.packages,
      hasActiveLibraries: Object.keys(manifest.packages).length > 0,
      updatedAt: manifest.updatedAt,
      activeJob: jobRunner.isRunning() ? mapJob(activeJob) : null,
      activeReleaseId: manifest.activeReleaseId ?? null,
      replicaReadiness: null,
    };
  }

  async enqueueInstall(packages: RuntimeLibraryPackageSpec[]): Promise<RuntimeLibraryJobState> {
    this.assertAdmission();
    if (jobRunner.isRunning()) {
      const active = jobRunner.getActiveJob()!;
      throw conflict(`A job is already running (job ${active.id})`);
    }

    try {
      ensureDirectories();
    } catch (error) {
      throw mapRuntimeLibrariesFilesystemError(error, 'write');
    }

    return mapJob(jobRunner.startInstall(packages))!;
  }

  async enqueueRemove(packageNames: string[]): Promise<RuntimeLibraryJobState> {
    this.assertAdmission();
    if (jobRunner.isRunning()) {
      const active = jobRunner.getActiveJob()!;
      throw conflict(`A job is already running (job ${active.id})`);
    }

    try {
      ensureDirectories();
    } catch (error) {
      throw mapRuntimeLibrariesFilesystemError(error, 'write');
    }

    return mapJob(jobRunner.startRemove(packageNames))!;
  }

  async getJob(jobId: string): Promise<RuntimeLibraryJobState | null> {
    return mapJob(jobRunner.getJob(jobId));
  }

  async cancelJob(jobId: string): Promise<RuntimeLibraryJobState | null> {
    return mapJob(jobRunner.cancelJob(jobId));
  }

  async clearStaleReplicaStatuses(): Promise<RuntimeLibraryReplicaCleanupResult> {
    return {
      deletedReplicaCount: 0,
      deletedReplicaIds: [],
      staleBefore: new Date().toISOString(),
    };
  }

  subscribeJob(jobId: string, observer: RuntimeLibraryJobObserver): () => void {
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      jobRunner.off('log', changed);
      jobRunner.off('status', changed);
    };
    const changed = (changedId: string) => {
      if (closed || changedId !== jobId) return;
      try {
        observer.state(mapJob(jobRunner.getJob(jobId)));
      } catch (error) {
        stop();
        // Observation failures must never become durable job failures.
        try {
          observer.error(error);
        } catch {
          /* This observation is retired. */
        }
      }
    };
    jobRunner.on('log', changed);
    jobRunner.on('status', changed);
    return stop;
  }
}

export function createFilesystemRuntimeLibrariesBackend(): RuntimeLibrariesBackend {
  return new FilesystemRuntimeLibrariesBackend();
}

import type { Request, Response } from 'express';

import type {
  JobStatus,
  RuntimeLibrariesState,
  RuntimeLibraryReplicaCleanupResult,
  RuntimeLibraryJobLogEntry,
  RuntimeLibraryJobState,
  RuntimeLibraryLogSource,
  RuntimeLibraryPackageSpec,
} from '../../../shared/runtime-library-types.js';
import { currentNodeModulesPath, ensureDirectories, getRootPath, readManifest } from './manifest.js';
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

function mapJob(job: {
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
} | null): RuntimeLibraryJobState | null {
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
  async initialize(): Promise<void> {
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
    // Filesystem mode already resolves directly from the local runtime root.
  }

  async dispose(): Promise<void> {
    // No background resources to release in filesystem mode.
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

  streamJob(req: Request, res: Response): void {
    const job = jobRunner.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    for (const entry of job.logEntries) {
      res.write(`data: ${JSON.stringify({ type: 'log', message: entry.message, createdAt: entry.createdAt, source: entry.source })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: 'status', status: job.status, createdAt: job.lastProgressAt, cancelRequestedAt: job.cancelRequestedAt ?? null })}\n\n`);

    if (job.status === 'succeeded' || job.status === 'failed') {
      res.write(`data: ${JSON.stringify({ type: 'done', status: job.status, error: job.error, createdAt: job.lastProgressAt, cancelRequestedAt: job.cancelRequestedAt ?? null })}\n\n`);
      res.end();
      return;
    }

    const onLog = (jobId: string, message: string, createdAt: string, source: RuntimeLibraryLogSource) => {
      if (jobId !== req.params.jobId) {
        return;
      }

      res.write(`data: ${JSON.stringify({ type: 'log', message, createdAt, source })}\n\n`);
    };

    const onStatus = (jobId: string, status: JobStatus, createdAt: string, cancelRequestedAt: string | null) => {
      if (jobId !== req.params.jobId) {
        return;
      }

      res.write(`data: ${JSON.stringify({ type: 'status', status, createdAt, cancelRequestedAt })}\n\n`);

      if (status === 'succeeded' || status === 'failed') {
        const finishedJob = jobRunner.getJob(jobId);
        res.write(`data: ${JSON.stringify({ type: 'done', status, error: finishedJob?.error, createdAt: finishedJob?.lastProgressAt, cancelRequestedAt: finishedJob?.cancelRequestedAt ?? null })}\n\n`);
        cleanup();
        res.end();
      }
    };

    const keepalive = setInterval(() => {
      res.write(':keepalive\n\n');
    }, 30_000);

    const cleanup = () => {
      clearInterval(keepalive);
      jobRunner.removeListener('log', onLog);
      jobRunner.removeListener('status', onStatus);
    };

    jobRunner.on('log', onLog);
    jobRunner.on('status', onStatus);

    req.on('close', cleanup);
  }
}

export function createFilesystemRuntimeLibrariesBackend(): RuntimeLibrariesBackend {
  return new FilesystemRuntimeLibrariesBackend();
}

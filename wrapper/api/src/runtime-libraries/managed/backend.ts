import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';

import type { Request, Response } from 'express';

import { checkPostgresPoolHealth } from '../../managed-health.js';
import type { RuntimeHealthCheckContext } from '../../runtime-health.js';

import type {
  RuntimeLibraryPackageSpec,
} from '../../../../shared/runtime-library-types.js';
import type { RuntimeLibrariesBackend } from '../backend.js';
import { createHttpError } from '../../utils/httpError.js';
import { createManagedRuntimeLibrariesArtifactActivation } from './artifact-activation.js';
import {
  createManagedRuntimeLibrariesContext,
  type ManagedRuntimeLibrariesContext,
} from './context.js';
import { createManagedRuntimeLibrariesJobStore } from './job-store.js';
import { streamManagedRuntimeLibraryJob } from './job-stream.js';
import { createManagedRuntimeLibrariesJobWorker } from './job-worker.js';
import { createManagedRuntimeLibrariesProcessRegistry } from './process-registry.js';
import { clearManagedRuntimeLibraryStaleReplicaStatuses } from './replica-status.js';
import {
  ensureManagedRuntimeLibrariesSchema,
  normalizeJobPackages,
} from './schema.js';
import { getManagedJob, getManagedRuntimeLibrariesState } from './state.js';
import { getRootPath } from '../manifest.js';
import type { RuntimeLibrariesBlobStore } from './blob-store.js';

export class ManagedRuntimeLibrariesBackend implements RuntimeLibrariesBackend {
  readonly #context: ManagedRuntimeLibrariesContext;
  readonly #jobStore: ReturnType<typeof createManagedRuntimeLibrariesJobStore>;
  readonly #processRegistry: ReturnType<typeof createManagedRuntimeLibrariesProcessRegistry>;
  readonly #artifactActivation: ReturnType<typeof createManagedRuntimeLibrariesArtifactActivation>;
  readonly #jobWorker: ReturnType<typeof createManagedRuntimeLibrariesJobWorker>;

  #initializePromise: Promise<void> | null = null;
  #disposePromise: Promise<void> | null = null;
  #stopped = false;

  constructor(blobStore?: RuntimeLibrariesBlobStore) {
    this.#context = createManagedRuntimeLibrariesContext(blobStore);
    this.#jobStore = createManagedRuntimeLibrariesJobStore({
      context: this.#context,
      terminateRunningProcess: (jobId, reason) => this.#processRegistry.terminateRunningProcess(jobId, reason),
    });
    this.#processRegistry = createManagedRuntimeLibrariesProcessRegistry({
      appendJobLog: (jobId, message, source) => this.#jobStore.appendJobLog(jobId, message, source),
    });
    this.#artifactActivation = createManagedRuntimeLibrariesArtifactActivation({
      context: this.#context,
      jobStore: this.#jobStore,
      processRegistry: this.#processRegistry,
    });
    this.#jobWorker = createManagedRuntimeLibrariesJobWorker({
      context: this.#context,
      isStopped: () => this.#stopped,
      syncForLocalUse: (force) => this.#context.syncForLocalUse(force),
      getProcessManagedSync: () => this.#context.getProcessManagedSync(),
      jobStore: this.#jobStore,
      artifactActivation: this.#artifactActivation,
    });
  }

  async initialize(): Promise<void> {
    if (this.#stopped) {
      throw new Error('Managed runtime-library backend is shutting down.');
    }
    if (this.#initializePromise) {
      return this.#initializePromise;
    }

    this.#initializePromise = (async () => {
      this.#context.ensureLocalFilesystemReady();
      await this.#context.blobStore.initialize?.();
      await ensureManagedRuntimeLibrariesSchema(this.#context.pool);
      await this.#context.syncForLocalUse(true);
      if (this.#stopped) return;
      if (this.#context.config.jobWorkerEnabled) {
        this.#jobWorker.startWorkerLoop();
      } else {
        console.log('[runtime-libraries] Managed job worker disabled for this process; running in sync-only mode.');
      }
    })();

    try {
      await this.#initializePromise;
    } catch (error) {
      this.#initializePromise = null;
      throw error;
    }
  }

  async checkHealth(context?: RuntimeHealthCheckContext): Promise<void> {
    await this.initialize();
    await Promise.all([
      checkPostgresPoolHealth(this.#context.pool, context),
      this.#context.blobStore.checkHealth?.(context),
      fs.access(getRootPath(), fsConstants.R_OK | fsConstants.W_OK),
    ]);
  }

  async prepareForExecution(): Promise<void> {
    await this.initialize();
    await this.#context.syncForLocalUse(true);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;

    this.#stopped = true;
    this.#jobWorker.reset();
    this.#processRegistry.terminateAll('Runtime-library backend is shutting down.');
    this.#disposePromise = (async () => {
      await this.#initializePromise?.catch(() => undefined);
      this.#initializePromise = null;
      this.#context.localCache.reset();
      this.#processRegistry.clear();
      try {
        await this.#context.pool.end();
      } finally {
        this.#context.blobStore.dispose?.();
      }
    })();
    return this.#disposePromise;
  }

  async getState() {
    await this.initialize();
    return getManagedRuntimeLibrariesState(this.#context.pool, this.#context.config.syncPollIntervalMs);
  }

  async enqueueInstall(packages: RuntimeLibraryPackageSpec[]) {
    await this.initialize();
    const normalizedPackages = normalizeJobPackages(packages);
    if (normalizedPackages.length === 0) {
      throw createHttpError(400, 'packages array is required and must not be empty');
    }

    return this.#jobStore.insertJob('install', normalizedPackages);
  }

  async enqueueRemove(packageNames: string[]) {
    await this.initialize();
    const normalizedPackages = normalizeJobPackages(packageNames.map((name) => ({ name, version: '' })));
    if (normalizedPackages.length === 0) {
      throw createHttpError(400, 'packages array is required and must not be empty');
    }

    return this.#jobStore.insertJob('remove', normalizedPackages);
  }

  async getJob(jobId: string) {
    await this.initialize();
    return getManagedJob(this.#context.pool, jobId);
  }

  async cancelJob(jobId: string) {
    await this.initialize();
    return this.#jobStore.cancelJob(jobId);
  }

  async clearStaleReplicaStatuses() {
    await this.initialize();
    return clearManagedRuntimeLibraryStaleReplicaStatuses(this.#context);
  }

  async streamJob(req: Request, res: Response): Promise<void> {
    await this.initialize();
    return streamManagedRuntimeLibraryJob(req, res, {
      getJob: (jobId) => this.getJob(jobId),
    });
  }
}

import type { Request, Response } from 'express';

import type { RuntimeHealthCheckContext } from '../runtime-health.js';

import type {
  RuntimeLibrariesState,
  RuntimeLibraryReplicaCleanupResult,
  RuntimeLibraryJobState,
  RuntimeLibraryPackageSpec,
} from '../../../studio-server-shared/runtime-library-types.js';
import { createFilesystemRuntimeLibrariesBackend } from './filesystem-backend.js';
import { getRuntimeLibrariesBackendMode } from './config.js';
import { ManagedRuntimeLibrariesBackend } from './managed/backend.js';

export interface RuntimeLibrariesBackend {
  initialize(): Promise<void>;
  checkHealth?(context?: RuntimeHealthCheckContext): Promise<void>;
  prepareForExecution(): Promise<void>;
  getState(): Promise<RuntimeLibrariesState>;
  enqueueInstall(packages: RuntimeLibraryPackageSpec[]): Promise<RuntimeLibraryJobState>;
  enqueueRemove(packageNames: string[]): Promise<RuntimeLibraryJobState>;
  getJob(jobId: string): Promise<RuntimeLibraryJobState | null>;
  cancelJob(jobId: string): Promise<RuntimeLibraryJobState | null>;
  clearStaleReplicaStatuses(): Promise<RuntimeLibraryReplicaCleanupResult>;
  streamJob(req: Request, res: Response): Promise<void> | void;
  dispose?(): Promise<void>;
}

let runtimeLibrariesBackend: RuntimeLibrariesBackend | null = null;

export function getRuntimeLibrariesBackend(): RuntimeLibrariesBackend {
  if (runtimeLibrariesBackend) {
    return runtimeLibrariesBackend;
  }

  runtimeLibrariesBackend = getRuntimeLibrariesBackendMode() === 'managed'
    ? new ManagedRuntimeLibrariesBackend()
    : createFilesystemRuntimeLibrariesBackend();

  return runtimeLibrariesBackend;
}

export async function initializeRuntimeLibrariesBackend(): Promise<void> {
  await getRuntimeLibrariesBackend().initialize();
}

export async function checkRuntimeLibrariesHealth(context?: RuntimeHealthCheckContext): Promise<void> {
  if (!process.env.RIVET_RUNTIME_LIBRARIES_ROOT?.trim()) return;
  const backend = getRuntimeLibrariesBackend();
  await backend.checkHealth?.(context);
}

export async function prepareRuntimeLibrariesForExecution(): Promise<void> {
  await getRuntimeLibrariesBackend().prepareForExecution();
}

export async function disposeRuntimeLibrariesBackend(): Promise<void> {
  if (!runtimeLibrariesBackend) {
    return;
  }

  await runtimeLibrariesBackend.dispose?.();
  runtimeLibrariesBackend = null;
}

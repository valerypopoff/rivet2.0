import type { RuntimeLibraryJobObserver } from './job-observation.js';

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
import { RuntimeLibraryServices } from './services.js';

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
  subscribeJob(jobId: string, observer: RuntimeLibraryJobObserver): () => void;
  beginDrain?(): void;
  dispose?(): Promise<void>;
}

let services: RuntimeLibraryServices | undefined;
let draining = false;

export function getRuntimeLibrariesBackend(): RuntimeLibrariesBackend {
  if (!services) {
    if (draining) throw new Error('Runtime-library services are draining.');
    const mode = getRuntimeLibrariesBackendMode();
    services = new RuntimeLibraryServices(() =>
      mode === 'managed' ? new ManagedRuntimeLibrariesBackend() : createFilesystemRuntimeLibrariesBackend(),
    );
  }
  return services.get();
}

export function beginRuntimeLibrariesDrain(): void {
  draining = true;
  services?.beginDrain();
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
  const owner = services;
  if (!owner) return;
  await owner.dispose();
  if (services === owner) services = undefined;
}

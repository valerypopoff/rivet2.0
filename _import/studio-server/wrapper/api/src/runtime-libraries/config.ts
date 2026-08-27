import {
  getManagedWorkflowStorageConfig,
  getWorkflowStorageBackendMode,
  type ManagedWorkflowStorageConfig,
} from '../routes/workflows/storage-config.js';
import { badRequest } from '../utils/httpError.js';
import { parseBoolean, parsePositiveInt } from '../utils/env-parsing.js';
import type {
  RuntimeLibrariesBackendMode,
  RuntimeLibraryProcessRole,
  RuntimeLibraryReplicaTier,
} from '../../../shared/runtime-library-types.js';

export type ManagedRuntimeLibrariesConfig = Omit<ManagedWorkflowStorageConfig, 'objectStoragePrefix'> & {
  objectStoragePrefix: string;
  syncPollIntervalMs: number;
  runtimeProcessRole: RuntimeLibraryProcessRole;
  runtimeReplicaTier: RuntimeLibraryReplicaTier | 'none';
  replicaStatusRetentionMs: number;
  replicaStatusCleanupIntervalMs: number;
  jobWorkerEnabled: boolean;
};

export const MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX = 'runtime-libraries/';

const RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS';
const RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS';
const RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS';
const RUNTIME_PROCESS_ROLE_ENV_NAME = 'RIVET_RUNTIME_PROCESS_ROLE';
const RUNTIME_REPLICA_TIER_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_REPLICA_TIER';
const RUNTIME_LIBRARIES_JOB_WORKER_ENABLED_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED';
const RETIRED_ENV_REPLACEMENTS = {
  RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS: RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME,
} as const;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function inferRuntimeProcessRole(): RuntimeLibraryProcessRole {
  const rawExplicitRole = readEnv(RUNTIME_PROCESS_ROLE_ENV_NAME);
  const explicitRole = rawExplicitRole?.toLowerCase();
  if (explicitRole === 'api' || explicitRole === 'executor') {
    return explicitRole;
  }

  if (rawExplicitRole) {
    throw badRequest(
      `Invalid configuration value "${rawExplicitRole}" for ${RUNTIME_PROCESS_ROLE_ENV_NAME}. ` +
      'Expected "api" or "executor".',
    );
  }

  const argv = process.argv.join(' ').toLowerCase();
  if (argv.includes('executor-bundle') || argv.includes('app-executor')) {
    return 'executor';
  }

  return 'api';
}

function inferRuntimeReplicaTier(runtimeProcessRole: RuntimeLibraryProcessRole): RuntimeLibraryReplicaTier | 'none' {
  const rawExplicitTier = readEnv(RUNTIME_REPLICA_TIER_ENV_NAME);
  const explicitTier = rawExplicitTier?.toLowerCase();
  if (explicitTier === 'endpoint' || explicitTier === 'editor' || explicitTier === 'none') {
    return explicitTier;
  }

  if (rawExplicitTier) {
    throw badRequest(
      `Invalid configuration value "${rawExplicitTier}" for ${RUNTIME_REPLICA_TIER_ENV_NAME}. ` +
      'Expected "endpoint", "editor", or "none".',
    );
  }

  return runtimeProcessRole === 'executor' ? 'editor' : 'endpoint';
}

function getDefaultReplicaStatusRetentionMs(databaseMode: ManagedRuntimeLibrariesConfig['databaseMode']): number {
  return databaseMode === 'local-docker'
    ? 24 * 60 * 60 * 1_000
    : 15 * 60 * 1_000;
}

function getDefaultReplicaStatusCleanupIntervalMs(databaseMode: ManagedRuntimeLibrariesConfig['databaseMode']): number {
  return databaseMode === 'local-docker'
    ? 15 * 60 * 1_000
    : 5 * 60 * 1_000;
}

function assertNoRetiredEnv(): void {
  const activeRetired = Object.entries(RETIRED_ENV_REPLACEMENTS)
    .filter(([name]) => Boolean(process.env[name]?.trim()))
    .map(([name, replacement]) => `${name} -> ${replacement}`);

  if (activeRetired.length === 0) {
    return;
  }

  throw badRequest(
    `Retired environment variable(s) detected: ${activeRetired.join(', ')}. ` +
    'Use the canonical runtime-library tuning env names.',
  );
}

export function getRuntimeLibrariesBackendMode(): RuntimeLibrariesBackendMode {
  assertNoRetiredEnv();
  return getWorkflowStorageBackendMode();
}

export function isManagedRuntimeLibrariesEnabled(): boolean {
  return getRuntimeLibrariesBackendMode() === 'managed';
}

export function getManagedRuntimeLibrariesConfig(): ManagedRuntimeLibrariesConfig {
  assertNoRetiredEnv();
  const workflowConfig = getManagedWorkflowStorageConfig();
  const replicaStatusRetentionMs = parsePositiveInt(
    readEnv(RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_ENV_NAME),
    getDefaultReplicaStatusRetentionMs(workflowConfig.databaseMode),
  );
  const runtimeProcessRole = inferRuntimeProcessRole();

  return {
    ...workflowConfig,
    objectStoragePrefix: MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX,
    syncPollIntervalMs: parsePositiveInt(
      readEnv(RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME),
      5_000,
    ),
    runtimeProcessRole,
    runtimeReplicaTier: inferRuntimeReplicaTier(runtimeProcessRole),
    replicaStatusRetentionMs,
    replicaStatusCleanupIntervalMs: parsePositiveInt(
      readEnv(RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_ENV_NAME),
      getDefaultReplicaStatusCleanupIntervalMs(workflowConfig.databaseMode),
    ),
    jobWorkerEnabled: parseBoolean(
      readEnv(RUNTIME_LIBRARIES_JOB_WORKER_ENABLED_ENV_NAME),
      true,
    ),
  };
}

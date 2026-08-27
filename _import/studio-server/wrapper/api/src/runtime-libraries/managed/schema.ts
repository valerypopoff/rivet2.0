import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { MANAGED_POSTGRES_CONNECTION_TIMEOUT_MS } from '../../managed-health.js';
import { withManagedPostgresPoolMax } from '../../managed-postgres-pool.js';

import type {
  JobStatus,
  RuntimeLibraryEntry,
  RuntimeLibraryJobLogEntry,
  RuntimeLibraryJobState,
  RuntimeLibraryLogSource,
  RuntimeLibraryProcessRole,
  RuntimeLibraryPackageSpec,
  RuntimeLibraryReplicaReadinessState,
  RuntimeLibraryReplicaStatus,
  RuntimeLibraryReplicaSyncState,
  RuntimeLibraryReplicaTier,
} from '../../../../shared/runtime-library-types.js';
import type { ManagedRuntimeLibrariesConfig } from '../config.js';

export type RuntimeLibraryReleaseRow = {
  release_id: string;
  packages_json: unknown;
  artifact_blob_key: string;
  artifact_sha256: string;
  created_at: Date | string;
};

export type RuntimeLibraryActivationRow = {
  release_id: string | null;
  packages_json: unknown | null;
  artifact_blob_key: string | null;
  artifact_sha256: string | null;
  created_at: Date | string | null;
  updated_at: Date | string;
};

export type RuntimeLibraryJobRow = {
  job_id: string;
  type: 'install' | 'remove';
  status: JobStatus;
  packages_json: unknown;
  error: string | null;
  claimed_by: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  progress_at: Date | string | null;
  cancel_requested_at: Date | string | null;
  release_id: string | null;
};

export type RuntimeLibraryJobLogRow = {
  seq: number;
  message: string;
  source: RuntimeLibraryLogSource | null;
  created_at: Date | string;
};

export type RuntimeLibraryReplicaStatusRow = {
  replica_id: string;
  tier: RuntimeLibraryReplicaTier;
  process_role: RuntimeLibraryProcessRole;
  display_name: string;
  hostname: string;
  pod_name: string | null;
  target_release_id: string | null;
  synced_release_id: string | null;
  sync_state: RuntimeLibraryReplicaSyncState;
  last_error: string | null;
  last_sync_started_at: Date | string | null;
  last_sync_completed_at: Date | string | null;
  last_heartbeat_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

export const MANAGED_RUNTIME_LIBRARIES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runtime_library_jobs (
  job_id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('install', 'remove')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'validating', 'activating', 'succeeded', 'failed')),
  packages_json JSONB NOT NULL,
  error TEXT NULL,
  release_id TEXT NULL,
  claimed_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  progress_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancel_requested_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_library_jobs_single_active_idx
  ON runtime_library_jobs ((1))
  WHERE status IN ('queued', 'running', 'validating', 'activating');

CREATE INDEX IF NOT EXISTS runtime_library_jobs_created_at_idx
  ON runtime_library_jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_library_releases (
  release_id TEXT PRIMARY KEY,
  packages_json JSONB NOT NULL,
  artifact_blob_key TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS runtime_library_activation (
  slot TEXT PRIMARY KEY,
  active_release_id TEXT NULL REFERENCES runtime_library_releases(release_id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO runtime_library_activation(slot, active_release_id)
VALUES ('default', NULL)
ON CONFLICT (slot) DO NOTHING;

CREATE TABLE IF NOT EXISTS runtime_library_job_logs (
  seq BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES runtime_library_jobs(job_id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  source TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS runtime_library_job_logs_job_id_seq_idx
  ON runtime_library_job_logs(job_id, seq);

CREATE TABLE IF NOT EXISTS runtime_library_replica_status (
  replica_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('endpoint', 'editor')),
  process_role TEXT NOT NULL CHECK (process_role IN ('api', 'executor')),
  display_name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  pod_name TEXT NULL,
  target_release_id TEXT NULL,
  synced_release_id TEXT NULL,
  sync_state TEXT NOT NULL CHECK (sync_state IN ('starting', 'syncing', 'ready', 'error')),
  last_error TEXT NULL,
  last_sync_started_at TIMESTAMPTZ NULL,
  last_sync_completed_at TIMESTAMPTZ NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS runtime_library_replica_status_tier_heartbeat_idx
  ON runtime_library_replica_status(tier, last_heartbeat_at DESC);

CREATE INDEX IF NOT EXISTS runtime_library_replica_status_updated_at_idx
  ON runtime_library_replica_status(updated_at DESC);

ALTER TABLE runtime_library_jobs
  ADD COLUMN IF NOT EXISTS progress_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE runtime_library_jobs
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ NULL;

ALTER TABLE runtime_library_job_logs
  ADD COLUMN IF NOT EXISTS source TEXT NULL;
`;

// Serialize managed runtime-library schema initialization across pods/processes.
// The DDL above includes ALTER TABLE statements that can deadlock when multiple
// replicas attempt first-run schema setup against the same Postgres database.
const MANAGED_RUNTIME_LIBRARIES_SCHEMA_LOCK = {
  classId: 8_071,
  objectId: 24_001,
} as const;

export const ACTIVE_JOB_STATUS_CLAUSE = `('queued', 'running', 'validating', 'activating')`;
export const JOB_HEARTBEAT_INTERVAL_MS = 5_000;
export const STALE_JOB_TIMEOUT_MS = 10 * 60_000;
export const CANCEL_POLL_INTERVAL_MS = 1_000;
export const PROCESS_TERMINATE_GRACE_MS = 5_000;
export const RUNTIME_LIBRARY_REPLICA_STATUS_CLEANUP_INTERVAL_MS = 15 * 60_000;
export const RUNTIME_LIBRARY_REPLICA_STATUS_RETENTION_MS = 24 * 60 * 60 * 1_000;

export class JobCancelledError extends Error {
  constructor(message = 'Cancelled by user') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

export function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function getRuntimeLibraryReplicaHeartbeatTtlMs(syncPollIntervalMs: number): number {
  return Math.max(syncPollIntervalMs * 3, 30_000);
}

export function normalizePackageMap(value: unknown): Record<string, RuntimeLibraryEntry> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([packageName, entry]) => {
        if (!packageName || typeof entry !== 'object' || entry == null || Array.isArray(entry)) {
          return null;
        }

        const record = entry as Record<string, unknown>;
        const version = typeof record.version === 'string' ? record.version.trim() : '';
        if (!version) {
          return null;
        }

        return [
          packageName,
          {
            name: packageName,
            version,
            ...(typeof record.installedAt === 'string' ? { installedAt: record.installedAt } : {}),
          } satisfies RuntimeLibraryEntry,
        ] as const;
      })
      .filter((entry): entry is readonly [string, RuntimeLibraryEntry] => entry != null),
  );
}

export function normalizeJobPackages(value: unknown): RuntimeLibraryPackageSpec[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: RuntimeLibraryPackageSpec[] = [];

  for (const entry of value) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const version = typeof record.version === 'string' ? record.version.trim() : '';
    if (!name || seen.has(name)) {
      continue;
    }

    normalized.push({ name, version });
    seen.add(name);
  }

  return normalized;
}

export function mapJobRow(row: RuntimeLibraryJobRow, logEntries: RuntimeLibraryJobLogEntry[]): RuntimeLibraryJobState {
  const createdAt = toIsoString(row.created_at) ?? new Date().toISOString();
  const startedAt = toIsoString(row.started_at) ?? undefined;
  const finishedAt = toIsoString(row.finished_at) ?? undefined;
  const lastProgressAt = toIsoString(row.progress_at)
    ?? logEntries[logEntries.length - 1]?.createdAt
    ?? startedAt
    ?? createdAt;

  return {
    id: row.job_id,
    type: row.type,
    status: row.status,
    packages: normalizeJobPackages(row.packages_json),
    logs: logEntries.map((entry) => entry.message),
    logEntries,
    ...(row.error ? { error: row.error } : {}),
    createdAt,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    releaseId: row.release_id,
    lastProgressAt,
    ...(row.cancel_requested_at ? { cancelRequestedAt: toIsoString(row.cancel_requested_at) } : {}),
  };
}

export function getPoolConfig(config: ManagedRuntimeLibrariesConfig) {
  const sharedConfig = {
    connectionString: config.databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: MANAGED_POSTGRES_CONNECTION_TIMEOUT_MS,
  };

  if (config.databaseSslMode === 'disable') {
    return withManagedPostgresPoolMax(sharedConfig);
  }

  return withManagedPostgresPoolMax({
    ...sharedConfig,
    ssl: {
      rejectUnauthorized: config.databaseSslMode === 'verify-full',
    },
  });
}

export async function queryRows<T extends QueryResultRow>(
  client: Pool | PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await client.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  client: Pool | PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await queryRows<T>(client, sql, params);
  return rows[0] ?? null;
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error != null && 'code' in error && String((error as { code?: unknown }).code ?? '') === '23505';
}

export async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function ensureManagedRuntimeLibrariesSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let pendingError: unknown = null;
  let lockAcquired = false;

  try {
    await client.query(
      'SELECT pg_advisory_lock($1::integer, $2::integer)',
      [MANAGED_RUNTIME_LIBRARIES_SCHEMA_LOCK.classId, MANAGED_RUNTIME_LIBRARIES_SCHEMA_LOCK.objectId],
    );
    lockAcquired = true;
    await client.query(MANAGED_RUNTIME_LIBRARIES_SCHEMA_SQL);
  } catch (error) {
    pendingError = error;
  } finally {
    if (lockAcquired) {
      try {
        await client.query(
          'SELECT pg_advisory_unlock($1::integer, $2::integer)',
          [MANAGED_RUNTIME_LIBRARIES_SCHEMA_LOCK.classId, MANAGED_RUNTIME_LIBRARIES_SCHEMA_LOCK.objectId],
        );
      } catch (unlockError) {
        if (pendingError) {
          console.warn(
            '[runtime-libraries] Failed to release managed schema advisory lock after a schema-init error:',
            unlockError,
          );
        } else {
          pendingError = unlockError;
        }
      }
    }

    client.release();
  }

  if (pendingError) {
    throw pendingError;
  }
}

import type { Pool } from 'pg';

import type {
  RuntimeLibrariesState,
  RuntimeLibraryJobLogEntry,
  RuntimeLibraryJobState,
  RuntimeLibraryReplicaReadinessState,
  RuntimeLibraryReplicaStatus,
  RuntimeLibraryReplicaStatus as RuntimeLibraryReplicaStatusContract,
  RuntimeLibraryReplicaSyncState,
  RuntimeLibraryReplicaTier,
  RuntimeLibraryReplicaTierState,
} from '../../../../shared/runtime-library-types.js';
import {
  ACTIVE_JOB_STATUS_CLAUSE,
  getRuntimeLibraryReplicaHeartbeatTtlMs,
  mapJobRow,
  normalizePackageMap,
  queryOne,
  queryRows,
  toIsoString,
  type RuntimeLibraryActivationRow,
  type RuntimeLibraryJobLogRow,
  type RuntimeLibraryJobRow,
  type RuntimeLibraryReplicaStatusRow,
} from './schema.js';

export async function getManagedJobLogs(pool: Pool, jobId: string): Promise<RuntimeLibraryJobLogEntry[]> {
  const rows = await queryRows<RuntimeLibraryJobLogRow>(
    pool,
    `
      SELECT seq, message, source, created_at
      FROM runtime_library_job_logs
      WHERE job_id = $1
      ORDER BY seq ASC
    `,
    [jobId],
  );

  return rows.map((row) => ({
    message: row.message,
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    source: row.source ?? 'system',
  }));
}

export async function getManagedJob(pool: Pool, jobId: string): Promise<RuntimeLibraryJobState | null> {
  const row = await queryOne<RuntimeLibraryJobRow>(
    pool,
    `
      SELECT job_id, type, status, packages_json, error, claimed_by, created_at, started_at, finished_at, progress_at, cancel_requested_at, release_id
      FROM runtime_library_jobs
      WHERE job_id = $1
    `,
    [jobId],
  );

  if (!row) {
    return null;
  }

  return mapJobRow(row, await getManagedJobLogs(pool, jobId));
}

export async function getManagedActiveJob(pool: Pool): Promise<RuntimeLibraryJobState | null> {
  const row = await queryOne<RuntimeLibraryJobRow>(
    pool,
    `
      SELECT job_id, type, status, packages_json, error, claimed_by, created_at, started_at, finished_at, progress_at, cancel_requested_at, release_id
      FROM runtime_library_jobs
      WHERE status IN ${ACTIVE_JOB_STATUS_CLAUSE}
      ORDER BY created_at ASC
      LIMIT 1
    `,
  );

  if (!row) {
    return null;
  }

  return mapJobRow(row, await getManagedJobLogs(pool, row.job_id));
}

export async function getManagedActiveRelease(pool: Pool): Promise<RuntimeLibraryActivationRow | null> {
  return queryOne<RuntimeLibraryActivationRow>(
    pool,
    `
      SELECT r.release_id, r.packages_json, r.artifact_blob_key, r.artifact_sha256, r.created_at, a.updated_at
      FROM runtime_library_activation a
      LEFT JOIN runtime_library_releases r ON r.release_id = a.active_release_id
      WHERE a.slot = 'default'
    `,
  );
}

const REPLICA_SYNC_STATE_PRIORITY: Record<RuntimeLibraryReplicaSyncState, number> = {
  error: 0,
  syncing: 1,
  starting: 2,
  ready: 3,
};

function getReplicaIdentityKey(row: RuntimeLibraryReplicaStatusRow): string {
  return [
    row.tier,
    row.process_role,
    row.pod_name?.trim() || row.display_name.trim(),
  ].join('\u0000');
}

function getRowTimestampMs(value: string | Date | null | undefined): number {
  const iso = toIsoString(value);
  if (!iso) {
    return Number.NEGATIVE_INFINITY;
  }

  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareReplicaStatusRowsByRecency(
  left: RuntimeLibraryReplicaStatusRow,
  right: RuntimeLibraryReplicaStatusRow,
): number {
  const heartbeatDelta = getRowTimestampMs(left.last_heartbeat_at) - getRowTimestampMs(right.last_heartbeat_at);
  if (heartbeatDelta !== 0) {
    return heartbeatDelta;
  }

  const updatedAtDelta = getRowTimestampMs(left.updated_at) - getRowTimestampMs(right.updated_at);
  if (updatedAtDelta !== 0) {
    return updatedAtDelta;
  }

  const createdAtDelta = getRowTimestampMs(left.created_at) - getRowTimestampMs(right.created_at);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.replica_id.localeCompare(right.replica_id);
}

function collapseReplicaStatusesByIdentity(rows: RuntimeLibraryReplicaStatusRow[]): RuntimeLibraryReplicaStatusRow[] {
  const latestRowsByIdentity = new Map<string, RuntimeLibraryReplicaStatusRow>();

  for (const row of rows) {
    const identityKey = getReplicaIdentityKey(row);
    const previous = latestRowsByIdentity.get(identityKey);
    if (!previous || compareReplicaStatusRowsByRecency(row, previous) > 0) {
      latestRowsByIdentity.set(identityKey, row);
    }
  }

  return [...latestRowsByIdentity.values()];
}

function compareReplicaStatuses(
  left: RuntimeLibraryReplicaStatusContract,
  right: RuntimeLibraryReplicaStatusContract,
): number {
  const priorityDelta = REPLICA_SYNC_STATE_PRIORITY[left.syncState] - REPLICA_SYNC_STATE_PRIORITY[right.syncState];
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const nameDelta = left.displayName.localeCompare(right.displayName);
  if (nameDelta !== 0) {
    return nameDelta;
  }

  return left.replicaId.localeCompare(right.replicaId);
}

function isReplicaReadyForActiveRelease(
  row: RuntimeLibraryReplicaStatusRow,
  activeReleaseId: string | null,
): boolean {
  if (row.sync_state !== 'ready') {
    return false;
  }

  if (activeReleaseId == null) {
    return row.target_release_id == null && row.synced_release_id == null;
  }

  return row.target_release_id === activeReleaseId && row.synced_release_id === activeReleaseId;
}

export function buildManagedRuntimeLibraryReplicaReadinessState(
  rows: RuntimeLibraryReplicaStatusRow[],
  activeReleaseId: string | null,
  heartbeatTtlMs: number,
  now = new Date(),
): RuntimeLibraryReplicaReadinessState {
  const collapsedRows = collapseReplicaStatusesByIdentity(rows);
  const liveCutoffMs = now.getTime() - heartbeatTtlMs;
  const liveRows = collapsedRows.filter((row) => (Date.parse(toIsoString(row.last_heartbeat_at) ?? '') || 0) >= liveCutoffMs);
  const staleRows = collapsedRows.filter((row) => (Date.parse(toIsoString(row.last_heartbeat_at) ?? '') || 0) < liveCutoffMs);

  const buildTierState = (tier: RuntimeLibraryReplicaTier): RuntimeLibraryReplicaTierState => {
    const tierLiveRows = liveRows.filter((row) => row.tier === tier);
    const tierStaleCount = staleRows.filter((row) => row.tier === tier).length;
    const replicas = tierLiveRows.map<RuntimeLibraryReplicaStatus>((row) => ({
      replicaId: row.replica_id,
      tier: row.tier,
      processRole: row.process_role,
      displayName: row.display_name,
      hostname: row.hostname,
      ...(row.pod_name ? { podName: row.pod_name } : {}),
      targetReleaseId: row.target_release_id,
      syncedReleaseId: row.synced_release_id,
      syncState: row.sync_state,
      isReadyForActiveRelease: isReplicaReadyForActiveRelease(row, activeReleaseId),
      lastHeartbeatAt: toIsoString(row.last_heartbeat_at) ?? new Date(0).toISOString(),
      ...(row.last_sync_started_at ? { lastSyncStartedAt: toIsoString(row.last_sync_started_at) ?? undefined } : {}),
      ...(row.last_sync_completed_at ? { lastSyncCompletedAt: toIsoString(row.last_sync_completed_at) ?? undefined } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
    })).sort(compareReplicaStatuses);

    return {
      tier,
      liveReplicaCount: replicas.length,
      readyReplicaCount: replicas.filter((replica) => replica.isReadyForActiveRelease).length,
      staleReplicaCount: tierStaleCount,
      replicas,
    };
  };

  return {
    activeReleaseId,
    heartbeatTtlMs,
    endpoint: buildTierState('endpoint'),
    editor: buildTierState('editor'),
  };
}

export async function getManagedReplicaReadiness(
  pool: Pool,
  syncPollIntervalMs: number,
  activeReleaseId: string | null,
): Promise<RuntimeLibraryReplicaReadinessState> {
  const rows = await queryRows<RuntimeLibraryReplicaStatusRow>(
    pool,
    `
      SELECT replica_id, tier, process_role, display_name, hostname, pod_name, target_release_id, synced_release_id, sync_state, last_error, last_sync_started_at, last_sync_completed_at, last_heartbeat_at, created_at, updated_at
      FROM runtime_library_replica_status
    `,
  );

  return buildManagedRuntimeLibraryReplicaReadinessState(
    rows,
    activeReleaseId,
    getRuntimeLibraryReplicaHeartbeatTtlMs(syncPollIntervalMs),
  );
}

export async function getManagedRuntimeLibrariesState(
  pool: Pool,
  syncPollIntervalMs: number,
): Promise<RuntimeLibrariesState> {
  const [activeRelease, activeJob] = await Promise.all([
    getManagedActiveRelease(pool),
    getManagedActiveJob(pool),
  ]);

  const packages = activeRelease ? normalizePackageMap(activeRelease.packages_json) : {};
  const activeReleaseId = activeRelease?.release_id ?? null;
  const replicaReadiness = await getManagedReplicaReadiness(pool, syncPollIntervalMs, activeReleaseId);

  return {
    backend: 'managed',
    packages,
    hasActiveLibraries: Object.keys(packages).length > 0,
    updatedAt: toIsoString(activeRelease?.updated_at ?? activeRelease?.created_at) ?? new Date().toISOString(),
    activeJob,
    activeReleaseId,
    replicaReadiness,
  };
}

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { recordStudioMetrics } from '../metrics.js';
import type {
  ManagedWorkflowMaintenanceLease,
  ManagedWorkflowMaintenanceTask,
} from '../routes/workflows/managed/maintenance.js';

export const MANAGED_EVALUATION_RETENTION_MODE_ENV = 'RIVET_MANAGED_EVALUATION_RETENTION_MODE';

export type ManagedEvaluationRetentionMode = 'audit' | 'enforce' | 'disabled';

export type ManagedEvaluationRetentionConfig = Readonly<{
  mode: ManagedEvaluationRetentionMode;
  batchSize: number;
}>;

type ExpiredRecordingRow = QueryResultRow & {
  project_id: string;
  recording_id: string;
  run_id: string;
};

type SnapshotRow = QueryResultRow & {
  project_id: string;
  dataset_fingerprint: string;
};

function parseMode(value: string | undefined): ManagedEvaluationRetentionMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'enforce';
  if (normalized === 'disabled' || normalized === 'audit' || normalized === 'enforce') return normalized;
  throw new Error(`${MANAGED_EVALUATION_RETENTION_MODE_ENV} must be disabled, audit, or enforce when set.`);
}

/**
 * Temporary candidate recordings already carry their exact expiry in their
 * immutable reference. This setting decides whether the control-plane owner
 * merely reports candidates or removes them after all safety checks pass.
 */
export function getManagedEvaluationRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
  batchSize = 100,
): ManagedEvaluationRetentionConfig {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('Managed Evaluation retention requires a positive maintenance batch size.');
  }
  return { mode: parseMode(env[MANAGED_EVALUATION_RETENTION_MODE_ENV]), batchSize };
}

function expiredRecordingCandidatesSql(locking: boolean): string {
  return `
  SELECT recording.project_id, recording.recording_id, recording.run_id
  FROM evaluation_recordings AS recording
  WHERE recording.artifact_json->'reference'->>'retention' = 'temporary'
    AND recording.artifact_json->'reference'->>'expiresAt' IS NOT NULL
    AND (recording.artifact_json->'reference'->>'expiresAt')::timestamptz <= NOW()
    -- A hosted parent or outstanding job may still be finalizing its evidence.
    -- Do not turn a long-running trial into a missing replay artifact.
    AND NOT EXISTS (
      SELECT 1
      FROM evaluation_hosted_runs AS hosted
      WHERE hosted.project_id = recording.project_id
        AND hosted.run_id = recording.run_id
        AND hosted.status IN ('queued', 'running')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM evaluation_hosted_trial_jobs AS job
      WHERE job.project_id = recording.project_id
        AND job.run_id = recording.run_id
        AND job.status IN ('queued', 'claimed', 'accepted')
    )
  ORDER BY (recording.artifact_json->'reference'->>'expiresAt')::timestamptz ASC,
           recording.project_id ASC,
           recording.recording_id ASC
  ${locking ? 'FOR UPDATE OF recording SKIP LOCKED' : ''}
  LIMIT $1
`;
}

function orphanedSnapshotCandidatesSql(locking: boolean): string {
  return `
  SELECT snapshot.project_id, snapshot.dataset_fingerprint
  FROM evaluation_dataset_snapshots AS snapshot
  WHERE snapshot.created_at < NOW() - INTERVAL '1 hour'
    -- A run's provenance is the authoritative content-addressed reference.
    -- The hosted parent cannot exist without that run because of its FK.
    AND NOT EXISTS (
      SELECT 1
      FROM evaluation_runs AS run
      WHERE run.project_id = snapshot.project_id
        AND run.run_json #>> '{provenance,datasetFingerprint}' = snapshot.dataset_fingerprint
    )
  ORDER BY snapshot.created_at ASC, snapshot.project_id ASC, snapshot.dataset_fingerprint ASC
  ${locking ? 'FOR UPDATE OF snapshot SKIP LOCKED' : ''}
  LIMIT $1
`;
}

async function deleteExpiredRecording(client: PoolClient, candidate: ExpiredRecordingRow): Promise<boolean> {
  const deleted = await client.query(
    `
      DELETE FROM evaluation_recordings AS recording
      WHERE recording.project_id = $1
        AND recording.recording_id = $2
        AND recording.artifact_json->'reference'->>'retention' = 'temporary'
        AND recording.artifact_json->'reference'->>'expiresAt' IS NOT NULL
        AND (recording.artifact_json->'reference'->>'expiresAt')::timestamptz <= NOW()
        AND NOT EXISTS (
          SELECT 1
          FROM evaluation_hosted_runs AS hosted
          WHERE hosted.project_id = recording.project_id
            AND hosted.run_id = recording.run_id
            AND hosted.status IN ('queued', 'running')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM evaluation_hosted_trial_jobs AS job
          WHERE job.project_id = recording.project_id
            AND job.run_id = recording.run_id
            AND job.status IN ('queued', 'claimed', 'accepted')
        )
    `,
    [candidate.project_id, candidate.recording_id],
  );
  return deleted.rowCount === 1;
}

async function deleteOrphanedSnapshot(client: PoolClient, candidate: SnapshotRow): Promise<boolean> {
  const deleted = await client.query(
    `
      DELETE FROM evaluation_dataset_snapshots AS snapshot
      WHERE snapshot.project_id = $1
        AND snapshot.dataset_fingerprint = $2
        AND snapshot.created_at < NOW() - INTERVAL '1 hour'
        AND NOT EXISTS (
          SELECT 1
          FROM evaluation_runs AS run
          WHERE run.project_id = snapshot.project_id
            AND run.run_json #>> '{provenance,datasetFingerprint}' = snapshot.dataset_fingerprint
        )
    `,
    [candidate.project_id, candidate.dataset_fingerprint],
  );
  return deleted.rowCount === 1;
}

/**
 * Runs under the existing singleton PostgreSQL-fenced maintenance owner. It
 * intentionally handles only PostgreSQL-owned Evaluation metadata; if a
 * future artifact gains object-storage keys, it must add a separately
 * reviewed typed deletion reason and domain-specific reference verifier rather
 * than silently deleting its metadata or reusing the workflow adapter here.
 */
export function createManagedEvaluationRetentionTask(options: {
  config: ManagedEvaluationRetentionConfig;
  pool: Pool;
}): ManagedWorkflowMaintenanceTask {
  return async (lease: ManagedWorkflowMaintenanceLease): Promise<void> => {
    const mode = options.config.mode;
    if (mode === 'disabled') return;
    const activeMode: Exclude<ManagedEvaluationRetentionMode, 'disabled'> = mode;

    const client = await options.pool.connect();
    const result: {
      expiredRecordingCandidates: number;
      expiredRecordings: number;
      orphanedSnapshotCandidates: number;
      orphanedSnapshots: number;
    } = {
      expiredRecordingCandidates: 0,
      expiredRecordings: 0,
      orphanedSnapshotCandidates: 0,
      orphanedSnapshots: 0,
    };

    try {
      await client.query('BEGIN');
      await lease.assertCurrent(client);

      if (mode === 'audit') {
        const candidates = await client.query<ExpiredRecordingRow>(expiredRecordingCandidatesSql(false), [
          options.config.batchSize,
        ]);
        result.expiredRecordingCandidates = candidates.rows.length;
      } else {
        const candidates = await client.query<ExpiredRecordingRow>(expiredRecordingCandidatesSql(true), [
          options.config.batchSize,
        ]);
        for (const candidate of candidates.rows) {
          result.expiredRecordingCandidates += 1;
          await lease.assertCurrent(client);
          if (await deleteExpiredRecording(client, candidate)) result.expiredRecordings += 1;
        }
      }

      if (mode === 'audit') {
        const candidates = await client.query<SnapshotRow>(orphanedSnapshotCandidatesSql(false), [
          options.config.batchSize,
        ]);
        result.orphanedSnapshotCandidates = candidates.rows.length;
      } else {
        const candidates = await client.query<SnapshotRow>(orphanedSnapshotCandidatesSql(true), [
          options.config.batchSize,
        ]);
        for (const candidate of candidates.rows) {
          result.orphanedSnapshotCandidates += 1;
          await lease.assertCurrent(client);
          if (await deleteOrphanedSnapshot(client, candidate)) result.orphanedSnapshots += 1;
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    recordStudioMetrics((metrics) => {
      metrics.setManagedEvaluationRetention({
        mode: activeMode,
        expiredRecordingCandidates: result.expiredRecordingCandidates,
        orphanedSnapshotCandidates: result.orphanedSnapshotCandidates,
      });
      metrics.recordManagedEvaluationRetention({
        mode: activeMode,
        expiredRecordings: result.expiredRecordings,
        orphanedSnapshots: result.orphanedSnapshots,
      });
    });
  };
}

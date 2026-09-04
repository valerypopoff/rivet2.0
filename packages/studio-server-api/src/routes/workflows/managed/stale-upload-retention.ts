import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { recordStudioMetrics } from '../../../metrics.js';
import { isManagedWorkflowArtifactObjectKey } from './blob-store.js';
import type {
  ManagedObjectDeletionReason,
  ManagedWorkflowMaintenanceLease,
  ManagedWorkflowMaintenanceTask,
} from './maintenance.js';
import { findManagedWorkflowObjectReferences } from './workflow-object-references.js';

const DEFAULT_MINIMUM_CANDIDATE_AGE_HOURS = 24;
const DEFAULT_REQUIRED_COMPLETED_SCANS = 2;
const MINIMUM_CANDIDATE_AGE_HOURS = 24;
const MAXIMUM_CANDIDATE_AGE_HOURS = 720;
const MINIMUM_REQUIRED_COMPLETED_SCANS = 2;
const MAXIMUM_REQUIRED_COMPLETED_SCANS = 10;

export type ManagedStaleUploadRetentionMode = 'audit' | 'disabled' | 'enforce';

export type ManagedStaleUploadRetentionConfig = {
  batchSize: number;
  minimumCandidateAgeHours: number;
  mode: ManagedStaleUploadRetentionMode;
  requiredCompletedScans: number;
};

type CandidateRow = QueryResultRow & { subject_key: string };

function getBoundedInteger(
  value: string | undefined,
  variableName: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${variableName} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

/**
 * Stale uploads start in audit mode. Enforce is deliberately an explicit
 * opt-in after operators have reviewed the bounded finding/metric evidence.
 */
export function getManagedStaleUploadRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
  batchSize = 100,
): ManagedStaleUploadRetentionConfig {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('Managed stale-upload retention requires a positive maintenance batch size.');
  }
  const rawMode = env.RIVET_MANAGED_STALE_UPLOAD_RETENTION_MODE?.trim().toLowerCase();
  const mode: ManagedStaleUploadRetentionMode =
    !rawMode || rawMode === 'audit'
      ? 'audit'
      : rawMode === 'enforce' || rawMode === 'disabled'
        ? rawMode
        : (() => {
            throw new Error('RIVET_MANAGED_STALE_UPLOAD_RETENTION_MODE must be disabled, audit, or enforce.');
          })();
  return {
    batchSize,
    minimumCandidateAgeHours: getBoundedInteger(
      env.RIVET_MANAGED_STALE_UPLOAD_RETENTION_MINIMUM_CANDIDATE_AGE_HOURS,
      'RIVET_MANAGED_STALE_UPLOAD_RETENTION_MINIMUM_CANDIDATE_AGE_HOURS',
      DEFAULT_MINIMUM_CANDIDATE_AGE_HOURS,
      MINIMUM_CANDIDATE_AGE_HOURS,
      MAXIMUM_CANDIDATE_AGE_HOURS,
    ),
    mode,
    requiredCompletedScans: getBoundedInteger(
      env.RIVET_MANAGED_STALE_UPLOAD_RETENTION_REQUIRED_COMPLETED_SCANS,
      'RIVET_MANAGED_STALE_UPLOAD_RETENTION_REQUIRED_COMPLETED_SCANS',
      DEFAULT_REQUIRED_COMPLETED_SCANS,
      MINIMUM_REQUIRED_COMPLETED_SCANS,
      MAXIMUM_REQUIRED_COMPLETED_SCANS,
    ),
  };
}

function candidateSql(forUpdate: boolean, onlyRecognizedArtifacts: boolean): string {
  const recognizedArtifactPredicate = onlyRecognizedArtifacts
    ? `
      AND cardinality(string_to_array(finding.subject_key, '/')) = 4
      AND split_part(finding.subject_key, '/', 1) NOT IN ('.', '..')
      AND split_part(finding.subject_key, '/', 3) NOT IN ('.', '..')
      AND split_part(finding.subject_key, '/', 1) <> ''
      AND split_part(finding.subject_key, '/', 2) <> ''
      AND split_part(finding.subject_key, '/', 3) <> ''
      AND split_part(finding.subject_key, '/', 4) <> ''
      AND split_part(finding.subject_key, '/', 1) = btrim(split_part(finding.subject_key, '/', 1))
      AND split_part(finding.subject_key, '/', 2) = btrim(split_part(finding.subject_key, '/', 2))
      AND split_part(finding.subject_key, '/', 3) = btrim(split_part(finding.subject_key, '/', 3))
      AND split_part(finding.subject_key, '/', 4) = btrim(split_part(finding.subject_key, '/', 4))
      AND (
        (split_part(finding.subject_key, '/', 2) = 'revisions'
          AND split_part(finding.subject_key, '/', 4) IN ('project.rivet-project', 'dataset.rivet-data'))
        OR (split_part(finding.subject_key, '/', 2) = 'recordings'
          AND split_part(finding.subject_key, '/', 4) IN ('recording.rivet-recording', 'replay.rivet-project', 'replay.rivet-data'))
      )`
    : '';
  return `
    SELECT finding.subject_key
    FROM managed_reconciliation_findings AS finding
    WHERE finding.domain = 'workflows'
      AND finding.kind = 'unreferenced-object-candidate'
      AND finding.resolved_at IS NULL
      AND finding.last_completed_observed_generation = finding.last_observed_generation
      AND finding.consecutive_complete_scans >= $1
      AND finding.first_seen_at <= NOW() - ($2::integer * INTERVAL '1 hour')
      AND NOT EXISTS (
        SELECT 1
        FROM managed_object_deletion_outbox AS outbox
        WHERE outbox.object_key = finding.subject_key
          AND outbox.status IN ('pending', 'completed')
      )
      ${recognizedArtifactPredicate}
    ORDER BY finding.first_seen_at ASC, finding.subject_key ASC
    LIMIT $3
    ${forUpdate ? 'FOR UPDATE SKIP LOCKED' : ''}
  `;
}

/**
 * Turns only proven, well-formed workflow artifact candidates into a typed
 * deletion intent. It never deletes a blob itself: the outbox rechecks live
 * references at the final delete boundary and performs bounded retry.
 */
export function createManagedStaleUploadRetentionTask(options: {
  config: ManagedStaleUploadRetentionConfig;
  enqueueObjectDeletions: (
    client: PoolClient,
    reason: ManagedObjectDeletionReason,
    keys: Array<string | null | undefined>,
  ) => Promise<number>;
  pool: Pool;
}): ManagedWorkflowMaintenanceTask {
  return async (lease) => {
    if (options.config.mode === 'disabled') return;

    const client = await options.pool.connect();
    const result = { eligibleCandidates: 0, ineligibleCandidates: 0, queued: 0 };
    try {
      await client.query('BEGIN');
      await lease.assertCurrent(client);
      if (options.config.mode === 'audit') {
        const candidates = await client.query<CandidateRow>(candidateSql(false, false), [
          options.config.requiredCompletedScans,
          options.config.minimumCandidateAgeHours,
          options.config.batchSize,
        ]);
        for (const candidate of candidates.rows) {
          if (isManagedWorkflowArtifactObjectKey(candidate.subject_key)) result.eligibleCandidates += 1;
          else result.ineligibleCandidates += 1;
        }
      } else {
        // Lock one bounded page at once. This avoids reselecting locks held
        // by this transaction while still allowing another maintenance owner
        // to skip the entire page.
        const candidates = await client.query<CandidateRow>(candidateSql(true, true), [
          options.config.requiredCompletedScans,
          options.config.minimumCandidateAgeHours,
          options.config.batchSize,
        ]);
        for (const candidate of candidates.rows) {
          if (!isManagedWorkflowArtifactObjectKey(candidate.subject_key)) {
            result.ineligibleCandidates += 1;
            // A malformed finding has no deletion policy. It remains visible
            // to the authenticated reconciliation workflow and does not make
            // its way into a generic prefix cleanup.
            continue;
          }
          result.eligibleCandidates += 1;
          await lease.assertCurrent(client);
          const liveReferences = await findManagedWorkflowObjectReferences(client, [candidate.subject_key]);
          if (liveReferences.has(candidate.subject_key)) continue;
          result.queued += await options.enqueueObjectDeletions(client, 'workflow-stale-upload-reconciliation', [
            candidate.subject_key,
          ]);
        }
      }
      await lease.assertCurrent(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    recordStudioMetrics((metrics) => {
      metrics.setManagedStaleUploadRetention({
        eligibleCandidates: result.eligibleCandidates,
        ineligibleCandidates: result.ineligibleCandidates,
        mode: options.config.mode,
      });
      metrics.recordManagedStaleUploadRetention({ mode: options.config.mode, queued: result.queued });
    });
  };
}

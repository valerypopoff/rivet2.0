import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { getStudioMetrics, recordStudioMetrics, type MetricsManagedMaintenancePassOutcome } from '../../../metrics.js';
import type { ManagedWorkflowBlobStore } from './blob-store.js';
import { queryOne } from './db.js';

const MAINTENANCE_LEASE_NAME = 'managed-workflow-maintenance';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_MS = 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const MIN_INTERVAL_MS = 15 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_LEASE_MS = 15 * 1000;
const MAX_LEASE_MS = 10 * 60 * 1000;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 500;
const COMPLETED_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type ManagedWorkflowMaintenanceConfig = {
  enabled: boolean;
  intervalMs: number;
  leaseMs: number;
  batchSize: number;
};

export type ManagedWorkflowMaintenanceLease = {
  holderId: string;
  fencingToken: number;
  assertCurrent(client: PoolClient): Promise<void>;
};

export type ManagedWorkflowMaintenanceTask = (lease: ManagedWorkflowMaintenanceLease) => Promise<void>;

type LeaseRow = QueryResultRow & {
  fencing_token: number;
};

type OutboxRow = QueryResultRow & {
  object_key: string;
  attempt_count: number;
};

type OutboxMetricsRow = QueryResultRow & {
  entries: string;
  oldest_age_seconds: string | null;
  state: 'blocked' | 'claimed' | 'pending';
};

const OUTBOX_METRICS_STATES = ['pending', 'claimed', 'blocked'] as const;

const MANAGED_OBJECT_DELETION_ENQUEUE_SQL = `
  INSERT INTO managed_object_deletion_outbox (object_key, domain)
  SELECT object_key, $2
  FROM UNNEST($1::text[]) AS object_key
  ON CONFLICT (object_key) DO UPDATE
    SET domain = EXCLUDED.domain,
        status = 'pending',
        next_attempt_at = NOW(),
        attempt_count = 0,
        claim_holder_id = NULL,
        claim_fencing_token = NULL,
        claim_expires_at = NULL,
        last_error = NULL,
        completed_at = NULL,
        updated_at = NOW()
  WHERE managed_object_deletion_outbox.status = 'blocked'
`;

export class ManagedWorkflowMaintenanceLeaseLostError extends Error {
  constructor() {
    super('Managed maintenance lease was lost before the transaction could be fenced.');
    this.name = 'ManagedWorkflowMaintenanceLeaseLostError';
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new Error(`Expected a boolean value, received ${JSON.stringify(value)}.`);
}

function parseBoundedInteger(
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
    throw new Error(
      `Invalid ${variableName} ${JSON.stringify(value)}. Expected an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}

/**
 * Only the control/combined API process schedules maintenance by default. The
 * durable PostgreSQL lease still fences overlap during local rollouts, tests,
 * and any future control-plane high availability change.
 */
export function getManagedWorkflowMaintenanceConfig(
  env: NodeJS.ProcessEnv = process.env,
): ManagedWorkflowMaintenanceConfig {
  const profile = env.RIVET_API_PROFILE?.trim().toLowerCase();
  return {
    enabled: parseBoolean(env.RIVET_MANAGED_MAINTENANCE_ENABLED, profile !== 'execution'),
    intervalMs: parseBoundedInteger(
      env.RIVET_MANAGED_MAINTENANCE_INTERVAL_MS,
      'RIVET_MANAGED_MAINTENANCE_INTERVAL_MS',
      DEFAULT_INTERVAL_MS,
      MIN_INTERVAL_MS,
      MAX_INTERVAL_MS,
    ),
    leaseMs: parseBoundedInteger(
      env.RIVET_MANAGED_MAINTENANCE_LEASE_MS,
      'RIVET_MANAGED_MAINTENANCE_LEASE_MS',
      DEFAULT_LEASE_MS,
      MIN_LEASE_MS,
      MAX_LEASE_MS,
    ),
    batchSize: parseBoundedInteger(
      env.RIVET_MANAGED_MAINTENANCE_BATCH_SIZE,
      'RIVET_MANAGED_MAINTENANCE_BATCH_SIZE',
      DEFAULT_BATCH_SIZE,
      MIN_BATCH_SIZE,
      MAX_BATCH_SIZE,
    ),
  };
}

export function getManagedWorkflowMaintenanceRetryDelayMs(attemptCount: number): number {
  const boundedAttempt = Math.max(1, Math.min(Math.trunc(attemptCount), 13));
  return Math.min(60 * 60 * 1000, 1_000 * 2 ** (boundedAttempt - 1));
}

export function normalizeManagedObjectDeletionKeys(keys: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      keys.flatMap((key) => {
        const normalized = key?.trim();
        return normalized ? [normalized] : [];
      }),
    ),
  ];
}

/**
 * Queue only keys that a caller has explicitly created or removed. The outbox
 * is not a prefix scanner: a later worker still rechecks every key against
 * live metadata before deleting the object.
 */
async function enqueueManagedObjectDeletions(
  client: Pool | PoolClient,
  domain: string,
  keys: Array<string | null | undefined>,
): Promise<void> {
  const normalizedDomain = domain.trim();
  if (!normalizedDomain) throw new Error('Managed object deletion domains must not be empty.');
  const objectKeys = normalizeManagedObjectDeletionKeys(keys);
  if (objectKeys.length === 0) return;
  await client.query(MANAGED_OBJECT_DELETION_ENQUEUE_SQL, [objectKeys, normalizedDomain]);
}

export function createManagedWorkflowMaintenance(options: {
  pool: Pool;
  blobStore: ManagedWorkflowBlobStore;
  config?: ManagedWorkflowMaintenanceConfig;
  holderId?: string;
  logger?: Pick<Console, 'error' | 'info' | 'warn'>;
}) {
  const config = options.config ?? getManagedWorkflowMaintenanceConfig();
  const holderId = options.holderId?.trim() || randomUUID();
  const logger = options.logger ?? console;
  const tasks = new Map<string, ManagedWorkflowMaintenanceTask>();
  let timer: NodeJS.Timeout | undefined;
  let initialized = false;
  let disposed = false;
  let running: Promise<void> | null = null;
  let lastSuccessfulPassAtMs: number | null = null;
  let outboxMetricsRefresh: Promise<void> | null = null;

  const recordPass = (outcome: MetricsManagedMaintenancePassOutcome, attemptedAtMs: number): void => {
    recordStudioMetrics((metrics) => {
      metrics.setManagedMaintenance({ lastAttemptAtMs: attemptedAtMs, lastSuccessAtMs: lastSuccessfulPassAtMs });
      metrics.recordManagedMaintenancePass(outcome);
    });
  };

  const refreshOutboxMetrics = async (): Promise<void> => {
    let metrics;
    try {
      metrics = getStudioMetrics();
    } catch {
      return;
    }
    if (!metrics.enabled) return;

    try {
      const result = await options.pool.query<OutboxMetricsRow>(`
        WITH observable_outbox AS (
          SELECT
            CASE
              WHEN status = 'pending' AND claim_expires_at > NOW() THEN 'claimed'
              ELSE status
            END AS state,
            enqueued_at
          FROM managed_object_deletion_outbox
          WHERE status IN ('pending', 'blocked')
        )
        SELECT
          state,
          COUNT(*)::text AS entries,
          GREATEST(0, EXTRACT(EPOCH FROM NOW() - MIN(enqueued_at)))::text AS oldest_age_seconds
        FROM observable_outbox
        GROUP BY state
      `);
      const entries = { blocked: 0, claimed: 0, pending: 0 };
      const oldestAgeSeconds = { blocked: 0, claimed: 0, pending: 0 };
      for (const row of result.rows) {
        if (!OUTBOX_METRICS_STATES.includes(row.state)) continue;
        const count = Number(row.entries);
        const oldestAge = Number(row.oldest_age_seconds ?? '0');
        entries[row.state] = Number.isFinite(count) && count >= 0 ? count : 0;
        oldestAgeSeconds[row.state] = Number.isFinite(oldestAge) && oldestAge >= 0 ? oldestAge : 0;
      }
      metrics.setManagedObjectDeletionOutbox({ entries, oldestAgeSeconds });
    } catch {
      // The snapshot is observational. A transient pool/query failure must not
      // change the fenced maintenance pass or add an error path to deletion.
    }
  };
  const scheduleOutboxMetricsRefresh = (): void => {
    if (disposed || outboxMetricsRefresh) return;
    outboxMetricsRefresh = refreshOutboxMetrics()
      .catch(() => undefined)
      .finally(() => {
        outboxMetricsRefresh = null;
      });
  };

  const assertCurrent = async (client: PoolClient, fencingToken: number): Promise<void> => {
    const lease = await queryOne<LeaseRow>(
      client,
      `
        SELECT fencing_token
        FROM managed_maintenance_leases
        WHERE lease_name = $1
          AND holder_id = $2
          AND fencing_token = $3
          AND expires_at > NOW()
        FOR UPDATE
      `,
      [MAINTENANCE_LEASE_NAME, holderId, fencingToken],
    );
    if (!lease) {
      throw new ManagedWorkflowMaintenanceLeaseLostError();
    }
  };

  const acquireLease = async (): Promise<ManagedWorkflowMaintenanceLease | null> => {
    const lease = await queryOne<LeaseRow>(
      options.pool,
      `
        INSERT INTO managed_maintenance_leases (
          lease_name, holder_id, fencing_token, expires_at, updated_at
        )
        VALUES ($1, $2, 1, NOW() + ($3::bigint * INTERVAL '1 millisecond'), NOW())
        ON CONFLICT (lease_name) DO UPDATE
          SET holder_id = EXCLUDED.holder_id,
              fencing_token = CASE
                WHEN managed_maintenance_leases.holder_id = EXCLUDED.holder_id
                  THEN managed_maintenance_leases.fencing_token
                ELSE managed_maintenance_leases.fencing_token + 1
              END,
              expires_at = EXCLUDED.expires_at,
              updated_at = NOW()
          WHERE managed_maintenance_leases.expires_at <= NOW()
             OR managed_maintenance_leases.holder_id = EXCLUDED.holder_id
        RETURNING fencing_token
      `,
      [MAINTENANCE_LEASE_NAME, holderId, config.leaseMs],
    );
    if (!lease) return null;
    return {
      holderId,
      fencingToken: lease.fencing_token,
      assertCurrent: (client) => assertCurrent(client, lease.fencing_token),
    };
  };

  const isStillUnreferenced = async (objectKey: string): Promise<boolean> => {
    const reference = await queryOne<{ object_key: string }>(
      options.pool,
      `
        SELECT object_key
        FROM (
          SELECT project_blob_key AS object_key FROM workflow_revisions
          UNION ALL
          SELECT dataset_blob_key AS object_key FROM workflow_revisions WHERE dataset_blob_key IS NOT NULL
          UNION ALL
          SELECT recording_blob_key AS object_key FROM workflow_recordings
          UNION ALL
          SELECT replay_project_blob_key AS object_key FROM workflow_recordings
          UNION ALL
          SELECT replay_dataset_blob_key AS object_key FROM workflow_recordings WHERE replay_dataset_blob_key IS NOT NULL
        ) AS referenced_objects
        WHERE object_key = $1
        LIMIT 1
      `,
      [objectKey],
    );
    return !reference;
  };

  const markOutboxResult = async (
    lease: ManagedWorkflowMaintenanceLease,
    objectKey: string,
    result: 'completed' | 'blocked',
    errorMessage?: string,
  ): Promise<void> => {
    if (result === 'completed') {
      const updated = await options.pool.query<{ object_key: string }>(
        `
          UPDATE managed_object_deletion_outbox
          SET status = 'completed', completed_at = NOW(), last_error = NULL,
              claim_holder_id = NULL, claim_fencing_token = NULL, claim_expires_at = NULL,
              updated_at = NOW()
          WHERE object_key = $1 AND status = 'pending'
            AND claim_holder_id = $2 AND claim_fencing_token = $3
          RETURNING object_key
        `,
        [objectKey, lease.holderId, lease.fencingToken],
      );
      if (updated.rows.length > 0) {
        recordStudioMetrics((metrics) => metrics.recordManagedObjectDeletionOutbox('completed'));
      }
      return;
    }
    if (result === 'blocked') {
      const updated = await options.pool.query<{ object_key: string }>(
        `
          UPDATE managed_object_deletion_outbox
          SET status = 'blocked', last_error = $2,
              claim_holder_id = NULL, claim_fencing_token = NULL, claim_expires_at = NULL,
              updated_at = NOW()
          WHERE object_key = $1 AND status = 'pending'
            AND claim_holder_id = $3 AND claim_fencing_token = $4
          RETURNING object_key
        `,
        [
          objectKey,
          errorMessage ?? 'Object key is still referenced by managed workflow metadata.',
          lease.holderId,
          lease.fencingToken,
        ],
      );
      if (updated.rows.length > 0) {
        recordStudioMetrics((metrics) => metrics.recordManagedObjectDeletionOutbox('blocked'));
      }
      return;
    }
  };

  const drainOutbox = async (lease: ManagedWorkflowMaintenanceLease): Promise<void> => {
    for (let offset = 0; offset < config.batchSize; offset += 1) {
      const row = await queryOne<OutboxRow>(
        options.pool,
        `
          WITH next_object AS (
            SELECT object_key
            FROM managed_object_deletion_outbox
            WHERE status = 'pending'
              AND next_attempt_at <= NOW()
              AND (claim_expires_at IS NULL OR claim_expires_at <= NOW())
            ORDER BY enqueued_at ASC, object_key ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE managed_object_deletion_outbox AS outbox
          SET claim_holder_id = $1,
              claim_fencing_token = $2,
              claim_expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
              updated_at = NOW()
          FROM next_object
          WHERE outbox.object_key = next_object.object_key
          RETURNING outbox.object_key, outbox.attempt_count
        `,
        [lease.holderId, lease.fencingToken, config.leaseMs],
      );
      if (!row) break;

      try {
        if (!(await isStillUnreferenced(row.object_key))) {
          await markOutboxResult(lease, row.object_key, 'blocked');
          logger.error(
            `[managed-maintenance] Refusing to delete still-referenced object ${row.object_key}; marked the outbox entry blocked.`,
          );
          continue;
        }
        await options.blobStore.delete(row.object_key);
        await markOutboxResult(lease, row.object_key, 'completed');
      } catch (error) {
        const nextDelay = getManagedWorkflowMaintenanceRetryDelayMs(row.attempt_count + 1);
        const retried = await options.pool.query<{ object_key: string }>(
          `
            UPDATE managed_object_deletion_outbox
            SET attempt_count = attempt_count + 1,
                next_attempt_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
                last_error = $3,
                claim_holder_id = NULL, claim_fencing_token = NULL, claim_expires_at = NULL,
                updated_at = NOW()
            WHERE object_key = $1 AND status = 'pending'
              AND claim_holder_id = $4 AND claim_fencing_token = $5
            RETURNING object_key
          `,
          [
            row.object_key,
            nextDelay,
            error instanceof Error ? error.message : String(error),
            lease.holderId,
            lease.fencingToken,
          ],
        );
        if (retried.rows.length > 0) {
          recordStudioMetrics((metrics) => metrics.recordManagedObjectDeletionOutbox('retry'));
        }
        logger.warn(
          `[managed-maintenance] Object deletion failed for ${row.object_key}; retrying in ${nextDelay}ms.`,
          error,
        );
      }
    }

    await options.pool.query(
      `
        DELETE FROM managed_object_deletion_outbox
        WHERE status = 'completed'
          AND completed_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
      `,
      [COMPLETED_OUTBOX_RETENTION_MS],
    );
  };

  const runOnce = async (): Promise<void> => {
    if (!config.enabled || disposed) return;

    const attemptedAtMs = Date.now();
    let outboxDrained = false;
    let outcome: MetricsManagedMaintenancePassOutcome = 'not_owner';
    try {
      const lease = await acquireLease();
      if (!lease) return;

      let taskFailed = false;
      for (const [name, task] of [...tasks.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        try {
          await task(lease);
        } catch (error) {
          if (error instanceof ManagedWorkflowMaintenanceLeaseLostError) {
            outcome = 'lease_lost';
            logger.warn(`[managed-maintenance] Lease was lost while running ${name}; another owner will retry.`);
            return;
          }
          taskFailed = true;
          logger.error(`[managed-maintenance] Task ${name} failed; the next scheduled pass will retry.`, error);
        }
      }

      await drainOutbox(lease);
      outboxDrained = true;
      if (taskFailed) {
        outcome = 'failed';
      } else {
        outcome = 'completed';
        lastSuccessfulPassAtMs = Date.now();
      }
    } catch (error) {
      outcome = 'failed';
      throw error;
    } finally {
      recordPass(outcome, attemptedAtMs);
      if (outboxDrained) scheduleOutboxMetricsRefresh();
    }
  };

  const schedule = (): void => {
    if (!config.enabled || disposed) return;
    timer = setTimeout(() => {
      void requestRun();
    }, config.intervalMs);
    timer.unref();
  };

  const requestRun = (): Promise<void> => {
    if (!config.enabled || disposed) return Promise.resolve();
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!running) {
      running = runOnce()
        .catch((error) => {
          logger.error(
            '[managed-maintenance] Durable maintenance pass failed; the next scheduled pass will retry.',
            error,
          );
        })
        .finally(() => {
          running = null;
          schedule();
        });
    }
    return running;
  };

  return {
    get config() {
      return config;
    },
    registerTask(name: string, task: ManagedWorkflowMaintenanceTask): () => void {
      if (!name.trim()) throw new Error('Managed maintenance task names must not be empty.');
      if (tasks.has(name)) throw new Error(`Managed maintenance task ${JSON.stringify(name)} is already registered.`);
      tasks.set(name, task);
      return () => tasks.delete(name);
    },
    async enqueueObjectDeletions(
      client: PoolClient,
      domain: string,
      keys: Array<string | null | undefined>,
    ): Promise<void> {
      await enqueueManagedObjectDeletions(client, domain, keys);
    },
    async queueObjectDeletions(domain: string, keys: Array<string | null | undefined>): Promise<void> {
      await enqueueManagedObjectDeletions(options.pool, domain, keys);
    },
    async initialize(): Promise<void> {
      if (initialized || disposed) return;
      initialized = true;
      schedule();
    },
    requestRun,
    async runNow(): Promise<void> {
      await requestRun();
    },
    async dispose(): Promise<void> {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}

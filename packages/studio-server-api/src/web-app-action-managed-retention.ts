import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { recordStudioMetrics } from './metrics.js';
import type {
  ManagedWorkflowMaintenanceLease,
  ManagedWorkflowMaintenanceTask,
} from './routes/workflows/managed/maintenance.js';

export const MANAGED_WEB_APP_ACTION_RETENTION_MODE_ENV = 'RIVET_MANAGED_WEB_APP_ACTION_RETENTION_MODE';
export const MANAGED_WEB_APP_ACTION_RETENTION_HOURS_ENV = 'RIVET_MANAGED_WEB_APP_ACTION_RETENTION_HOURS';

export type ManagedWebAppActionRetentionMode = 'audit' | 'disabled' | 'enforce';

export type ManagedWebAppActionRetentionConfig = Readonly<{
  batchSize: number;
  mode: ManagedWebAppActionRetentionMode;
  retentionHours: number;
}>;

type TerminalRunRow = QueryResultRow & { run_id: string };

const DEFAULT_RETENTION_HOURS = 24;
const MIN_RETENTION_HOURS = 1;
const MAX_RETENTION_HOURS = 24 * 30;

function parseMode(value: string | undefined): ManagedWebAppActionRetentionMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'enforce';
  if (normalized === 'audit' || normalized === 'disabled' || normalized === 'enforce') return normalized;
  throw new Error(`${MANAGED_WEB_APP_ACTION_RETENTION_MODE_ENV} must be disabled, audit, or enforce when set.`);
}

function parseRetentionHours(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_RETENTION_HOURS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_RETENTION_HOURS || parsed > MAX_RETENTION_HOURS) {
    throw new Error(
      `${MANAGED_WEB_APP_ACTION_RETENTION_HOURS_ENV} must be an integer between ${MIN_RETENTION_HOURS} and ${MAX_RETENTION_HOURS} when set.`,
    );
  }
  return parsed;
}

/**
 * Web-app action rows are transport/reconnect state, not editor recordings.
 * The default preserves the existing 24-hour reconnect window. Kubernetes
 * starts in audit mode through the chart so operators can review volume before
 * enabling deletion. All durable cleanup runs only under the shared fenced
 * maintenance owner, never in a published action request.
 */
export function getManagedWebAppActionRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
  batchSize = 100,
): ManagedWebAppActionRetentionConfig {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('Managed web-app action retention requires a positive maintenance batch size.');
  }
  return {
    batchSize,
    mode: parseMode(env[MANAGED_WEB_APP_ACTION_RETENTION_MODE_ENV]),
    retentionHours: parseRetentionHours(env[MANAGED_WEB_APP_ACTION_RETENTION_HOURS_ENV]),
  };
}

function terminalCandidatesSql(locking: boolean): string {
  return `
    SELECT run_id
    FROM web_app_action_runs
    WHERE status <> 'running'
      AND updated_at < NOW() - ($1::integer * INTERVAL '1 hour')
    ORDER BY updated_at ASC, run_id ASC
    ${locking ? 'FOR UPDATE SKIP LOCKED' : ''}
    LIMIT $2
  `;
}

async function deleteTerminalRun(client: PoolClient, runId: string, retentionHours: number): Promise<boolean> {
  const deleted = await client.query(
    `
      DELETE FROM web_app_action_runs
      WHERE run_id = $1
        AND status <> 'running'
        AND updated_at < NOW() - ($2::integer * INTERVAL '1 hour')
    `,
    [runId, retentionHours],
  );
  return deleted.rowCount === 1;
}

/**
 * Runs transport-state retention under the PostgreSQL-fenced maintenance
 * owner. Published web-app action requests only create and update reconnect
 * rows; they never perform global retention work under endpoint load.
 */
export function createManagedWebAppActionRetentionTask(options: {
  config: ManagedWebAppActionRetentionConfig;
  pool: Pool;
}): ManagedWorkflowMaintenanceTask {
  return async (lease: ManagedWorkflowMaintenanceLease): Promise<void> => {
    const { config } = options;
    if (config.mode === 'disabled') return;
    const mode: Exclude<ManagedWebAppActionRetentionMode, 'disabled'> = config.mode;
    let candidates = 0;
    let deleted = 0;
    const client = await options.pool.connect();
    try {
      await client.query('BEGIN');
      await lease.assertCurrent(client);
      if (mode === 'audit') {
        const result = await client.query<TerminalRunRow>(terminalCandidatesSql(false), [
          config.retentionHours,
          config.batchSize,
        ]);
        candidates = result.rows.length;
      } else {
        for (let index = 0; index < config.batchSize; index += 1) {
          const candidate = (
            await client.query<TerminalRunRow>(terminalCandidatesSql(true), [config.retentionHours, 1])
          ).rows[0];
          if (!candidate) break;
          candidates += 1;
          await lease.assertCurrent(client);
          if (await deleteTerminalRun(client, candidate.run_id, config.retentionHours)) deleted += 1;
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
      metrics.setManagedWebAppActionRetention({ candidates, mode });
      metrics.recordManagedWebAppActionRetention({ deleted, mode });
    });
  };
}

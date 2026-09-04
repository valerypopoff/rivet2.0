import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  createManagedWebAppActionRetentionTask,
  getManagedWebAppActionRetentionConfig,
} from '../web-app-action-managed-retention.js';
import type { ManagedWorkflowMaintenanceLease } from '../routes/workflows/managed/maintenance.js';

type Query = { parameters: readonly unknown[]; sql: string };

class FakeRetentionPool {
  readonly deleted: string[] = [];
  readonly queries: Query[] = [];
  terminalRuns = [{ run_id: 'terminal-a' }, { run_id: 'terminal-b' }];
  deleteRowCount = 1;

  async connect() {
    return {
      query: async <T>(sql: string, parameters: readonly unknown[] = []) => {
        this.queries.push({ parameters, sql });
        const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
          return { rowCount: 0, rows: [] as T[] };
        }
        if (normalized.startsWith('select run_id from web_app_action_runs')) {
          const limit = Number(parameters[1]);
          const rows = limit === 1 ? this.terminalRuns.splice(0, 1) : this.terminalRuns.slice(0, limit);
          return { rowCount: rows.length, rows: rows as T[] };
        }
        if (normalized.startsWith('delete from web_app_action_runs')) {
          const runId = String(parameters[0]);
          if (this.deleteRowCount === 1) this.deleted.push(runId);
          return { rowCount: this.deleteRowCount, rows: [] as T[] };
        }
        throw new Error(`Unexpected retention SQL: ${normalized}`);
      },
      release() {},
    };
  }
}

function createLease(assertions: { count: number }): ManagedWorkflowMaintenanceLease {
  return {
    assertCurrent: async () => {
      assertions.count += 1;
    },
    fencingToken: 1,
    holderId: 'test-holder',
  };
}

test('managed web-app action retention has a bounded explicit lifecycle configuration', () => {
  assert.deepEqual(getManagedWebAppActionRetentionConfig({}, 5), {
    batchSize: 5,
    mode: 'enforce',
    retentionHours: 24,
  });
  assert.deepEqual(
    getManagedWebAppActionRetentionConfig(
      {
        RIVET_MANAGED_WEB_APP_ACTION_RETENTION_HOURS: '48',
        RIVET_MANAGED_WEB_APP_ACTION_RETENTION_MODE: 'audit',
      },
      5,
    ),
    {
      batchSize: 5,
      mode: 'audit',
      retentionHours: 48,
    },
  );
  assert.deepEqual(
    getManagedWebAppActionRetentionConfig(
      {
        RIVET_MANAGED_WEB_APP_ACTION_RETENTION_MODE: 'disabled',
      },
      5,
    ),
    {
      batchSize: 5,
      mode: 'disabled',
      retentionHours: 24,
    },
  );
  assert.throws(
    () => getManagedWebAppActionRetentionConfig({ RIVET_MANAGED_WEB_APP_ACTION_RETENTION_MODE: 'remove' }),
    /must be disabled, audit, or enforce/,
  );
  assert.throws(
    () => getManagedWebAppActionRetentionConfig({ RIVET_MANAGED_WEB_APP_ACTION_RETENTION_HOURS: '0' }),
    /must be an integer between 1 and 720/,
  );
  assert.throws(() => getManagedWebAppActionRetentionConfig({}, 0), /positive maintenance batch size/);
});

test('disabled retention does not open a maintenance connection', async () => {
  const task = createManagedWebAppActionRetentionTask({
    config: { batchSize: 1, mode: 'disabled', retentionHours: 24 },
    pool: {
      connect: async () => {
        throw new Error('disabled retention must not connect to PostgreSQL');
      },
    } as unknown as Pool,
  });

  await task(createLease({ count: 0 }));
});

test('audit mode is read-only and sees only expired terminal transport rows', async () => {
  const pool = new FakeRetentionPool();
  const assertions = { count: 0 };
  const task = createManagedWebAppActionRetentionTask({
    config: { batchSize: 10, mode: 'audit', retentionHours: 24 },
    pool: pool as unknown as Pool,
  });

  await task(createLease(assertions));

  assert.deepEqual(pool.deleted, []);
  assert.equal(assertions.count, 1);
  const candidateQuery = pool.queries.find((query) => query.sql.includes('SELECT run_id'));
  assert.match(candidateQuery?.sql ?? '', /status <> 'running'/);
  assert.match(candidateQuery?.sql ?? '', /updated_at < NOW\(\) - \(\$1::integer \* INTERVAL '1 hour'\)/);
  assert.doesNotMatch(candidateQuery?.sql ?? '', /FOR UPDATE/);
  assert.deepEqual(candidateQuery?.parameters, [24, 10]);
});

test('enforcement is bounded, fenced, and rechecks each terminal candidate before deletion', async () => {
  const pool = new FakeRetentionPool();
  const assertions = { count: 0 };
  const task = createManagedWebAppActionRetentionTask({
    config: { batchSize: 1, mode: 'enforce', retentionHours: 24 },
    pool: pool as unknown as Pool,
  });

  await task(createLease(assertions));

  assert.deepEqual(pool.deleted, ['terminal-a']);
  assert.ok(assertions.count >= 2, 'the lease is checked before selection and before destructive mutation');
  const candidateQuery = pool.queries.find((query) => query.sql.includes('SELECT run_id'));
  assert.match(candidateQuery?.sql ?? '', /FOR UPDATE SKIP LOCKED/);
  const deleteQuery = pool.queries.find((query) => query.sql.includes('DELETE FROM web_app_action_runs'));
  assert.match(deleteQuery?.sql ?? '', /status <> 'running'/);
  assert.deepEqual(deleteQuery?.parameters, ['terminal-a', 24]);
});

test('enforcement safely skips a row that is no longer terminal or expired', async () => {
  const pool = new FakeRetentionPool();
  pool.deleteRowCount = 0;
  const task = createManagedWebAppActionRetentionTask({
    config: { batchSize: 1, mode: 'enforce', retentionHours: 24 },
    pool: pool as unknown as Pool,
  });

  await task(createLease({ count: 0 }));

  assert.deepEqual(pool.deleted, []);
  assert.equal(pool.queries.filter((query) => query.sql.includes('DELETE FROM web_app_action_runs')).length, 1);
});

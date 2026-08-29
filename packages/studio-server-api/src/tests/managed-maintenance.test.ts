import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createManagedWorkflowMaintenance,
  getManagedWorkflowMaintenanceConfig,
  getManagedWorkflowMaintenanceRetryDelayMs,
  normalizeManagedObjectDeletionKeys,
} from '../routes/workflows/managed/maintenance.js';

test('managed maintenance defaults to the control plane and never to execution replicas', () => {
  assert.equal(getManagedWorkflowMaintenanceConfig({ RIVET_API_PROFILE: 'control' }).enabled, true);
  assert.equal(getManagedWorkflowMaintenanceConfig({ RIVET_API_PROFILE: 'combined' }).enabled, true);
  assert.equal(getManagedWorkflowMaintenanceConfig({ RIVET_API_PROFILE: 'execution' }).enabled, false);
  assert.equal(
    getManagedWorkflowMaintenanceConfig({
      RIVET_API_PROFILE: 'execution',
      RIVET_MANAGED_MAINTENANCE_ENABLED: 'true',
    }).enabled,
    true,
  );
});

test('managed maintenance rejects unsafe scheduling configuration', () => {
  assert.throws(
    () => getManagedWorkflowMaintenanceConfig({ RIVET_MANAGED_MAINTENANCE_INTERVAL_MS: '1' }),
    /RIVET_MANAGED_MAINTENANCE_INTERVAL_MS/,
  );
  assert.throws(
    () => getManagedWorkflowMaintenanceConfig({ RIVET_MANAGED_MAINTENANCE_LEASE_MS: 'not-a-number' }),
    /RIVET_MANAGED_MAINTENANCE_LEASE_MS/,
  );
  assert.throws(
    () => getManagedWorkflowMaintenanceConfig({ RIVET_MANAGED_MAINTENANCE_ENABLED: 'sometimes' }),
    /boolean value/,
  );
});

test('managed object deletions are normalized and failures back off without becoming terminal', () => {
  assert.deepEqual(normalizeManagedObjectDeletionKeys([' key-a ', '', null, 'key-a', 'key-b']), ['key-a', 'key-b']);
  assert.equal(getManagedWorkflowMaintenanceRetryDelayMs(1), 1_000);
  assert.equal(getManagedWorkflowMaintenanceRetryDelayMs(4), 8_000);
  assert.equal(getManagedWorkflowMaintenanceRetryDelayMs(99), 60 * 60 * 1000);
});
test('managed deletion enqueue batches keys and reopens a blocked key after a new deletion intent', async () => {
  const queries: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
  const maintenance = createManagedWorkflowMaintenance({
    pool: {} as never,
    blobStore: {} as never,
    config: { enabled: false, intervalMs: 60_000, leaseMs: 60_000, batchSize: 100 },
  });
  const client = {
    query: async (sql: string, parameters?: unknown[]) => {
      queries.push({ sql, parameters });
      return { rows: [] };
    },
  } as never;

  await maintenance.enqueueObjectDeletions(client, 'workflow-recording-deletion', [' key-a ', 'key-a', null, 'key-b']);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]?.parameters, [['key-a', 'key-b'], 'workflow-recording-deletion']);
  assert.match(queries[0]?.sql ?? '', /UNNEST\(\$1::text\[\]\)/u);
  assert.match(queries[0]?.sql ?? '', /WHERE managed_object_deletion_outbox\.status = 'blocked'/u);
  assert.match(queries[0]?.sql ?? '', /status = 'pending'/u);
});
function createMaintenanceLogger() {
  return {
    error: () => {},
    info: () => {},
    warn: () => {},
  };
}

test('managed maintenance claims an orphaned key once and marks it completed after object deletion', async () => {
  const queries: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
  let claimCount = 0;
  const deletedKeys: string[] = [];
  const pool = {
    query: async (sql: string, parameters?: unknown[]) => {
      queries.push({ sql, parameters });
      if (sql.includes('INSERT INTO managed_maintenance_leases')) {
        return { rows: [{ fencing_token: 7 }] };
      }
      if (sql.includes('WITH next_object')) {
        claimCount += 1;
        return { rows: claimCount === 1 ? [{ object_key: 'orphan/key', attempt_count: 0 }] : [] };
      }
      if (sql.includes('FROM (') && sql.includes('referenced_objects')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  } as never;
  const maintenance = createManagedWorkflowMaintenance({
    pool,
    blobStore: {
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    } as never,
    config: { enabled: true, intervalMs: 60_000, leaseMs: 60_000, batchSize: 1 },
    logger: createMaintenanceLogger(),
  });

  await maintenance.runNow();

  assert.deepEqual(deletedKeys, ['orphan/key']);
  assert.ok(
    queries.some(({ sql, parameters }) => sql.includes("SET status = 'completed'") && parameters?.[0] === 'orphan/key'),
  );
});

test('managed maintenance blocks live references and retains transient object-store failures for retry', async (context) => {
  await context.test('live reference is never deleted', async () => {
    const deletedKeys: string[] = [];
    let claimCount = 0;
    const queries: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
    const maintenance = createManagedWorkflowMaintenance({
      pool: {
        query: async (sql: string, parameters?: unknown[]) => {
          queries.push({ sql, parameters });
          if (sql.includes('INSERT INTO managed_maintenance_leases')) return { rows: [{ fencing_token: 3 }] };
          if (sql.includes('WITH next_object')) {
            claimCount += 1;
            return { rows: claimCount === 1 ? [{ object_key: 'live/key', attempt_count: 0 }] : [] };
          }
          if (sql.includes('FROM (') && sql.includes('referenced_objects'))
            return { rows: [{ object_key: 'live/key' }] };
          return { rows: [] };
        },
      } as never,
      blobStore: {
        delete: async (key: string) => {
          deletedKeys.push(key);
        },
      } as never,
      config: { enabled: true, intervalMs: 60_000, leaseMs: 60_000, batchSize: 1 },
      logger: createMaintenanceLogger(),
    });

    await maintenance.runNow();

    assert.deepEqual(deletedKeys, []);
    assert.ok(
      queries.some(({ sql, parameters }) => sql.includes("SET status = 'blocked'") && parameters?.[0] === 'live/key'),
    );
  });

  await context.test('a storage failure remains pending with the bounded retry delay', async () => {
    const queries: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
    let claimCount = 0;
    const maintenance = createManagedWorkflowMaintenance({
      pool: {
        query: async (sql: string, parameters?: unknown[]) => {
          queries.push({ sql, parameters });
          if (sql.includes('INSERT INTO managed_maintenance_leases')) return { rows: [{ fencing_token: 4 }] };
          if (sql.includes('WITH next_object')) {
            claimCount += 1;
            return { rows: claimCount === 1 ? [{ object_key: 'retry/key', attempt_count: 2 }] : [] };
          }
          if (sql.includes('FROM (') && sql.includes('referenced_objects')) return { rows: [] };
          return { rows: [] };
        },
      } as never,
      blobStore: {
        delete: async () => {
          throw new Error('object store unavailable');
        },
      } as never,
      config: { enabled: true, intervalMs: 60_000, leaseMs: 60_000, batchSize: 1 },
      logger: createMaintenanceLogger(),
    });

    await maintenance.runNow();

    assert.ok(
      queries.some(
        ({ sql, parameters }) =>
          sql.includes('SET attempt_count = attempt_count + 1') &&
          parameters?.[0] === 'retry/key' &&
          parameters?.[1] === 4_000,
      ),
    );
  });
});

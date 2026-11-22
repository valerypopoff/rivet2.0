import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { configureStudioMetrics, getStudioMetrics, resetStudioMetricsForTests } from '../metrics.js';
import {
  createManagedWorkflowMaintenance,
  getManagedWorkflowMaintenanceConfig,
  getManagedWorkflowMaintenanceRetryDelayMs,
  isManagedObjectDeletionReason,
} from '../routes/workflows/managed/maintenance.js';
import { createDeferred } from './helpers/managed-backend-harness.js';

function maintenanceFixture(
  t: TestContext,
  options: {
    rows?: (sql: string) => unknown[] | Promise<unknown[]>;
    onDelete?: () => void | Promise<void>;
  } = {},
) {
  const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
  const deleteCalls: string[] = [];
  const maintenance = createManagedWorkflowMaintenance({
    holderId: 'test-maintainer',
    pool: {
      query: async (sql: string, parameters?: unknown[]) => {
        queries.push({ sql, parameters });
        return {
          rows: sql.includes('INSERT INTO managed_maintenance_leases')
            ? [{ fencing_token: 7 }]
            : (await options.rows?.(sql)) ?? [],
        };
      },
    } as never,
    blobStore: {
      delete: async (key: string) => {
        deleteCalls.push(key);
        await options.onDelete?.();
      },
    } as never,
    config: { enabled: true, intervalMs: 60_000, leaseMs: 60_000, batchSize: 1 },
    staleUploadDeletionEnabled: false,
    logger: { error() {}, info() {}, warn() {} },
  });
  t.after(() => maintenance.dispose());
  return { maintenance, queries, deleteCalls };
}

test('maintenance defaults to the control plane; execution requires explicit enablement', () => {
  for (const [profile, enabled] of [
    ['control', true],
    ['combined', true],
    ['execution', false],
  ] as const)
    assert.equal(getManagedWorkflowMaintenanceConfig({ RIVET_API_PROFILE: profile }).enabled, enabled);
  assert.equal(
    getManagedWorkflowMaintenanceConfig({
      RIVET_API_PROFILE: 'execution',
      RIVET_MANAGED_MAINTENANCE_ENABLED: 'true',
    }).enabled,
    true,
  );
});

test('managed maintenance rejects unsafe scheduling configuration', () => {
  for (const [name, value, message] of [
    ['RIVET_MANAGED_MAINTENANCE_INTERVAL_MS', '1', /RIVET_MANAGED_MAINTENANCE_INTERVAL_MS/],
    ['RIVET_MANAGED_MAINTENANCE_LEASE_MS', 'not-a-number', /RIVET_MANAGED_MAINTENANCE_LEASE_MS/],
    ['RIVET_MANAGED_MAINTENANCE_ENABLED', 'sometimes', /boolean value/],
  ] as const)
    assert.throws(() => getManagedWorkflowMaintenanceConfig({ [name]: value }), message);
});

test('deletion reasons fail closed and retry delays remain bounded', () => {
  assert.equal(getManagedWorkflowMaintenanceRetryDelayMs(1), 1_000);
  assert.equal(getManagedWorkflowMaintenanceRetryDelayMs(4), 8_000);
  assert.equal(getManagedWorkflowMaintenanceRetryDelayMs(99), 60 * 60 * 1000);
  assert.equal(isManagedObjectDeletionReason('workflow-recording-deletion'), true);
  assert.equal(isManagedObjectDeletionReason('future-object-payload'), false);
});

test('enqueue normalizes a deletion batch in one query', async (t) => {
  const { maintenance, queries } = maintenanceFixture(t, {
    rows: () => [{ object_key: 'key-a' }, { object_key: 'key-b' }],
  });
  assert.equal(
    await maintenance.queueObjectDeletions('workflow-recording-deletion', [' key-a ', '', 'key-a', null, 'key-b']),
    2,
  );
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].parameters, [['key-a', 'key-b'], 'workflow-recording-deletion']);
});

test('maintenance runs immediately and on schedule, coalesces requests and stops on disposal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { maintenance } = maintenanceFixture(t);
  let runs = 0;
  maintenance.registerTask('retention', async () => {
    runs++;
  });
  await maintenance.initialize();
  assert.equal(runs, 0);
  await maintenance.runNow();
  assert.equal(runs, 1);
  t.mock.timers.tick(60_000);
  await maintenance.runNow();
  assert.equal(runs, 2);
  await maintenance.dispose();
  t.mock.timers.tick(60_000);
  await maintenance.runNow();
  assert.equal(runs, 2);
});

const deletionCases: Array<{
  name: string;
  result: 'completed' | 'blocked' | 'retry';
  blockedBy?: 'reference' | 'policy';
  failure?: 'lookup' | 'storage';
}> = [
  { name: 'deletes and completes an unreferenced object', result: 'completed' },
  { name: 'blocks a live object', result: 'blocked', blockedBy: 'reference' },
  { name: 'blocks stale uploads when enforcement is disabled', result: 'blocked', blockedBy: 'policy' },
  { name: 'retries a failed reference lookup without deleting', result: 'retry', failure: 'lookup' },
  { name: 'retains a failed storage deletion for retry', result: 'retry', failure: 'storage' },
];
for (const scenario of deletionCases)
  test(`outbox ${scenario.name}`, async (t) => {
    const key = 'fixture/key';
    const domain =
      scenario.blockedBy === 'policy' ? 'workflow-stale-upload-reconciliation' : 'workflow-recording-deletion';
    const failure = new Error('fixture dependency failure');
    let claims = 0;
    const { maintenance, queries, deleteCalls } = maintenanceFixture(t, {
      rows: (sql) => {
        if (sql.includes('WITH next_object'))
          return claims++ === 0 ? [{ object_key: key, domain, attempt_count: 2 }] : [];
        if (sql.includes('WITH referenced_objects')) {
          if (scenario.failure === 'lookup') throw failure;
          return scenario.blockedBy === 'reference' ? [{ object_key: key }] : [];
        }
        return sql.includes('RETURNING object_key') ? [{ object_key: key }] : [];
      },
      onDelete: () => {
        if (scenario.failure === 'storage') throw failure;
      },
    });
    await maintenance.runNow();
    assert.equal(claims, 1, 'one configured batch must issue only one claim');
    assert.deepEqual(deleteCalls, scenario.result === 'completed' || scenario.failure === 'storage' ? [key] : []);
    const transition = queries.find(({ sql }) =>
      sql.includes(
        scenario.result === 'retry' ? 'SET attempt_count = attempt_count + 1' : `SET status = '${scenario.result}'`,
      ),
    );
    assert.ok(transition, 'the claimed object must reach its expected durable state');
    const parameters = transition.parameters!;
    assert.equal(parameters[0], key);
    assert.deepEqual(parameters.slice(-2), ['test-maintainer', 7], 'updates retain the claim owner and token');
    if (scenario.result === 'retry') assert.deepEqual(parameters.slice(1, -2), [4_000, failure.message]);
    else if (scenario.result === 'blocked')
      assert.match(
        String(parameters[1]),
        scenario.blockedBy === 'policy' ? /audit-only or disabled/ : /still referenced/,
      );
    else assert.equal(parameters.length, 3);
  });

test('maintenance publishes pass and outbox observations outside the scrape path', async (t) => {
  configureStudioMetrics('control', { RIVET_METRICS_ENABLED: 'true' });
  let reads = 0;
  const { maintenance } = maintenanceFixture(t, {
    rows: (sql) => {
      if (!sql.includes('WITH observable_outbox')) return [];
      reads++;
      return [
        { entries: '3', oldest_age_seconds: '12.5', state: 'pending' },
        { entries: '1', oldest_age_seconds: '30', state: 'blocked' },
      ];
    },
  });
  t.after(resetStudioMetricsForTests);
  await maintenance.runNow();
  await nextTurn();
  assert.equal(reads, 1);
  const rendered = getStudioMetrics().render();
  assert.match(rendered, /rivet_managed_maintenance_passes_total\{outcome="completed",profile="control"\} 1/);
  assert.match(rendered, /rivet_managed_maintenance_last_success_timestamp_seconds\{profile="control"\} \d/);
  assert.match(rendered, /rivet_managed_object_deletion_outbox_entries\{profile="control",state="pending"\} 3/);
  assert.match(
    rendered,
    /rivet_managed_object_deletion_outbox_oldest_entry_age_seconds\{profile="control",state="blocked"\} 30/,
  );
  assert.match(rendered, /rivet_managed_object_deletion_outbox_entries\{profile="control",state="claimed"\} 0/);
});

test('an observational query failure cannot fail a successful maintenance pass', async (t) => {
  configureStudioMetrics('control', { RIVET_METRICS_ENABLED: 'true' });
  let reads = 0;
  const { maintenance } = maintenanceFixture(t, {
    rows: (sql) => {
      if (sql.includes('WITH observable_outbox')) {
        reads++;
        throw new Error('metrics query unavailable');
      }
      return [];
    },
  });
  t.after(resetStudioMetricsForTests);
  await maintenance.runNow();
  await nextTurn();
  assert.equal(reads, 1, 'exercise the failing snapshot, not just a completed pass');
  assert.match(
    getStudioMetrics().render(),
    /rivet_managed_maintenance_passes_total\{outcome="completed",profile="control"\} 1/,
  );
});

test('maintenance completes while its metrics snapshot remains blocked', { timeout: 5_000 }, async (t) => {
  configureStudioMetrics('control', { RIVET_METRICS_ENABLED: 'true' });
  const started = createDeferred<void>();
  const snapshot = createDeferred<unknown[]>();
  // Release before fixture disposal, including when a regression hits the test timeout.
  t.after(() => snapshot.resolve([]));
  const { maintenance } = maintenanceFixture(t, {
    rows: (sql) => {
      if (!sql.includes('WITH observable_outbox')) return [];
      started.resolve();
      return snapshot.promise;
    },
  });
  t.after(resetStudioMetricsForTests);
  const run = maintenance.runNow();
  await started.promise;
  await run;
});

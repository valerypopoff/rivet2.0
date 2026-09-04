import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool, PoolConfig } from 'pg';

import {
  DEFAULT_MANAGED_POSTGRES_POOL_MAX,
  getManagedPostgresPoolMax,
  ManagedPostgresPoolRegistry,
} from '../managed-postgres-pool.js';

type FakePool = Pool & {
  endCalls: number;
};

function createPoolHarness(env: NodeJS.ProcessEnv = {}) {
  const createdConfigs: PoolConfig[] = [];
  const pools: FakePool[] = [];
  const registry = new ManagedPostgresPoolRegistry((config) => {
    createdConfigs.push(config);
    const pool = {
      endCalls: 0,
      async end() {
        pool.endCalls += 1;
      },
    } as FakePool;
    pools.push(pool);
    return pool;
  }, env);

  return { createdConfigs, pools, registry };
}

test('managed PostgreSQL pool size uses a bounded deployment setting', () => {
  assert.equal(getManagedPostgresPoolMax({}), DEFAULT_MANAGED_POSTGRES_POOL_MAX);
  assert.equal(getManagedPostgresPoolMax({ RIVET_DEPLOYMENT_DATABASE_POOL_MAX: '7' }), 7);
  assert.equal(
    getManagedPostgresPoolMax({ RIVET_DEPLOYMENT_DATABASE_POOL_MAX: '0' }),
    DEFAULT_MANAGED_POSTGRES_POOL_MAX,
  );
});

test('managed PostgreSQL owners share an identical pool until the final lease is released', async () => {
  const { createdConfigs, pools, registry } = createPoolHarness({
    RIVET_DEPLOYMENT_DATABASE_POOL_MAX: '6',
  });
  const first = registry.acquire({
    connectionString: 'postgresql://rivet@example.test/rivet',
    keepAlive: true,
    ssl: { rejectUnauthorized: true },
  });
  const second = registry.acquire({
    ssl: { rejectUnauthorized: true },
    keepAlive: true,
    connectionString: 'postgresql://rivet@example.test/rivet',
  });

  assert.equal(createdConfigs.length, 1);
  assert.equal(createdConfigs[0]?.max, 6);
  assert.equal(first.pool, second.pool);

  await first.release();
  assert.equal(pools[0]?.endCalls, 0);
  await first.release();
  assert.equal(pools[0]?.endCalls, 0, 'a lease release must be idempotent');
  await second.release();
  assert.equal(pools[0]?.endCalls, 1);
});

test('managed PostgreSQL pools stay isolated across database identities', async () => {
  const { pools, registry } = createPoolHarness();
  const first = registry.acquire({ connectionString: 'postgresql://rivet@one.test/rivet' });
  const second = registry.acquire({ connectionString: 'postgresql://rivet@two.test/rivet' });

  assert.notEqual(first.pool, second.pool);
  assert.equal(pools.length, 2);

  await Promise.all([first.release(), second.release()]);
  assert.deepEqual(
    pools.map((pool) => pool.endCalls),
    [1, 1],
  );
});

test('managed PostgreSQL pool telemetry is an in-memory aggregate and tolerates an incomplete pool shim', async () => {
  const { pools, registry } = createPoolHarness();
  const first = registry.acquire({ connectionString: 'postgresql://rivet@one.test/rivet' });
  const second = registry.acquire({ connectionString: 'postgresql://rivet@two.test/rivet' });
  Object.assign(pools[0]!, { idleCount: 2, totalCount: 4, waitingCount: 1 });
  Object.assign(pools[1]!, { idleCount: 3, totalCount: 5, waitingCount: 0 });

  assert.deepEqual(registry.getMetrics(), { idle: 5, pools: 2, total: 9, waiting: 1 });
  await Promise.all([first.release(), second.release()]);
  assert.deepEqual(registry.getMetrics(), { idle: 0, pools: 0, total: 0, waiting: 0 });
});

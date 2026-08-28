import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createApiApp } from '../app.js';
import type { Pool } from 'pg';

import { checkPostgresPoolHealth } from '../managed-health.js';
import { RuntimeHealthController } from '../runtime-health.js';

const silentLogger = {
  error() {},
  log() {},
};

test('runtime readiness tracks dependencies while liveness survives draining', async () => {
  let dependencyAvailable = false;
  const health = new RuntimeHealthController('execution', [{
    name: 'workflow-storage',
    failureCode: 'workflow_storage_unavailable',
    async check() {
      if (!dependencyAvailable) throw new Error('database URL must not reach the response');
    },
  }], { logger: silentLogger });

  await health.start();
  const failed = health.getReadiness();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'dependency_unavailable');
  assert.deepEqual(failed.checks.map(({ code }) => code), ['workflow_storage_unavailable']);
  assert.equal(Object.isFrozen(failed.checks), true);
  assert.equal(Object.isFrozen(failed.checks[0]), true);
  assert.doesNotMatch(JSON.stringify(failed), /database URL/);

  dependencyAvailable = true;
  await health.refresh();
  assert.equal(health.getReadiness().ok, true);

  health.beginDrain();
  assert.equal(health.getReadiness().code, 'draining');
  assert.equal(health.getLiveness().ok, true);
  health.stop();
  assert.equal(health.getLiveness().ok, false);
});

test('runtime health deduplicates concurrent refreshes', async () => {
  let checks = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const health = new RuntimeHealthController('control', [{
    name: 'app-settings',
    failureCode: 'app_settings_unavailable',
    async check() {
      checks += 1;
      await blocked;
    },
  }], { logger: silentLogger });

  const first = health.refresh();
  const second = health.refresh();
  release();
  await Promise.all([first, second]);
  assert.equal(checks, 1);
  health.stop();
});

test('draining during the initial health refresh cannot reopen readiness', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const health = new RuntimeHealthController('execution', [{
    name: 'workflow-storage',
    failureCode: 'workflow_storage_unavailable',
    check: () => blocked,
  }], { logger: silentLogger });

  const starting = health.start();
  await new Promise((resolve) => setImmediate(resolve));
  health.beginDrain();
  release();
  await starting;

  assert.equal(health.getReadiness().state, 'draining');
  assert.equal(health.getReadiness().code, 'draining');
  assert.equal(health.getLiveness().ok, true);
  health.stop();
});

test('draining aborts cancellable dependency checks', async () => {
  let aborted = false;
  const health = new RuntimeHealthController('execution', [{
    name: 'workflow-storage',
    failureCode: 'workflow_storage_unavailable',
    check({ signal }) {
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  }], { checkTimeoutMs: 5_000, logger: silentLogger });

  const refreshing = health.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  health.beginDrain();
  await refreshing;

  assert.equal(aborted, true);
  assert.equal(health.getReadiness().code, 'draining');
  health.stop();
});
test('timed-out refreshes reuse the same underlying dependency check', async () => {
  let checks = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const health = new RuntimeHealthController('execution', [{
    name: 'workflow-storage',
    failureCode: 'workflow_storage_unavailable',
    async check() {
      checks += 1;
      await blocked;
    },
  }], { checkTimeoutMs: 100, logger: silentLogger });

  await health.refresh();
  await health.refresh();
  assert.equal(checks, 1);
  release();
  await blocked;
  await new Promise((resolve) => setImmediate(resolve));
  await health.refresh();
  assert.equal(checks, 2);
  health.stop();
});

test('timed-out cancellable checks can recover on the next refresh', async () => {
  let checks = 0;
  const health = new RuntimeHealthController('execution', [{
    name: 'workflow-storage',
    failureCode: 'workflow_storage_unavailable',
    check({ signal }) {
      checks += 1;
      if (checks > 1) return Promise.resolve();
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  }], { checkTimeoutMs: 100, logger: silentLogger });

  await health.refresh();
  assert.equal(health.getReadiness().checks[0]?.ok, false);
  await new Promise((resolve) => setImmediate(resolve));
  await health.refresh();

  assert.equal(checks, 2);
  assert.equal(health.getReadiness().checks[0]?.ok, true);
  health.stop();
});

test('aborting PostgreSQL health destroys the checked-out client', async () => {
  let queryText: string | undefined;
  const releases: unknown[] = [];
  const client = {
    query(text: string) {
      queryText = text;
      return new Promise<never>(() => {});
    },
    release(error?: unknown) {
      releases.push(error);
    },
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const controller = new AbortController();
  const checking = checkPostgresPoolHealth(pool, {
    signal: controller.signal,
    timeoutMs: 321,
  });
  await new Promise((resolve) => setImmediate(resolve));

  controller.abort(new Error('probe deadline'));
  await assert.rejects(checking, /probe deadline/);
  assert.equal(queryText, 'SELECT 1');
  assert.deepEqual(releases, [true]);
});
test('health endpoints use liveness and readiness independently', async () => {
  const app = createApiApp('execution', {
    health: {
      getLiveness: () => ({
        ok: true,
        profile: 'execution',
        state: 'draining',
        checkedAt: null,
        checks: [],
      }),
      getReadiness: () => ({
        ok: false,
        profile: 'execution',
        state: 'draining',
        checkedAt: null,
        checks: [],
        code: 'draining',
      }),
    },
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const [legacy, live, ready] = await Promise.all([
      fetch(`${baseUrl}/healthz`),
      fetch(`${baseUrl}/livez`),
      fetch(`${baseUrl}/readyz`),
    ]);
    assert.equal(legacy.status, 200);
    assert.deepEqual(await legacy.json(), { ok: true });
    assert.equal(live.status, 200);
    assert.equal(ready.status, 503);
    assert.equal(ready.headers.get('cache-control'), 'no-store');
    assert.equal((await ready.json() as { code: string }).code, 'draining');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

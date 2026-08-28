import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';

import { createPostgresRivetWebAppRunStore } from '../web-app-action-run-store.js';

type Query = {
  params: unknown[];
  text: string;
};

function createRunStorePool() {
  const queries: Query[] = [];
  const createdAt = new Date('2026-07-15T00:00:00.000Z');
  const run = {
    component_id: 'button-a',
    created_at: createdAt,
    host_id: 'runner-a',
    last_sequence: 0,
    lease_expires_at: new Date('2026-07-15T00:01:00.000Z'),
    lease_id: 'lease-a',
    owner_scope: 'owner-a',
    request_id: 'request-a',
    run_id: 'run-a',
    status: 'running' as const,
    updated_at: createdAt,
  };

  const client = {
    async query(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      if (text.includes('SELECT last_sequence, request_id')) {
        return { rows: [{ last_sequence: 0, request_id: 'request-a' }] };
      }
      return { rows: [] };
    },
    release() {},
  } as unknown as PoolClient;

  const pool = {
    async connect() {
      return client;
    },
    async query(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      if (text.includes('INSERT INTO web_app_action_runs')) {
        return { rows: [run] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;

  return { pool, queries };
}

test('Postgres web-app action store atomically reserves a request and assigns the next event sequence', async () => {
  const { pool, queries } = createRunStorePool();
  const store = createPostgresRivetWebAppRunStore(pool);

  const created = await store.createRun({
    componentId: 'button-a',
    createdAt: Date.parse('2026-07-15T00:00:00.000Z'),
    hostId: 'runner-a',
    leaseDurationMs: 60_000,
    leaseId: 'lease-a',
    ownerScope: 'owner-a',
    requestId: 'request-a',
    runId: 'run-a',
  });
  const event = await store.appendEvent('run-a', 'lease-a', {
    requestId: 'request-a',
    runId: 'run-a',
    type: 'action.accepted',
  });

  assert.equal(created.created, true);
  assert.equal(created.run.runId, 'run-a');
  assert.deepEqual(event, {
    requestId: 'request-a',
    runId: 'run-a',
    sequence: 1,
    type: 'action.accepted',
  });

  const reservation = queries.find(({ text }) => text.includes('INSERT INTO web_app_action_runs'));
  assert.ok(reservation?.text.includes('ON CONFLICT (owner_scope, request_id) DO NOTHING'));
  const eventLock = queries.find(({ text }) => text.includes('SELECT last_sequence, request_id'));
  assert.ok(eventLock?.text.includes('FOR UPDATE'));
  assert.ok(queries.some(({ text }) => text.includes('INSERT INTO web_app_action_run_events')));
});

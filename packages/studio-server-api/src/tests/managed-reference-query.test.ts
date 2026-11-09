import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { queryReferences } from '../routes/workflows/managed/reference-query.js';

test('reference lookup has a bounded pool queue and destroys late leases', async () => {
  const pending: Array<(value: unknown) => void> = [];
  const pool = { connect: () => new Promise((resolve) => pending.push(resolve)) } as unknown as Pool;
  const signal = new AbortController().signal;
  const requests = [
    queryReferences(pool, 'SELECT 1', [], signal, { timeoutMs: 20 }),
    queryReferences(pool, 'SELECT 1', [], signal, { timeoutMs: 20 }),
  ];
  const outcomes = Promise.allSettled(requests);
  await assert.rejects(queryReferences(pool, 'SELECT 1', [], signal), /busy/);
  await delay(35);
  for (const result of await outcomes) {
    assert.equal(result.status, 'rejected');
  }
  await assert.rejects(queryReferences(pool, 'SELECT 1', [], signal), /busy/);
  const releases: unknown[] = [];
  for (const resolve of pending) resolve({ release: (destroy: boolean) => releases.push(destroy) });
  await delay(0);
  assert.deepEqual(releases, [true, true]);
});

test('cancellation destroys a running client exactly once and never returns it with active queries', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const releases: unknown[] = [];
  let entered: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        calls.push(sql);
        if (sql === 'SELECT blocked') {
          entered();
          return new Promise(() => {});
        }
        return { rows: [] };
      },
      release: (destroy: boolean) => releases.push(destroy),
    }),
  } as unknown as Pool;
  const result = queryReferences(pool, 'SELECT blocked', [], controller.signal);
  await running;
  controller.abort(new Error('cancelled by caller'));
  await assert.rejects(result, /cancelled by caller/);
  assert.deepEqual(releases, [true]);
  assert.equal(calls.includes('ROLLBACK'), false);
});

test('successful lookup resets transaction-local settings; failed writes are never replayed', async () => {
  for (const write of [false, true]) {
    const calls: string[] = [];
    const releases: unknown[] = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string) => {
          calls.push(sql);
          return { rows: sql === 'operation' ? [{ ok: true }] : [] };
        },
        release: (destroy?: boolean) => releases.push(destroy),
      }),
    } as unknown as Pool;
    assert.deepEqual(await queryReferences(pool, 'operation', [], new AbortController().signal, { write }), [
      { ok: true },
    ]);
    assert.equal(calls.at(-1), write ? 'COMMIT' : 'ROLLBACK');
    assert.deepEqual(releases, [undefined]);
  }
  let attempts = 0;
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql === 'UPDATE') {
          attempts++;
          throw new Error('uncertain acknowledgement');
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  await assert.rejects(queryReferences(pool, 'UPDATE', [], new AbortController().signal, { write: true }), /uncertain/);
  assert.equal(attempts, 1);
});

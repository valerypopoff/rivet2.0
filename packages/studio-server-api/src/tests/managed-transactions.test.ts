import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { createManagedWorkflowTransactionRunner } from '../routes/workflows/managed/transactions.js';

for (const fail of [false, true]) {
  test(`managed transaction releases its connection before ${fail ? 'rollback' : 'commit'} hooks`, async () => {
    let leased = false;
    let releases = 0;
    const queries: string[] = [];
    const pool = {
      async connect() {
        assert.equal(leased, false, 'hook must be able to acquire the only connection');
        leased = true;
        return {
          async query(sql: string) {
            queries.push(sql);
            return { rows: [] };
          },
          release() {
            leased = false;
            releases++;
          },
        } as unknown as PoolClient;
      },
    } as unknown as Pool;
    const runner = createManagedWorkflowTransactionRunner({ pool, async initialize() {} });
    let hooksRun = 0;
    const operation = runner.withTransaction(async (_client, hooks) => {
      const hook = async () => {
        const next = await pool.connect();
        next.release();
        hooksRun++;
      };
      if (fail) hooks.onRollback(hook);
      else hooks.onCommit(hook);
      if (fail) throw new Error('operation failed');
      return 42;
    });
    if (fail) await assert.rejects(operation, /operation failed/);
    else assert.equal(await operation, 42);
    assert.equal(hooksRun, 1);
    assert.equal(releases, 2);
    assert.equal(queries[0], 'BEGIN');
    assert.match(queries[1]!, /SET LOCAL lock_timeout/);
    assert.equal(queries.at(-1), fail ? 'ROLLBACK' : 'COMMIT');
  });
}

test('failed rollback evicts the connection without masking the operation failure', async () => {
  let evicted: Error | undefined;
  const runner = createManagedWorkflowTransactionRunner({
    async initialize() {},
    pool: {
      async connect() {
        return {
          async query(sql: string) {
            if (sql === 'ROLLBACK') throw new Error('connection lost');
            return { rows: [] };
          },
          release(error?: Error) {
            evicted = error;
          },
        };
      },
    } as unknown as Pool,
  });
  await assert.rejects(
    runner.withTransaction(async () => {
      throw new Error('original failure');
    }),
    /original failure/,
  );
  assert.equal(evicted?.message, 'connection lost');
});

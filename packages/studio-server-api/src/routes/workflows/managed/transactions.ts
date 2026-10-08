import type { Pool, PoolClient } from 'pg';

import { withManagedDbRetry } from './db.js';
import type { TransactionHooks } from './types.js';

export function createManagedWorkflowTransactionRunner(options: { pool: Pool; initialize(): Promise<void> }) {
  const connectWithRetry = async (): Promise<PoolClient> =>
    withManagedDbRetry('database connect', () => options.pool.connect());

  return {
    connectWithRetry,

    async withTransaction<T>(run: (client: PoolClient, hooks: TransactionHooks) => Promise<T>): Promise<T> {
      await options.initialize();
      const client = await connectWithRetry();
      const onCommitTasks: Array<() => Promise<void>> = [];
      const onRollbackTasks: Array<() => Promise<void>> = [];
      const hooks: TransactionHooks = {
        onCommit(task) {
          onCommitTasks.push(task);
        },
        onRollback(task) {
          onRollbackTasks.push(task);
        },
      };

      let committed = false;
      let result: T;
      let failure: unknown;
      let failed = false;
      let releaseError: Error | undefined;
      try {
        await client.query('BEGIN');
        // Bound lock contention independently of the statement's execution.
        // LOCAL settings cannot leak into a subsequently leased connection.
        await client.query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'");
        result = await run(client, hooks);
        await client.query('COMMIT');
        committed = true;
      } catch (error) {
        failed = true;
        failure = error;
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // A connection whose transaction state is unknown must not re-enter
          // the pool. Preserve the original failure for the caller.
          releaseError = rollbackError instanceof Error ? rollbackError : new Error('Transaction rollback failed.');
        }
      } finally {
        client.release(releaseError);
      }
      // Hooks may acquire their own connection. Releasing first is essential
      // for bounded pools, particularly a single-connection deployment.
      for (const task of committed ? onCommitTasks : onRollbackTasks) {
        try {
          await task();
        } catch (error) {
          console.error('[managed-workflows] Transaction cleanup failed:', error);
        }
      }
      if (failed) throw failure;
      return result!;
    },
  };
}

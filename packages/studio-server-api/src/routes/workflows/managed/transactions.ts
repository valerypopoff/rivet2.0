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
      const settlementTasks: Array<(outcome: 'committed' | 'rolled-back' | 'unknown') => void> = [];
      const hooks: TransactionHooks = {
        onCommit(task) {
          onCommitTasks.push(task);
        },
        onRollback(task) {
          onRollbackTasks.push(task);
        },
        onSettled(task) {
          settlementTasks.push(task);
        },
      };

      let committed = false;
      let result: T;
      let failure: unknown;
      let failed = false;
      let releaseError: Error | undefined;
      let commitAttempted = false;
      let rolledBack = false;
      try {
        await client.query('BEGIN');
        // Bound lock contention independently of the statement's execution.
        // LOCAL settings cannot leak into a subsequently leased connection.
        await client.query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'");
        result = await run(client, hooks);
        commitAttempted = true;
        await client.query('COMMIT');
        committed = true;
      } catch (error) {
        failed = true;
        failure = error;
        try {
          await client.query('ROLLBACK');
          rolledBack = true;
        } catch (rollbackError) {
          // A connection whose transaction state is unknown must not re-enter
          // the pool. Preserve the original failure for the caller.
          releaseError = rollbackError instanceof Error ? rollbackError : new Error('Transaction rollback failed.');
        }
      } finally {
        client.release(releaseError);
      }
      const outcome = committed ? 'committed' : !commitAttempted && rolledBack ? 'rolled-back' : 'unknown';
      for (const task of settlementTasks) {
        try {
          task(outcome);
        } catch {
          try {
            console.error('[managed-workflows] Transaction settlement observer failed.');
          } catch {
            /* Preserve the acknowledged transaction outcome. */
          }
        }
      }
      // Hooks may acquire their own connection. Releasing first is essential
      // for bounded pools, particularly a single-connection deployment.
      // A failed COMMIT or ROLLBACK acknowledgement is not proof of rollback.
      // Rollback hooks can enqueue irreversible cleanup and must not run while
      // the database might still commit the transaction.
      const cleanupTasks = outcome === 'committed' ? onCommitTasks : outcome === 'rolled-back' ? onRollbackTasks : [];
      for (const task of cleanupTasks) {
        try {
          await task();
        } catch (error) {
          try {
            console.error('[managed-workflows] Transaction cleanup failed:', error);
          } catch {
            /* Preserve the primary result or error if logging also fails. */
          }
        }
      }
      if (failed) throw failure;
      return result!;
    },
  };
}

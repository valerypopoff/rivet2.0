import type { Pool, PoolClient } from 'pg';

import { withManagedDbRetry } from './db.js';
import type { TransactionHooks } from './types.js';

export function createManagedWorkflowTransactionRunner(options: {
  pool: Pool;
  initialize(): Promise<void>;
}) {
  const connectWithRetry = async (): Promise<PoolClient> => withManagedDbRetry('database connect', () => options.pool.connect());

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

      try {
        await client.query('BEGIN');
        const result = await run(client, hooks);
        await client.query('COMMIT');

        for (const task of onCommitTasks) {
          try {
            await task();
          } catch (error) {
            console.error('[managed-workflows] Post-commit cleanup failed:', error);
          }
        }

        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});

        for (const task of onRollbackTasks) {
          try {
            await task();
          } catch (cleanupError) {
            console.error('[managed-workflows] Rollback cleanup failed:', cleanupError);
          }
        }

        throw error;
      } finally {
        client.release();
      }
    },
  };
}

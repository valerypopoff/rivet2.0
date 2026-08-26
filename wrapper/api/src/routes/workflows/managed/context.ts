import type { PoolClient } from 'pg';
import { Pool } from 'pg';

import { checkPostgresPoolHealth } from '../../../managed-health.js';
import type { RuntimeHealthCheckContext } from '../../../runtime-health.js';
import type { ManagedWorkflowStorageConfig } from '../storage-config.js';
import {
  S3ManagedWorkflowBlobStore,
  type ManagedWorkflowBlobStore,
} from './blob-store.js';
import {
  createManagedWorkflowQueries,
  getManagedDbConnectionConfig,
  getManagedDbPoolConfig,
  isUniqueViolation,
  queryOne,
  queryRows,
  withManagedDbRetry,
  type ManagedWorkflowQueries,
} from './db.js';
import { createManagedWorkflowEndpointSync } from './endpoint-sync.js';
import { ManagedWorkflowExecutionCache } from './execution-cache.js';
import { ManagedWorkflowExecutionInvalidationController } from './execution-invalidation.js';
import * as mappers from './mappers.js';
import { createManagedWorkflowRevisionFactory } from './revision-factory.js';
import {
  getManagedWorkflowSchemaMode,
  migrateManagedWorkflowSchema,
  verifyManagedWorkflowSchema,
} from './schema-migrations.js';
import { createManagedWorkflowTransactionRunner } from './transactions.js';
import type { TransactionHooks } from './types.js';

export type ManagedWorkflowContext = {
  pool: Pool;
  blobStore: ManagedWorkflowBlobStore;
  executionCache: ManagedWorkflowExecutionCache;
  executionInvalidationController: ManagedWorkflowExecutionInvalidationController;
  db: {
    withManagedDbRetry: typeof withManagedDbRetry;
    queryRows: typeof queryRows;
    queryOne: typeof queryOne;
    isUniqueViolation: typeof isUniqueViolation;
    getManagedDbConnectionConfig: typeof getManagedDbConnectionConfig;
    getManagedDbPoolConfig: typeof getManagedDbPoolConfig;
  };
  queries: ManagedWorkflowQueries;
  revisions: ReturnType<typeof createManagedWorkflowRevisionFactory>;
  endpointSync: ReturnType<typeof createManagedWorkflowEndpointSync>;
  mappers: typeof mappers;
  initialize(): Promise<void>;
  checkHealth(context?: RuntimeHealthCheckContext): Promise<void>;
  dispose(): Promise<void>;
  withTransaction<T>(run: (client: PoolClient, hooks: TransactionHooks) => Promise<T>): Promise<T>;
};

export function createManagedWorkflowContext(
  config: ManagedWorkflowStorageConfig,
  blobStore?: ManagedWorkflowBlobStore,
): ManagedWorkflowContext {
  const pool = new Pool(getManagedDbPoolConfig(config));
  const resolvedBlobStore = blobStore ?? new S3ManagedWorkflowBlobStore(config);
  const executionCache = new ManagedWorkflowExecutionCache();
  const queries = createManagedWorkflowQueries(pool);
  const revisions = createManagedWorkflowRevisionFactory({
    blobStore: resolvedBlobStore,
  });
  const endpointSync = createManagedWorkflowEndpointSync();
  let schemaReadyPromise: Promise<void> | null = null;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  const executionInvalidationController = new ManagedWorkflowExecutionInvalidationController({
    databaseConnectionConfig: getManagedDbConnectionConfig(config),
    withManagedDbRetry,
    invalidateWorkflowEndpointPointers: (workflowId) => {
      executionCache.invalidateWorkflowEndpointPointers(workflowId);
    },
    clearEndpointPointers: () => {
      executionCache.clearEndpointPointers();
    },
  });

  const initialize = async (): Promise<void> => {
    if (disposed) {
      throw new Error('Managed workflow context is already disposed.');
    }

    if (!schemaReadyPromise) {
      schemaReadyPromise = (async () => {
        // Blob storage must exist before the schema can reference uploaded objects.
        await resolvedBlobStore.initialize?.();
        // Every API process reaches this path. The database-wide migration protocol
        // serializes mutation, while Kubernetes API pods can use verify-only mode
        // after the dedicated migration Job has completed.
        const schemaMode = getManagedWorkflowSchemaMode();
        await withManagedDbRetry(`managed schema ${schemaMode}`, () =>
          schemaMode === 'migrate'
            ? migrateManagedWorkflowSchema(pool)
            : verifyManagedWorkflowSchema(pool),
        );
      })().catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
    }

    await schemaReadyPromise;
    await executionInvalidationController.initialize();
  };

  const checkHealth = async (context?: RuntimeHealthCheckContext): Promise<void> => {
    await initialize();
    await Promise.all([
      checkPostgresPoolHealth(pool, context),
      resolvedBlobStore.checkHealth?.(context),
    ]);
  };

  const dispose = async (): Promise<void> => {
    if (disposePromise) {
      return disposePromise;
    }

    disposed = true;
    disposePromise = (async () => {
      // Stop LISTEN/reconnect activity before clearing caches or closing the pool.
      await executionInvalidationController.dispose();
      // Clear revision materializations before pool shutdown so test teardown does
      // not retain stale cached blobs across recreated contexts.
      executionCache.clearRevisionMaterializations();
      try {
        await pool.end();
      } finally {
        resolvedBlobStore.dispose?.();
      }
    })();
    await disposePromise;
  };

  const transactionRunner = createManagedWorkflowTransactionRunner({
    pool,
    initialize,
  });

  return {
    pool,
    blobStore: resolvedBlobStore,
    executionCache,
    executionInvalidationController,
    db: {
      withManagedDbRetry,
      queryRows,
      queryOne,
      isUniqueViolation,
      getManagedDbConnectionConfig,
      getManagedDbPoolConfig,
    },
    queries,
    revisions,
    endpointSync,
    mappers,
    initialize,
    checkHealth,
    dispose,
    withTransaction: transactionRunner.withTransaction,
  };
}

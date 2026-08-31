import type { Pool, PoolClient } from 'pg';

import { checkPostgresPoolHealth } from '../../../managed-health.js';
import { acquireManagedPostgresPool } from '../../../managed-postgres-pool.js';
import type { RuntimeHealthCheckContext } from '../../../runtime-health.js';
import type { ManagedWorkflowStorageConfig } from '../storage-config.js';
import { S3ManagedWorkflowBlobStore, type ManagedWorkflowBlobStore } from './blob-store.js';
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
import {
  createManagedEvaluationRetentionTask,
  getManagedEvaluationRetentionConfig,
} from '../../../evaluation-runs/managed-retention.js';
import {
  createManagedWebAppActionRetentionTask,
  getManagedWebAppActionRetentionConfig,
} from '../../../web-app-action-managed-retention.js';
import { createManagedWorkflowMaintenance } from './maintenance.js';
import { createManagedReconciliationTask, getManagedReconciliationStatus } from './reconciliation.js';
import {
  createManagedStaleUploadRetentionTask,
  getManagedStaleUploadRetentionConfig,
} from './stale-upload-retention.js';
import { MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX } from '../../../runtime-libraries/config.js';
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
  maintenance: ReturnType<typeof createManagedWorkflowMaintenance>;
  getReconciliationStatus(): ReturnType<typeof getManagedReconciliationStatus>;
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
  const poolLease = acquireManagedPostgresPool(getManagedDbPoolConfig(config));
  const { pool } = poolLease;
  const resolvedBlobStore = blobStore ?? new S3ManagedWorkflowBlobStore(config);
  const executionCache = new ManagedWorkflowExecutionCache();
  const queries = createManagedWorkflowQueries(pool);
  const staleUploadRetentionConfig = getManagedStaleUploadRetentionConfig(process.env);
  const maintenance = createManagedWorkflowMaintenance({
    pool,
    blobStore: resolvedBlobStore,
    staleUploadDeletionEnabled: staleUploadRetentionConfig.mode === 'enforce',
  });
  // Reuse the same S3 contract with the fixed runtime prefix only on the
  // maintenance owner. Execution replicas must not allocate audit work or an
  // extra object-store client for the high-volume published endpoint path.
  const runtimeLibrariesBlobStore =
    maintenance.config.enabled && !blobStore
      ? new S3ManagedWorkflowBlobStore(
          {
            ...config,
            objectStoragePrefix: MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX,
          },
          'runtime_libraries',
        )
      : undefined;
  if (maintenance.config.enabled) {
    maintenance.registerTask(
      'managed-evaluation-retention',
      createManagedEvaluationRetentionTask({
        config: getManagedEvaluationRetentionConfig(process.env, maintenance.config.batchSize),
        pool,
      }),
    );
    maintenance.registerTask(
      'managed-web-app-action-retention',
      createManagedWebAppActionRetentionTask({
        config: getManagedWebAppActionRetentionConfig(process.env, maintenance.config.batchSize),
        pool,
      }),
    );
    maintenance.registerTask(
      'managed-reconciliation-audit',
      createManagedReconciliationTask({
        pageSize: maintenance.config.batchSize,
        pool,
        runtimeLibrariesBlobStore,
        workflowBlobStore: resolvedBlobStore,
      }),
    );
    // Sorting of task names makes the reconciliation page run before this
    // policy in each pass. The retention task accepts only fully completed
    // generations, so an interrupted audit page cannot create delete intent.
    maintenance.registerTask(
      'managed-stale-workflow-upload-retention',
      createManagedStaleUploadRetentionTask({
        config: { ...staleUploadRetentionConfig, batchSize: maintenance.config.batchSize },
        enqueueObjectDeletions: (client, reason, keys) => maintenance.enqueueObjectDeletions(client, reason, keys),
        pool,
      }),
    );
  }
  const revisions = createManagedWorkflowRevisionFactory({
    blobStore: resolvedBlobStore,
    queueObjectDeletions: (domain, keys) => maintenance.queueObjectDeletions(domain, keys),
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
          schemaMode === 'migrate' ? migrateManagedWorkflowSchema(pool) : verifyManagedWorkflowSchema(pool),
        );
      })().catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
    }

    await schemaReadyPromise;
    await executionInvalidationController.initialize();
    // Starting the timer is intentionally separate from running a pass. A
    // registered domain task may use withTransaction(), which itself waits for
    // initialize(); starting it synchronously here would create a cycle.
    await maintenance.initialize();
  };

  const checkHealth = async (context?: RuntimeHealthCheckContext): Promise<void> => {
    await initialize();
    await Promise.all([checkPostgresPoolHealth(pool, context), resolvedBlobStore.checkHealth?.(context)]);
  };

  const dispose = async (): Promise<void> => {
    if (disposePromise) {
      return disposePromise;
    }

    disposed = true;
    disposePromise = (async () => {
      await maintenance.dispose();
      // Stop LISTEN/reconnect activity before clearing caches or closing the pool.
      await executionInvalidationController.dispose();
      // Clear revision materializations before pool shutdown so test teardown does
      // not retain stale cached blobs across recreated contexts.
      executionCache.clearRevisionMaterializations();
      try {
        await poolLease.release();
      } finally {
        resolvedBlobStore.dispose?.();
        runtimeLibrariesBlobStore?.dispose?.();
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
    maintenance,
    getReconciliationStatus: () => getManagedReconciliationStatus(pool),
    mappers,
    initialize,
    checkHealth,
    dispose,
    withTransaction: transactionRunner.withTransaction,
  };
}

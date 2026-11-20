import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  createPostgresAppSettingsBackendFromEnv,
  isPostgresAppSettingsBackendEnabled,
} from '../app-settings/managed-settings-store.js';
import { deploymentStorageSettingsRepository } from '../deployment-storage-settings.js';
import { acquireRestoreServingLease } from '../legacy-restore/control.js';
import { S3ManagedWorkflowBlobStore } from '../routes/workflows/managed/blob-store.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import {
  createManagedWorkflowMaintenance,
  getManagedWorkflowMaintenanceConfig,
} from '../routes/workflows/managed/maintenance.js';
import { compactRecordingProjectSnapshots } from '../routes/workflows/managed/recording-project-compaction.js';
import {
  CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
  verifyManagedWorkflowSchema,
} from '../routes/workflows/managed/schema-migrations.js';
import { createManagedWorkflowTransactionRunner } from '../routes/workflows/managed/transactions.js';
import {
  getManagedWorkflowStorageConfig,
  getManagedWorkflowStorageConfigFromSettings,
} from '../routes/workflows/storage-config.js';
import { isRecordingCompactionPaused } from '../routes/workflows/recording-compaction-maintenance.js';
import { assertVmMigrationTargetMayServe } from '../vm-migration-target-gate.js';

async function readStorageConfig() {
  if (!isPostgresAppSettingsBackendEnabled()) return getManagedWorkflowStorageConfig();
  const settings = createPostgresAppSettingsBackendFromEnv();
  try {
    const { descriptor } = deploymentStorageSettingsRepository;
    const row = await settings.read(descriptor.key);
    if (!row || row.schemaVersion !== descriptor.currentVersion)
      throw new Error('The installed deployment storage settings are unavailable.');
    return getManagedWorkflowStorageConfigFromSettings(descriptor.parseStored(row.value));
  } finally {
    await settings.dispose();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string', default: '100' },
      after: { type: 'string' },
      'workflow-id': { type: 'string' },
      'max-seconds': { type: 'string', default: '30' },
    },
  });
  const limit = Number(values.limit);
  const maxSeconds = Number(values['max-seconds']);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(maxSeconds) ||
    maxSeconds < 1 ||
    maxSeconds > 120
  ) {
    console.error('Use --limit 1..1000 and --max-seconds 1..120.');
    process.exitCode = 1;
    return;
  }
  if (isRecordingCompactionPaused()) {
    console.error('Recording compaction requires serving mode.');
    process.exitCode = 1;
    return;
  }
  const config = await readStorageConfig();
  const blobStore = new S3ManagedWorkflowBlobStore(config);
  // One connection for the restore fence and one for the serial batch.
  const pool = new Pool({ ...getManagedDbPoolConfig(config), max: 2, statement_timeout: 5000 });
  const maintenance = createManagedWorkflowMaintenance({
    config: getManagedWorkflowMaintenanceConfig(),
    pool,
    blobStore,
  });
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireRestoreServingLease(pool);
    await assertVmMigrationTargetMayServe(pool);
    await verifyManagedWorkflowSchema(pool, {
      compatibilityWindow: {
        minimumVersion: CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
        maximumVersion: CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
      },
    });
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(maxSeconds * 1000)]);
    await blobStore.checkHealth({ signal, timeoutMs: maxSeconds * 1000 });
    const { withTransaction } = createManagedWorkflowTransactionRunner({ pool, initialize: async () => {} });
    console.log(
      JSON.stringify(
        await compactRecordingProjectSnapshots(
          { pool, blobStore, maintenance, withTransaction },
          { limit, after: values.after, workflowId: values['workflow-id'], signal },
        ),
      ),
    );
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    try {
      await release?.();
    } finally {
      blobStore.dispose();
      await pool.end();
    }
  }
}

main().catch(() => {
  console.error('Recording compaction stopped. Check the storage connection and installation state before resuming.');
  process.exitCode = 1;
});

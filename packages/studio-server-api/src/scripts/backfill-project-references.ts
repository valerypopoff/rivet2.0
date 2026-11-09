import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { readDeploymentStorageBootstrapSettings } from '../deployment-storage-settings.js';
import {
  getManagedWorkflowStorageConfig,
  getManagedWorkflowStorageConfigFromSettings,
} from '../routes/workflows/storage-config.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import { verifyManagedWorkflowSchema } from '../routes/workflows/managed/schema-migrations.js';
import { S3ManagedWorkflowBlobStore } from '../routes/workflows/managed/blob-store.js';
import { backfillProjectReferences } from '../routes/workflows/managed/reference-backfill.js';
import { assertVmMigrationTargetMayServe } from '../vm-migration-target-gate.js';

async function main() {
  const { values } = parseArgs({
    options: {
      'max-revisions': { type: 'string', default: '1000' },
      'max-seconds': { type: 'string', default: '600' },
    },
  });
  const maxRevisions = Number(values['max-revisions']);
  const maxSeconds = Number(values['max-seconds']);
  if (
    !Number.isSafeInteger(maxRevisions) ||
    maxRevisions < 1 ||
    maxRevisions > 10_000 ||
    !Number.isSafeInteger(maxSeconds) ||
    maxSeconds < 1 ||
    maxSeconds > 3600
  )
    throw new Error('Use --max-revisions 1..10000 and --max-seconds 1..3600');
  const config =
    process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated'
      ? getManagedWorkflowStorageConfigFromSettings(readDeploymentStorageBootstrapSettings())
      : getManagedWorkflowStorageConfig();
  const pool = new Pool(getManagedDbPoolConfig(config));
  const blobs = new S3ManagedWorkflowBlobStore(config);
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error('Backfill interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    // This command never migrates the database or joins serving background tasks.
    await assertVmMigrationTargetMayServe(pool);
    await verifyManagedWorkflowSchema(pool);
    const result = await backfillProjectReferences({
      pool,
      blobStore: blobs,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(maxSeconds * 1000)]),
      maxRevisions,
    });
    console.log(JSON.stringify(result));
    // Attempt failures remain in the report. Another writer may already have
    // repaired them or made that revision inactive; final active coverage owns readiness.
    if (result.coverage.complete !== result.coverage.total) process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    blobs.dispose();
    await pool.end();
  }
}

main().catch(() => {
  // Storage/parser errors may contain private payloads, credentials or paths.
  console.error(
    'Project-reference backfill stopped. Check database/storage access and rerun explicitly; no automatic retry.',
  );
  process.exitCode = 1;
});

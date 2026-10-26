import 'dotenv/config';
import { Pool } from 'pg';
import { auditManagedDatasetOwnership } from '../routes/workflows/managed/dataset-ownership.js';
import { S3ManagedWorkflowBlobStore } from '../routes/workflows/managed/blob-store.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import { getManagedWorkflowStorageConfig, getWorkflowStorageBackendMode } from '../routes/workflows/storage-config.js';

async function main() {
  const [mode, after = '', limit = '50'] = process.argv.slice(2);
  if (mode !== '--read-only' || process.argv.length > 5 || getWorkflowStorageBackendMode() !== 'managed')
    throw new Error(
      'Usage: audit-dataset-ownership --read-only [afterRevisionId] [pageSize]. Managed storage required.',
    );
  const config = getManagedWorkflowStorageConfig();
  const pool = new Pool({ ...getManagedDbPoolConfig(config), options: '-c default_transaction_read_only=on' });
  const blobs = new S3ManagedWorkflowBlobStore(config);
  try {
    const result = await auditManagedDatasetOwnership(
      {
        pool,
        readRevisionContents: async (row) => ({
          contents: await blobs.getText(row.project_blob_key),
          datasetsContents: row.dataset_blob_key ? await blobs.getText(row.dataset_blob_key) : null,
        }),
      },
      { after, limit: Number(limit) },
    );
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    await pool.end();
    blobs.dispose();
  }
}
void main().catch(() => {
  console.error(
    '[dataset-ownership-audit] Audit failed. Inspect local configuration or use a smaller page; no repair was attempted.',
  );
  process.exitCode = 1;
});

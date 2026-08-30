import 'dotenv/config';

import { Pool } from 'pg';

import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import { getManagedReconciliationStatus } from '../routes/workflows/managed/reconciliation.js';
import { getManagedWorkflowStorageConfig, getWorkflowStorageBackendMode } from '../routes/workflows/storage-config.js';

async function main(): Promise<void> {
  if (getWorkflowStorageBackendMode() !== 'managed') {
    throw new Error('This command only works when Settings -> Storage uses Object storage.');
  }

  const pool = new Pool(getManagedDbPoolConfig(getManagedWorkflowStorageConfig()));
  try {
    const status = await getManagedReconciliationStatus(pool);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(
    `[managed-reconciliation] Could not read reconciliation status: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});

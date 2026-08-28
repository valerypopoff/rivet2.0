import { Pool } from 'pg';

import { getManagedDbPoolConfig, withManagedDbRetry } from '../routes/workflows/managed/db.js';
import {
  migrateManagedWorkflowSchema,
  verifyManagedWorkflowSchema,
  type ManagedWorkflowSchemaMode,
} from '../routes/workflows/managed/schema-migrations.js';
import {
  getManagedWorkflowStorageConfig,
} from '../routes/workflows/storage-config.js';

function readCommand(): ManagedWorkflowSchemaMode {
  const command = process.argv[2]?.trim().toLowerCase();
  if (command === 'migrate' || command === 'verify') {
    return command;
  }

  throw new Error('Usage: migrate-managed-workflow-schema.ts <migrate|verify>');
}

async function main(): Promise<void> {
  const command = readCommand();
  const storageConfig = getManagedWorkflowStorageConfig();
  const pool = new Pool(getManagedDbPoolConfig(storageConfig));
  try {
    const result = await withManagedDbRetry(`managed schema ${command}`, () =>
      command === 'migrate'
        ? migrateManagedWorkflowSchema(pool)
        : verifyManagedWorkflowSchema(pool),
    );
    console.log(
      `[managed-workflow-schema] ${command} succeeded at version ${result.currentVersion}.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[managed-workflow-schema] Command failed:', error);
  process.exitCode = 1;
});

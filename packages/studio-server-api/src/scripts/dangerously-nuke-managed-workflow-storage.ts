import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Pool } from 'pg';

import {
  getManagedWorkflowStorageConfig,
  getWorkflowStorageBackendMode,
} from '../routes/workflows/storage-config.js';
import { createManagedWorkflowS3ClientConfig } from '../routes/workflows/managed/blob-store.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';

const WORKFLOW_TABLES = [
  'workflow_recordings',
  'workflow_endpoints',
  'workflow_web_apps',
  'workflow_revisions',
  'workflows',
  'workflow_folders',
] as const;

function loadNearestEnvFile(startDir: string): void {
  let currentDir = path.resolve(startDir);

  while (true) {
    for (const fileName of ['.env', '.env.dev']) {
      const candidate = path.join(currentDir, fileName);
      if (existsSync(candidate)) {
        loadDotEnv({ path: candidate });
        return;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return;
    }

    currentDir = parentDir;
  }
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '');
  if (!trimmed) {
    return '';
  }

  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function createS3Client() {
  const config = getManagedWorkflowStorageConfig();
  return {
    config,
    client: new S3Client(createManagedWorkflowS3ClientConfig(config)),
    prefix: normalizePrefix(config.objectStoragePrefix),
  };
}

function createPool() {
  const config = getManagedWorkflowStorageConfig();
  return new Pool(getManagedDbPoolConfig(config));
}

async function deleteManagedObjects(): Promise<number> {
  const { config, client, prefix } = createS3Client();

  if (!prefix) {
    throw new Error('Refusing to wipe object storage because the managed storage prefix is empty.');
  }

  let deletedCount = 0;
  let continuationToken: string | undefined;

  try {
    while (true) {
      const listed = await client.send(new ListObjectsV2Command({
        Bucket: config.objectStorageBucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      const keys = (listed.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((key): key is string => Boolean(key));

      if (keys.length > 0) {
        await client.send(new DeleteObjectsCommand({
          Bucket: config.objectStorageBucket,
          Delete: {
            Objects: keys.map((key) => ({ Key: key })),
            Quiet: true,
          },
        }));
        deletedCount += keys.length;
      }

      if (!listed.IsTruncated || !listed.NextContinuationToken) {
        break;
      }

      continuationToken = listed.NextContinuationToken;
    }
  } finally {
    client.destroy();
  }

  return deletedCount;
}

async function truncateManagedTables(): Promise<number> {
  const pool = createPool();

  try {
    const result = await pool.query<{ tablename: string }>(
      `
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = ANY($1::text[])
      `,
      [WORKFLOW_TABLES],
    );

    const existingTables = WORKFLOW_TABLES.filter((tableName) =>
      result.rows.some((row) => row.tablename === tableName),
    );

    if (existingTables.length === 0) {
      return 0;
    }

    await pool.query(`TRUNCATE TABLE ${existingTables.map((tableName) => `"${tableName}"`).join(', ')} CASCADE`);
    return existingTables.length;
  } finally {
    await pool.end();
  }
}

async function main() {
  loadNearestEnvFile(process.cwd());

  if (!process.argv.includes('--yes')) {
    console.error('Refusing to nuke managed workflow storage without --yes.');
    console.error('Run: yarn studio-server:workflow-storage:dangerously-nuke-managed-state --yes');
    process.exit(1);
  }

  if (getWorkflowStorageBackendMode() !== 'managed') {
    throw new Error('This command only works when Settings -> Storage uses Object storage.');
  }

  const deletedObjects = await deleteManagedObjects();
  const truncatedTables = await truncateManagedTables();

  console.log(`[workflow-storage:nuke] Deleted ${deletedObjects} object(s) from managed storage.`);
  console.log(`[workflow-storage:nuke] Truncated ${truncatedTables} workflow table(s).`);
  console.log('[workflow-storage:nuke] Managed workflow storage is now empty.');
}

main().catch((error) => {
  console.error(`[workflow-storage:nuke] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

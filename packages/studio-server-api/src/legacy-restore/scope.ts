import type { Pool, PoolClient } from 'pg';
import { HeadObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { ManagedWorkflowStorageConfig } from '../routes/workflows/storage-config.js';
import {
  createManagedWorkflowS3ClientConfig,
  isManagedWorkflowArtifactObjectKey,
} from '../routes/workflows/managed/blob-store.js';

/** Schema owners, not a prefix scan or CASCADE. Control and migration history are deliberately absent. */
export const LEGACY_RESTORE_TABLES = [
  'workflow_folders',
  'workflows',
  'workflow_revisions',
  'workflow_published_versions',
  'workflow_endpoints',
  'workflow_web_apps',
  'workflow_recordings',
  'evaluation_library',
  'evaluation_library_imports',
  'evaluation_runs',
  'evaluation_recordings',
  'evaluation_dataset_snapshots',
  'evaluation_hosted_runs',
  'evaluation_hosted_trial_jobs',
  'evaluation_hosted_trial_attempts',
  'llm_profile_health',
  'managed_maintenance_leases',
  'managed_object_deletion_outbox',
  'managed_reconciliation_state',
  'managed_reconciliation_findings',
  'runtime_library_jobs',
  'runtime_library_job_logs',
  'runtime_library_releases',
  'runtime_library_activation',
  'runtime_library_replica_status',
  'web_app_action_runs',
  'web_app_action_run_events',
  'web_app_action_cancel_commands',
  'rivet_schedules',
  'rivet_schedule_runs',
  'rivet_schedule_installation',
  'rivet_schedule_requests',
  'app_settings',
  'rivet_vm_migration_gate',
] as const;

export type RestoreObject = { key: string; versionId?: string; etag: string };

export async function preflightRestorePermissions(pool: Pool, config: ManagedWorkflowStorageConfig) {
  const tables = await existingRestoreTables(pool);
  await assertRestoreTableBoundary(pool, tables);
  // has_table_privilege with a comma list means ANY, not ALL. Check each privilege separately.
  for (const permission of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    const result = await pool.query(
      `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])
      AND NOT has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),$2)`,
      [tables, permission],
    );
    if (result.rowCount) throw new Error('Restore database permissions are incomplete.');
  }
  // Fresh probes are operation-owned. Both artifact families need conditional/version deletion support.
  const s3 = new S3Client(createManagedWorkflowS3ClientConfig(config));
  try {
    for (const prefix of [config.objectStoragePrefix, 'runtime-libraries/']) {
      const key = prefix + 'restore-preflight/' + randomUUID();
      const written = await s3.send(
        new PutObjectCommand({
          Bucket: config.objectStorageBucket,
          Key: key,
          Body: 'rivet restore permission probe',
          IfNoneMatch: '*',
        }),
      );
      if (!written.ETag) throw new Error('Restore storage probe has no identity.');
      await s3.send(
        new DeleteObjectCommand({
          Bucket: config.objectStorageBucket,
          Key: key,
          ...(written.VersionId ? { VersionId: written.VersionId } : { IfMatch: written.ETag }),
        }),
      );
    }
  } finally {
    s3.destroy();
  }
}
export function validateRestoreObjectKey(prefix: string, relative: string, family: 'workflow' | 'runtime'): string {
  if (
    !prefix ||
    !prefix.endsWith('/') ||
    prefix.startsWith('/') ||
    prefix.includes('\\') ||
    prefix
      .split('/')
      .slice(0, -1)
      .some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('Unsafe storage namespace.');
  if (
    family === 'workflow'
      ? !isManagedWorkflowArtifactObjectKey(relative)
      : !/^releases\/[a-zA-Z0-9_-]+\/release\.tar$/.test(relative)
  )
    throw new Error('Unrecognized owned artifact reference.');
  if (relative.includes('\\') || relative.split('/').some((p) => !p || p === '.' || p === '..'))
    throw new Error('Unsafe artifact reference.');
  return prefix + relative;
}

export async function existingRestoreTables(client: Pool | PoolClient): Promise<string[]> {
  const rows = (
    await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])",
      [LEGACY_RESTORE_TABLES],
    )
  ).rows;
  const present = new Set(rows.map((r) => r.tablename));
  return LEGACY_RESTORE_TABLES.filter((table) => present.has(table)).sort();
}

/** Cross-boundary dependencies and custom triggers can mutate unrelated tables: refuse them before any deletion. */
export async function assertRestoreTableBoundary(client: Pool | PoolClient, tables: readonly string[]): Promise<void> {
  const dependencies = await client.query(
    `SELECT 1 FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class source ON source.oid=c.conrelid JOIN pg_catalog.pg_namespace sn ON sn.oid=source.relnamespace
    JOIN pg_catalog.pg_class target ON target.oid=c.confrelid JOIN pg_catalog.pg_namespace tn ON tn.oid=target.relnamespace
    WHERE c.contype='f' AND (
      (sn.nspname='public' AND source.relname=ANY($1::text[]) AND NOT(tn.nspname='public' AND target.relname=ANY($1::text[]))) OR
      (tn.nspname='public' AND target.relname=ANY($1::text[]) AND NOT(sn.nspname='public' AND source.relname=ANY($1::text[])))) LIMIT 1`,
    [tables],
  );
  const triggers = await client.query(
    `SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal
    AND n.nspname='public' AND c.relname=ANY($1::text[]) LIMIT 1`,
    [tables],
  );
  const policies = await client.query(
    `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND (c.relrowsecurity OR c.relkind<>'r') LIMIT 1`,
    [tables],
  );
  const inheritance = await client.query(
    `SELECT 1 FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class parent ON parent.oid=i.inhparent
    JOIN pg_catalog.pg_namespace pn ON pn.oid=parent.relnamespace
    JOIN pg_catalog.pg_class child ON child.oid=i.inhrelid JOIN pg_catalog.pg_namespace cn ON cn.oid=child.relnamespace
    WHERE (pn.nspname='public' AND parent.relname=ANY($1::text[])) OR
      (cn.nspname='public' AND child.relname=ANY($1::text[])) LIMIT 1`,
    [tables],
  );
  if (dependencies.rowCount || triggers.rowCount || policies.rowCount || inheritance.rowCount)
    throw new Error('Application tables have unrecognized external dependencies or triggers.');
}

export async function captureRestoreObjects(
  pool: Pool,
  config: ManagedWorkflowStorageConfig,
): Promise<RestoreObject[]> {
  const tables = await existingRestoreTables(pool);
  await assertRestoreTableBoundary(pool, tables);
  if (
    config.objectStoragePrefix === 'runtime-libraries/' ||
    config.objectStoragePrefix.startsWith('runtime-libraries/') ||
    'runtime-libraries/'.startsWith(config.objectStoragePrefix)
  )
    throw new Error('Storage namespaces overlap.');
  const keys = new Set<string>();
  const sources: Array<[string, string[]]> = [
    ['workflow_revisions', ['project_blob_key', 'dataset_blob_key']],
    ['workflow_recordings', ['recording_blob_key', 'replay_project_blob_key', 'replay_dataset_blob_key']],
  ];
  for (const [table, columns] of sources) {
    if (!tables.includes(table)) continue;
    // Column names come exclusively from this owner's closed declaration.
    const identity = table === 'workflow_revisions' ? 'workflow_id, revision_id' : 'workflow_id, recording_id';
    const rows = await pool.query(`SELECT ${identity}, ${columns.join(',')} FROM public.${table}`);
    for (const row of rows.rows)
      for (const column of columns) {
        const reference = row[column];
        if (reference != null) {
          if (typeof reference !== 'string') throw new Error('Invalid artifact reference.');
          const expectedRoot = `${row.workflow_id}/${table === 'workflow_revisions' ? 'revisions' : 'recordings'}/${row.revision_id ?? row.recording_id}/`;
          if (!reference.startsWith(expectedRoot))
            throw new Error('Artifact reference belongs to a different resource.');
          keys.add(validateRestoreObjectKey(config.objectStoragePrefix, reference, 'workflow'));
        }
      }
  }
  if (!keys.size) return [];
  const s3 = new S3Client(createManagedWorkflowS3ClientConfig(config));
  try {
    const objects: RestoreObject[] = [];
    for (const key of [...keys].sort()) {
      const head = await s3.send(new HeadObjectCommand({ Bucket: config.objectStorageBucket, Key: key }));
      if (!head.ETag) throw new Error('Referenced artifact has no stable identity.');
      if (
        head.ObjectLockLegalHoldStatus === 'ON' ||
        (head.ObjectLockRetainUntilDate && head.ObjectLockRetainUntilDate.getTime() > Date.now())
      )
        throw new Error('Referenced artifact is protected by object retention.');
      // Capture only the authoritative current version. Never enumerate or delete unrelated historical versions.
      objects.push({ key, etag: head.ETag, ...(head.VersionId ? { versionId: head.VersionId } : {}) });
    }
    return objects;
  } finally {
    s3.destroy();
  }
}

export async function clearRestoreObjects(
  config: ManagedWorkflowStorageConfig,
  objects: readonly RestoreObject[],
): Promise<void> {
  for (const object of objects) {
    const family = object.key.startsWith('runtime-libraries/') ? 'runtime' : 'workflow';
    const prefix = family === 'runtime' ? 'runtime-libraries/' : config.objectStoragePrefix;
    if (
      !object.key.startsWith(prefix) ||
      validateRestoreObjectKey(prefix, object.key.slice(prefix.length), family) !== object.key
    )
      throw new Error('Deletion inventory escapes this installation.');
  }
  // Runtime archives have a fixed bucket-global prefix and may use content-derived migration IDs.
  // Catalog references cannot prove exclusive installation ownership; reset their rows, never these objects.
  const deleting = objects.filter((object) => !object.key.startsWith('runtime-libraries/'));
  if (!deleting.length) return;
  const s3 = new S3Client(createManagedWorkflowS3ClientConfig(config));
  try {
    for (const object of deleting) {
      const head = await s3
        .send(
          new HeadObjectCommand({
            Bucket: config.objectStorageBucket,
            Key: object.key,
            ...(object.versionId ? { VersionId: object.versionId } : {}),
          }),
        )
        .catch((error) => {
          if (error?.$metadata?.httpStatusCode === 404) return null;
          throw error;
        });
      if (head && head.ETag !== object.etag) throw new Error('Artifact changed after restore inventory.');
      if (head)
        await s3.send(
          new DeleteObjectCommand({
            Bucket: config.objectStorageBucket,
            Key: object.key,
            ...(object.versionId ? { VersionId: object.versionId } : { IfMatch: object.etag }),
          }),
        );
    }
  } finally {
    s3.destroy();
  }
}

export async function clearRestoreTables(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const tables = await existingRestoreTables(client);
    if (tables.length)
      await client.query(`LOCK TABLE ${tables.map((t) => `public."${t}"`).join(', ')} IN ACCESS EXCLUSIVE MODE`);
    await assertRestoreTableBoundary(client, tables);
    if (tables.length) await client.query(`TRUNCATE TABLE ${tables.map((t) => `public."${t}"`).join(', ')} RESTRICT`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      discard = true;
    });
    throw error;
  } finally {
    client.release(discard);
  }
}

import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import type { ManagedWorkflowStorageConfig } from './routes/workflows/storage-config.js';

const GATE_TABLE = 'rivet_vm_migration_gate';
const IMPORTER_LOCK = [8_071, 24_003] as const;
const CONTENT_TABLES = [
  'workflows',
  'workflow_folders',
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
  'runtime_library_jobs',
  'runtime_library_releases',
  'runtime_library_activation',
  'web_app_action_runs',
  'web_app_action_run_events',
  'web_app_action_cancel_commands',
  'app_settings',
] as const;

export function migrationTargetIdentity(config: ManagedWorkflowStorageConfig): string {
  const database = new URL(config.databaseUrl);
  database.username = '';
  database.password = '';
  database.search = '';
  return createHash('sha256')
    .update(
      JSON.stringify({
        database: database.toString(),
        bucket: config.objectStorageBucket,
        prefix: config.objectStoragePrefix,
        endpoint: config.objectStorageEndpoint,
        region: config.objectStorageRegion,
      }),
    )
    .digest('hex');
}

export function migrationSourceIdentity(roots: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(roots)).digest('hex');
}

export async function hasVmMigrationTargetGate(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ name: string | null }>(
    "SELECT to_regclass('public.rivet_vm_migration_gate')::text AS name",
  );
  return Boolean(result.rows[0]?.name);
}

/** Session-level lock covers the complete copy/verify process, not one metadata transaction. */
export async function acquireVmMigrationImporterLock(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS acquired', [
      ...IMPORTER_LOCK,
    ]);
    if (!result.rows[0]?.acquired) throw new Error('Another migration importer is using this destination.');
    return async () => {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [...IMPORTER_LOCK]);
      } finally {
        client.release();
      }
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

/** A missing gate is normal for established managed installations. An incomplete gate is never normal. */
export async function assertVmMigrationTargetMayServe(pool: Pool): Promise<void> {
  if (!(await hasVmMigrationTargetGate(pool))) return;
  const result = await pool.query<{ phase: string }>(`SELECT phase FROM ${GATE_TABLE} WHERE singleton = TRUE`);
  if (result.rows[0]?.phase !== 'verified') {
    throw new Error(
      'Managed migration target is incomplete; API and migration Job startup are disabled until exact verification succeeds.',
    );
  }
}

/** Called before the importer creates any workflow schema or target objects. */
export async function beginVmMigrationTarget(
  pool: Pool,
  sourceIdentity: string,
  targetIdentity: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${GATE_TABLE} (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        source_identity TEXT NOT NULL CHECK (char_length(source_identity) = 64),
        target_identity TEXT NOT NULL CHECK (char_length(target_identity) = 64),
        source_manifest_hash TEXT NULL CHECK (source_manifest_hash IS NULL OR char_length(source_manifest_hash) = 64),
        phase TEXT NOT NULL CHECK (phase IN ('copying', 'verified')),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        verified_at TIMESTAMPTZ NULL
      )
    `);
    await client.query(`ALTER TABLE ${GATE_TABLE} ADD COLUMN IF NOT EXISTS source_manifest_hash TEXT`);
    await client.query(`LOCK TABLE ${GATE_TABLE} IN EXCLUSIVE MODE`);
    const existing = await client.query<{ source_identity: string; target_identity: string; phase: string }>(
      `SELECT source_identity, target_identity, phase FROM ${GATE_TABLE} WHERE singleton = TRUE`,
    );
    if (existing.rows[0]) {
      if (existing.rows[0].source_identity !== sourceIdentity || existing.rows[0].target_identity !== targetIdentity) {
        throw new Error('The destination belongs to a different VM migration.');
      }
      if (existing.rows[0].phase !== 'copying') {
        throw new Error('The destination migration was already verified; do not copy into it again.');
      }
    } else {
      for (const table of CONTENT_TABLES) {
        const present = await client.query<{ name: string | null }>('SELECT to_regclass($1)::text AS name', [
          `public.${table}`,
        ]);
        if (!present.rows[0]?.name) continue;
        const count = await client.query(`SELECT 1 FROM ${table} LIMIT 1`);
        if (count.rowCount) throw new Error(`Destination contains existing ${table} data; use an empty database.`);
      }
      await client.query(
        `INSERT INTO ${GATE_TABLE} (singleton, source_identity, target_identity, phase) VALUES (TRUE, $1, $2, 'copying')`,
        [sourceIdentity, targetIdentity],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** A retry must use the identical frozen source, not silently merge a later VM edit. */
export async function bindVmMigrationSourceManifest(
  pool: Pool,
  sourceIdentity: string,
  targetIdentity: string,
  manifestHash: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE ${GATE_TABLE} SET source_manifest_hash = $3
     WHERE singleton = TRUE AND source_identity = $1 AND target_identity = $2
       AND phase = 'copying' AND (source_manifest_hash IS NULL OR source_manifest_hash = $3)`,
    [sourceIdentity, targetIdentity, manifestHash],
  );
  if (result.rowCount !== 1) {
    throw new Error(
      'Frozen VM source changed since this destination migration began. Do not reuse the partial target.',
    );
  }
}

export async function assertVmMigrationSourceManifest(
  pool: Pool,
  sourceIdentity: string,
  targetIdentity: string,
  manifestHash: string,
): Promise<void> {
  const result = await pool.query<{ source_manifest_hash: string | null }>(
    `SELECT source_manifest_hash FROM ${GATE_TABLE}
     WHERE singleton = TRUE AND source_identity = $1 AND target_identity = $2
       AND phase IN ('copying', 'verified')`,
    [sourceIdentity, targetIdentity],
  );
  if (result.rows[0]?.source_manifest_hash !== manifestHash) {
    throw new Error('Frozen VM source changed during copy or verification; do not cut over to this target.');
  }
}

/** Exact domain verification is the only path that opens the target to serving. */
export async function verifyVmMigrationTargetGate(
  pool: Pool,
  sourceIdentity: string,
  targetIdentity: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE ${GATE_TABLE} SET phase = 'verified', verified_at = NOW()
     WHERE singleton = TRUE AND source_identity = $1 AND target_identity = $2 AND phase IN ('copying', 'verified')`,
    [sourceIdentity, targetIdentity],
  );
  if (result.rowCount !== 1) throw new Error('Migration target gate does not belong to this source and destination.');
}

/** Close a verified destination before the source VM accepts new writes again. */
export async function invalidateVmMigrationTargetGate(
  pool: Pool,
  sourceIdentity: string,
  targetIdentity: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE ${GATE_TABLE} SET phase = 'copying', verified_at = NULL
     WHERE singleton = TRUE AND source_identity = $1 AND target_identity = $2
       AND phase IN ('copying', 'verified')`,
    [sourceIdentity, targetIdentity],
  );
  if (result.rowCount !== 1) throw new Error('Migration target gate does not belong to this source and destination.');
}

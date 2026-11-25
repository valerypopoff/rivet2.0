import { createHash } from 'node:crypto';
import { Client, Pool, type PoolClient, type PoolConfig } from 'pg';
import { acquireRecordingStorageLock } from '@valerypopoff/rivet-studio-server-bootstrap/recording-storage.mjs';
import {
  getPostgresAppSettingsPoolConfigFromEnv,
  isPostgresAppSettingsBackendEnabled,
} from '../src/app-settings/managed-settings-store.js';
import {
  decryptManagedSettingsValue,
  deriveManagedSettingsEncryptionKey,
} from '../src/app-settings/managed-settings-crypto.js';
import { deploymentStorageSettingsRepository } from '../src/deployment-storage-settings.js';
import { acquireRestoreServingLease } from '../src/legacy-restore/control.js';
import { getManagedDbPoolConfig } from '../src/routes/workflows/managed/db.js';
import {
  getManagedWorkflowStorageConfig,
  getManagedWorkflowStorageConfigFromSettings,
  type ManagedWorkflowStorageConfig,
} from '../src/routes/workflows/storage-config.js';
import { isReleaseMaintenanceActive } from '../src/release-maintenance.js';
import { isVmMigrationMaintenanceActive } from '../src/vm-migration-maintenance.js';
import type { TransactionHooks } from '../src/routes/workflows/managed/types.js';

/** pg URL options override explicit configuration. Keep operator bounds last,
 * preserving other startup options such as an installation's search path. */
function operatorConnectionConfig(config: PoolConfig, readOnly = false): PoolConfig {
  const url = new URL(config.connectionString!);
  const options =
    url.searchParams.getAll('options').at(-1) || config.options || (!readOnly && process.env.PGOPTIONS) || '';
  url.searchParams.delete('options');
  url.searchParams.delete('statement_timeout');
  return {
    ...config,
    connectionString: url.toString(),
    options: `${options} -c statement_timeout=15000${readOnly ? ' -c default_transaction_read_only=on' : ''}`,
    statement_timeout: 15000,
  };
}

/** Publication uses the lease's own session: losing it cannot leave a second
 * connection free to commit after a transition acquires the coordination lock. */
export function recordingOperatorTransaction(client: PoolClient) {
  return async <T>(run: (client: PoolClient, hooks: TransactionHooks) => Promise<T>): Promise<T> => {
    const committed: Array<() => Promise<void>> = [],
      rolledBack: Array<() => Promise<void>> = [];
    const settled: Array<(outcome: 'committed' | 'rolled-back' | 'unknown') => void> = [];
    let commitAttempted = false;
    const state: { outcome: 'committed' | 'rolled-back' | 'unknown' } = { outcome: 'unknown' };
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
      const value = await run(client, {
        onCommit: (task) => {
          committed.push(task);
        },
        onRollback: (task) => {
          rolledBack.push(task);
        },
        onSettled: (task) => {
          settled.push(task);
        },
      });
      commitAttempted = true;
      await client.query('COMMIT');
      state.outcome = 'committed';
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
        if (!commitAttempted) state.outcome = 'rolled-back';
      } catch {
        /* Keep unknown. */
      }
      throw error;
    } finally {
      for (const notify of settled) notify(state.outcome);
      for (const task of state.outcome === 'committed' ? committed : state.outcome === 'rolled-back' ? rolledBack : [])
        await task();
    }
  };
}

/** Read without encryption rotation, timestamps, initialization or other writes. */
export async function readRecordingStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManagedWorkflowStorageConfig> {
  if (!isPostgresAppSettingsBackendEnabled(env)) return getManagedWorkflowStorageConfig();
  const client = new Client(operatorConnectionConfig(getPostgresAppSettingsPoolConfigFromEnv(env), true));
  try {
    await client.connect();
    const { descriptor } = deploymentStorageSettingsRepository;
    const {
      rows: [row],
    } = await client.query(
      'SELECT setting_key,schema_version,ciphertext,iv,auth_tag,key_id FROM app_settings WHERE setting_key=$1',
      [descriptor.key],
    );
    if (!row || row.schema_version !== descriptor.currentVersion)
      throw new Error('Installed storage settings unavailable.');
    const secrets = [
      env.RIVET_APP_SETTINGS_ENCRYPTION_KEY?.trim() || env.RIVET_KEY?.trim(),
      env.RIVET_APP_SETTINGS_ENCRYPTION_KEY_PREVIOUS?.trim(),
    ].filter((v): v is string => Boolean(v));
    const keys = new Map(
      secrets.map((secret) => {
        const key = deriveManagedSettingsEncryptionKey(secret);
        return [key.id, key];
      }),
    );
    const stored = decryptManagedSettingsValue(
      { key: row.setting_key, schemaVersion: row.schema_version },
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyId: row.key_id },
      keys,
    );
    return getManagedWorkflowStorageConfigFromSettings(descriptor.parseStored(stored));
  } finally {
    await client.end();
  }
}

export function recordingStorageIdentity(config: ManagedWorkflowStorageConfig): string {
  const db = new URL(config.databaseUrl);
  return createHash('sha256')
    .update(
      JSON.stringify([
        db.hostname,
        db.port,
        db.pathname,
        config.objectStorageEndpoint,
        config.objectStorageRegion,
        config.objectStorageBucket,
        config.objectStoragePrefix,
      ]),
    )
    .digest('hex');
}

export async function recordingStorageRequiredEncodings(pool: Pick<Pool, 'query'>): Promise<string[]> {
  const result = await pool.query<{ encoding: string }>(`SELECT DISTINCT
    CASE WHEN key NOT LIKE '%.artifact-v1.%' THEN 'identity'
      ELSE regexp_replace(key,'^.*[.]artifact-v1[.][a-f0-9]{64}[.][0-9]+[.][0-9]+[.]','') END AS encoding
    FROM (SELECT recording_blob_key AS key FROM workflow_recordings
      UNION ALL SELECT manifest_json->'row'->>'recordingBlobKey' FROM workflow_run_evidence WHERE manifest_json IS NOT NULL) artifacts
    WHERE key IS NOT NULL ORDER BY 1`);
  const encodings = result.rows.map((row) => row.encoding);
  if (encodings.some((encoding) => !['identity', 'gzip', 'br'].includes(encoding)))
    throw new Error('An unknown stored recording encoding prevents transition.');
  return encodings;
}

export async function withRecordingOperatorLease<T>(
  config: ManagedWorkflowStorageConfig,
  role: 'converter' | 'transition',
  run: (pool: Pool, signal: AbortSignal, check: () => Promise<void>, client: PoolClient) => Promise<T>,
  connection?: Pick<ManagedWorkflowStorageConfig, 'databaseUrl' | 'databaseSslMode'>,
) {
  if (role === 'converter' && (isReleaseMaintenanceActive() || isVmMigrationMaintenanceActive()))
    throw new Error('Recompression requires serving mode.');
  const pool = new Pool({ ...operatorConnectionConfig(getManagedDbPoolConfig({ ...config, ...connection })), max: 2 });
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  const abort = new AbortController();
  const lost = () => abort.abort(new Error('Recording storage coordination was lost.'));
  client.on('error', lost);
  pool.on('error', lost);
  let unlock: (() => Promise<void>) | undefined, restore: (() => Promise<void>) | undefined;
  let checking: Promise<void> | undefined;
  const check = async () => {
    abort.signal.throwIfAborted();
    checking ??= (async () => {
      try {
        await client.query('SELECT 1');
      } catch (error) {
        lost();
        throw error;
      }
    })().finally(() => {
      checking = undefined;
    });
    await checking;
    abort.signal.throwIfAborted();
  };
  const failures: unknown[] = [];
  let result!: T;
  try {
    // Serialize converters. Transitions share the lock so their nested DDL or
    // restore subprocess can join it without deadlocking the outer wrapper.
    unlock = await acquireRecordingStorageLock(client, role === 'converter' ? 'exclusive' : 'shared');
    // Backups/releases also remain readers until completion. Native supervised
    // restore owns its exclusive restore lock internally and is not nested here.
    restore = await acquireRestoreServingLease(pool, client);
    result = await run(pool, abort.signal, check, client);
  } catch (error) {
    failures.push(error);
  } finally {
    // Keep the listener through socket destruction: a terminated PostgreSQL
    // session can emit another error while its failed queries are unwinding.
    // This client is destroyed below, never returned for reuse.
    for (const dispose of [() => checking, restore, unlock, () => client.release(true), () => pool.end()]) {
      try {
        await dispose?.();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Recording coordination and cleanup failed.');
  abort.signal.throwIfAborted();
  return result;
}

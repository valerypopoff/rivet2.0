import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { z } from 'zod';
import {
  deriveManagedSettingsEncryptionKey,
  encryptManagedSettingsValue,
  decryptManagedSettingsValue,
} from '../app-settings/managed-settings-crypto.js';

export const RESTORE_LOCK = [8072, 24004] as const;
const phases = [
  'uploading',
  'validating',
  'awaiting-confirmation',
  'draining',
  'clearing',
  'importing',
  'verifying',
  'restarting',
  'completed',
  'failed',
  'cancelled',
] as const;
export type RestorePhase = (typeof phases)[number];
export const restoreOperationSchema = z
  .object({
    id: z.string().uuid(),
    phase: z.enum(phases),
    destructive: z.boolean(),
    createdAt: z.string(),
    archiveDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    bytes: z.number().nonnegative(),
    projects: z.number().int().nonnegative().optional(),
    recordings: z.number().int().nonnegative().optional(),
    destinationProjects: z.number().int().nonnegative().optional(),
    destinationRecordings: z.number().int().nonnegative().optional(),
    backupCreatedAt: z.string().optional(),
    integrityOverridden: z.boolean().optional(),
    message: z.string(),
  })
  .strict()
  .refine(
    (operation) =>
      ['importing', 'verifying', 'restarting', 'completed'].includes(operation.phase)
        ? operation.destructive
        : ['uploading', 'validating', 'awaiting-confirmation', 'draining', 'cancelled'].includes(operation.phase)
          ? !operation.destructive
          : true,
    'Restore phase does not match destructive authorization.',
  );
export type RestoreOperation = z.infer<typeof restoreOperationSchema>;

export function canProceedAfterRestoreValidationFailure(operation: RestoreOperation | null): boolean {
  return (
    !!operation &&
    operation.phase === 'failed' &&
    !operation.destructive &&
    !!operation.archiveDigest &&
    !operation.integrityOverridden
  );
}

/** Small durable coordinator. Secrets never enter its public journal. */
export class LegacyRestoreControl {
  readonly pool: Pool;
  constructor(
    config: PoolConfig,
    private readonly secret: string,
    private readonly maxConnections: 1 | 2 = 2,
  ) {
    this.pool = new Pool({ ...config, max: maxConnections });
  }
  /** Read-only ownership gate before a deployment may change application DDL. */
  async assertDeploymentIfInitialized(deployment: string): Promise<boolean> {
    if (!deployment || deployment.length > 256) throw new Error('Restore deployment identity is missing.');
    const existing = (
      await this.pool.query(
        "SELECT to_regclass('rivet_restore_control.installation') AS installation,to_regclass('rivet_restore_control.operation') AS operation",
      )
    ).rows[0];
    if (!!existing?.installation !== !!existing?.operation) throw new Error('Restore control schema is incomplete.');
    if (existing?.installation) await this.assertDeployment(deployment);
    return !!existing?.installation;
  }
  /** Serialize first-install ownership, DDL and binding with other migrations
   * and the existing restore coordinator. An unfinished restore must recover first. */
  async withDeploymentMigration<T>(deployment: string, migrate: () => Promise<T>): Promise<T> {
    if (this.maxConnections < 2)
      throw new Error('Deployment migration requires its dedicated two-connection coordinator.');
    const client = await this.lock();
    try {
      if (await this.assertDeploymentIfInitialized(deployment)) {
        const operation = await this.read();
        if (operation && !['completed', 'cancelled'].includes(operation.phase))
          throw new Error('Finish or cancel the existing legacy restore before migrating this deployment.');
      }
      const result = await migrate();
      await this.initialize(deployment);
      return result;
    } finally {
      await this.unlock(client);
    }
  }
  async initialize(deployment: string) {
    if (!deployment || deployment.length > 256) throw new Error('Restore deployment identity is missing.');
    const existing = (
      await this.pool.query(
        "SELECT to_regclass('rivet_restore_control.installation') AS installation,to_regclass('rivet_restore_control.operation') AS operation",
      )
    ).rows[0];
    if (existing?.installation && existing?.operation) {
      await this.assertDeployment(deployment);
      return;
    }
    if (existing?.installation || existing?.operation) throw new Error('Restore control schema is incomplete.');
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      // Schema and deployment binding are one durable unit. A crash must not leave complete but ownerless tables.
      await client.query(`CREATE SCHEMA IF NOT EXISTS rivet_restore_control;
        CREATE TABLE IF NOT EXISTS rivet_restore_control.installation(singleton BOOLEAN PRIMARY KEY CHECK(singleton), deployment TEXT NOT NULL, epoch UUID);
        CREATE TABLE IF NOT EXISTS rivet_restore_control.operation(singleton BOOLEAN PRIMARY KEY CHECK(singleton),
          journal JSONB NOT NULL, ciphertext BYTEA, iv BYTEA, auth_tag BYTEA, key_id TEXT)`);
      await client.query(
        'INSERT INTO rivet_restore_control.installation(singleton,deployment) VALUES(TRUE,$1) ON CONFLICT DO NOTHING',
        [deployment],
      );
      const owner = (
        await client.query('SELECT deployment FROM rivet_restore_control.installation WHERE singleton=TRUE')
      ).rows[0];
      if (owner?.deployment !== deployment) throw new Error('Managed catalog belongs to a different Rivet deployment.');
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
  async assertDeployment(deployment: string) {
    const row = (
      await this.pool.query('SELECT deployment FROM rivet_restore_control.installation WHERE singleton=TRUE')
    ).rows[0];
    if (!row || row.deployment !== deployment)
      throw new Error('Managed catalog belongs to a different Rivet deployment.');
  }
  async read(): Promise<RestoreOperation | null> {
    const row = (await this.pool.query('SELECT journal FROM rivet_restore_control.operation WHERE singleton=TRUE'))
      .rows[0];
    return row ? restoreOperationSchema.parse(row.journal) : null;
  }
  async readEpoch(): Promise<string> {
    return (
      (await this.pool.query('SELECT epoch FROM rivet_restore_control.installation WHERE singleton=TRUE')).rows[0]
        ?.epoch ?? 'initial'
    );
  }
  async write(operation: RestoreOperation, payload?: Record<string, unknown>): Promise<void> {
    restoreOperationSchema.parse(operation);
    if (payload) {
      const encrypted = encryptManagedSettingsValue(
        { key: `legacy-restore:${operation.id}`, schemaVersion: 1 },
        payload,
        deriveManagedSettingsEncryptionKey(this.secret),
      );
      const result = await this.pool.query(
        `WITH updated AS (INSERT INTO rivet_restore_control.operation(singleton,journal,ciphertext,iv,auth_tag,key_id)
        VALUES(TRUE,$1,$2,$3,$4,$5) ON CONFLICT(singleton) DO UPDATE SET journal=$1,ciphertext=$2,iv=$3,auth_tag=$4,key_id=$5 RETURNING journal)
        UPDATE rivet_restore_control.installation SET epoch=CASE WHEN $6::boolean THEN $7::uuid ELSE epoch END
        WHERE singleton=TRUE AND EXISTS(SELECT 1 FROM updated)`,
        [
          operation,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyId,
          operation.destructive,
          operation.id,
        ],
      );
      if (result.rowCount !== 1) throw new Error('Restore installation ownership changed.');
    } else {
      const result = await this.pool.query(
        `WITH updated AS (UPDATE rivet_restore_control.operation SET journal=$1 WHERE singleton=TRUE RETURNING journal)
        UPDATE rivet_restore_control.installation SET epoch=CASE WHEN $2::boolean THEN $3::uuid ELSE epoch END
        WHERE singleton=TRUE AND EXISTS(SELECT 1 FROM updated)`,
        [operation, operation.destructive, operation.id],
      );
      if (result.rowCount !== 1) throw new Error('Restore installation ownership changed.');
    }
  }
  async payload(id: string): Promise<Record<string, unknown>> {
    const row = (await this.pool.query('SELECT * FROM rivet_restore_control.operation WHERE singleton=TRUE')).rows[0];
    if (!row || row.journal.id !== id || !row.ciphertext) throw new Error('Restore recovery data is unavailable.');
    const key = deriveManagedSettingsEncryptionKey(this.secret);
    return decryptManagedSettingsValue(
      { key: `legacy-restore:${id}`, schemaVersion: 1 },
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyId: row.key_id },
      new Map([[key.id, key]]),
    );
  }
  async lock(waitMs = 0): Promise<PoolClient> {
    const client = await this.pool.connect();
    try {
      const deadline = Date.now() + waitMs;
      while (true) {
        const result = await client.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', [8072, 24005]);
        if (result.rows[0]?.acquired) break;
        if (Date.now() >= deadline) throw new Error('Another restore owner is running.');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return client;
    } catch (error) {
      client.release(true); // A failed query may leave session-level locks held; never return it to the pool.
      throw error;
    }
  }
  async unlock(client: PoolClient) {
    let failed = false;
    try {
      await client.query('SELECT pg_advisory_unlock($1,$2)', [...RESTORE_LOCK]);
      await client.query('SELECT pg_advisory_unlock($1,$2)', [8072, 24005]);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      client.release(failed);
    }
  }
  async exclusive(client: PoolClient): Promise<boolean> {
    return Boolean(
      (await client.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', [...RESTORE_LOCK])).rows[0]?.acquired,
    );
  }
  async dispose() {
    await this.pool.end();
  }
  async forgetPayload(id: string) {
    await this.pool.query(
      `UPDATE rivet_restore_control.operation SET ciphertext=NULL,iv=NULL,auth_tag=NULL,key_id=NULL
      WHERE singleton=TRUE AND journal->>'id'=$1 AND journal->>'phase' IN ('completed','cancelled')`,
      [id],
    );
  }
}

export function restoreBlocksServing(operation: RestoreOperation | null): boolean {
  return (
    !!operation &&
    !['uploading', 'validating', 'awaiting-confirmation', 'completed', 'cancelled'].includes(operation.phase) &&
    (operation.phase !== 'failed' || operation.destructive)
  );
}

/** Serving processes hold a session lock until all producers and stores have disposed. */
export async function acquireRestoreServingLease(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock_shared($1,$2)', [...RESTORE_LOCK]);
    const present = (await client.query("SELECT to_regclass('rivet_restore_control.operation') AS name")).rows[0]?.name;
    if (present) {
      const row = (await client.query('SELECT journal FROM rivet_restore_control.operation WHERE singleton=TRUE'))
        .rows[0];
      if (
        row?.journal?.phase !== 'restarting' &&
        restoreBlocksServing(row ? restoreOperationSchema.parse(row.journal) : null)
      )
        throw new Error('Legacy restore maintenance is active.');
    }
    let release: Promise<void> | undefined;
    return () =>
      (release ??= (async () => {
        let failed = false;
        try {
          await client.query('SELECT pg_advisory_unlock_shared($1,$2)', [...RESTORE_LOCK]);
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          client.release(failed);
        }
      })());
  } catch (error) {
    client.release(true);
    throw error;
  }
}

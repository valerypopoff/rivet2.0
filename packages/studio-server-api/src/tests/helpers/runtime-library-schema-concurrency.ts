import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ensureManagedRuntimeLibrariesSchema } from '../../runtime-libraries/managed/schema.js';

/** Real PostgreSQL lock-upgrade regression. All application tables live in a
 * unique test schema; no installation catalog or live jobs are modified. */
export async function verifyRuntimeLibrarySchemaClaimConcurrency(pool: Pool): Promise<void> {
  const schema = `rivet_schema_claim_${randomUUID().replaceAll('-', '')}`;
  const clients: PoolClient[] = [];
  let initialization: Promise<void> | undefined;
  try {
    while (clients.length < 3) clients.push(await pool.connect());
    const [ddl, claim, observer] = clients as [PoolClient, PoolClient, PoolClient];
    const ddlPool = { connect: async () => ({ query: ddl.query.bind(ddl), release() {} }) } as unknown as Pool;
    await ddl.query(`CREATE SCHEMA "${schema}"`);
    for (const client of [ddl, claim]) {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query("SET lock_timeout = '5s'; SET statement_timeout = '10s'");
    }
    await ensureManagedRuntimeLibrariesSchema(ddlPool);
    const pid = (await ddl.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await claim.query('BEGIN; LOCK TABLE runtime_library_jobs IN ROW SHARE MODE');
    // Observe failures immediately, but retain the original rejection below.
    initialization = ensureManagedRuntimeLibrariesSchema(ddlPool);
    void initialization.catch(() => {});
    const deadline = Date.now() + 4_000;
    while (true) {
      const waiting = await observer.query<{ waiting: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1 AND mode='AccessExclusiveLock' AND NOT granted) AS waiting",
        [pid],
      );
      if (waiting.rows[0]!.waiting) break;
      if (Date.now() >= deadline) throw Error('Schema initialization did not reach the protected lock boundary');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Old initialization held an index ShareLock here, causing a real deadlock.
    await claim.query('UPDATE runtime_library_jobs SET updated_at=NOW() WHERE false');
    await claim.query('COMMIT');
    await initialization;
    assert.equal((await ddl.query('SELECT count(*)::int AS count FROM runtime_library_jobs')).rows[0]!.count, 0);
  } finally {
    const [ddl, claim, observer] = clients;
    if (claim) await claim.query('ROLLBACK').catch(() => {});
    await initialization?.catch(() => {});
    if (ddl) await ddl.query('RESET search_path; RESET lock_timeout; RESET statement_timeout').catch(() => {});
    if (claim) await claim.query('RESET search_path; RESET lock_timeout; RESET statement_timeout').catch(() => {});
    if (observer) await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    for (const client of clients) client.release();
  }
}

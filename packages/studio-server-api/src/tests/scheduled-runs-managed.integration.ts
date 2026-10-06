import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  migrateManagedWorkflowSchema,
  verifyManagedWorkflowSchema,
} from '../routes/workflows/managed/schema-migrations.js';
import { ScheduledRunStore } from '../scheduled-runs/store.js';
import { migrateOperationalSqlite } from '../scripts/migrate-operational-sqlite.js';

// This integration gate owns its database; it never reads deployment credentials.
const name = `rivet-schedules-${randomUUID()}`;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
let container: string | undefined;
let pool: Pool | undefined;
let a: ScheduledRunStore | undefined, b: ScheduledRunStore | undefined;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-scheduled-import-'));
try {
  container = docker(
    'run',
    '-d',
    '--name',
    name,
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_DB=rivet_schedule_fixture',
    'postgres:16-alpine',
  );
  const port = docker(
    'inspect',
    '--format',
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    container,
  );
  const config = {
    connectionString: `postgres://postgres@127.0.0.1:${port}/rivet_schedule_fixture`,
    connectionTimeoutMillis: 1000,
    statement_timeout: 10_000,
  };
  pool = new Pool(config);
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await delay(100);
    }
  }
  await migrateManagedWorkflowSchema(pool);
  await verifyManagedWorkflowSchema(pool);
  a = ScheduledRunStore.postgres(new Pool(config));
  b = ScheduledRunStore.postgres(new Pool(config));
  const createKey = randomUUID(),
    runKey = randomUUID();
  const s = await a.save(
    {
      name: 'Managed fixture',
      description: '',
      projectId: 'fixture',
      version: 'latest',
      enabled: false,
      timeZone: 'UTC',
      schedule: { kind: 'daily', time: '12:00' },
      record: false,
      timeoutMinutes: 1,
      missed: 'skip',
    },
    undefined,
    0,
    createKey,
  );
  const occurrence = await a.runNow(s.id, s.revision, runKey);
  assert.equal(await b.enabledCount(), 0);
  const enabled = await a.save({ ...s, name: 'Enabled count fixture', enabled: true });
  assert.equal(await b.enabledCount(), 1);
  await a.delete(enabled.id, enabled.revision);
  assert.equal(await b.enabledCount(), 0);
  assert.equal((await b.save(s, undefined, 0, createKey)).id, s.id);
  await assert.rejects(() => b!.save({ ...s, name: 'Different intent' }, undefined, 0, createKey), /different action/);
  assert.equal((await b.runNow(s.id, s.revision, runKey)).id, occurrence.id);
  const claims = await Promise.all([a.tick('a', 1), b.tick('b', 1)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const owner = claims[0] ? 'a' : 'b';
  assert.equal(await a.accept(occurrence.id, owner, { graphId: 'main' }), true);
  assert.equal((await b.runNow(s.id, s.revision)).status, 'skipped');
  // Simulate loss without a one-minute sleep or the process wall clock.
  await pool.query('UPDATE rivet_schedule_runs SET lease_until=0 WHERE id=$1', [occurrence.id]);
  await b.tick('successor', 1);
  await a.finish(occurrence.id, owner, { status: 'succeeded' });
  assert.equal((await a.list()).history.find((r) => r.id === occurrence.id)?.status, 'interrupted');
  const retryKey = randomUUID();
  const retries = await Promise.all([a.retry(occurrence.id, retryKey), b.retry(occurrence.id, retryKey)]);
  assert.equal(retries[0]!.id, retries[1]!.id);
  assert.equal((await a.list()).history.filter((r) => r.status === 'queued').length, 1);
  await a.cancel(retries[0]!.id);
  const expired = await a.runNow(s.id, s.revision);
  const oldTime = Date.now() - 16 * 60_000;
  // Owned fixture timestamps exercise expiry without a fifteen-minute sleep.
  await pool.query('UPDATE rivet_schedule_runs SET scheduled_at=$1,json=$2 WHERE id=$3', [
    oldTime,
    JSON.stringify({ ...expired, scheduledAt: oldTime, queuedAt: oldTime }),
    expired.id,
  ]);
  const freshSchedule = await a.save({ ...s, name: 'Fresh queue work' });
  const fresh = await a.runNow(freshSchedule.id, freshSchedule.revision);
  assert.equal((await b.tick('fresh-worker', 1))?.occurrence.id, fresh.id);
  const retired = (await a.list()).history.find((run) => run.id === expired.id)!;
  assert.equal(retired.status, 'skipped');
  assert.ok(retired.finishedAt! > oldTime);
  await pool.query('UPDATE rivet_schedule_runs SET scheduled_at=$1,json=$2 WHERE id=$3', [
    oldTime,
    JSON.stringify({ ...fresh, status: 'claimed', scheduledAt: oldTime }),
    fresh.id,
  ]);
  // Large owned history exercises the portable priority/pruning SQL without
  // thousands of network round trips or any wall-clock execution waits.
  await pool.query(
    `INSERT INTO rivet_schedule_runs(id,schedule_id,status,scheduled_at,json,draft_json)
     SELECT 'fixture-terminal-' || n, $1, 'succeeded', $2::bigint+n,
       ($3::jsonb || jsonb_build_object('id','fixture-terminal-' || n,'scheduledAt',$2::bigint+n))::text, $4
     FROM generate_series(1,1001) AS n`,
    [
      freshSchedule.id,
      Date.now(),
      JSON.stringify({ ...fresh, status: 'succeeded', finishedAt: Date.now() }),
      JSON.stringify(freshSchedule),
    ],
  );
  assert.equal((await a.list()).history[0]?.id, fresh.id);
  await b.tick('full-worker', 0);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT COUNT(*) AS count FROM rivet_schedule_runs WHERE status NOT IN ('queued','claimed','running')",
        )
      ).rows[0].count,
    ),
    1000,
  );
  assert.equal((await a.list()).history[0]?.id, fresh.id);
  await a.cancel(fresh.id);
  await a.delete(freshSchedule.id, freshSchedule.revision);
  await assert.rejects(() => b!.save({ ...s, name: 'Stale' }, s.id, 0), /another window/);
  await a.delete(s.id, s.revision);
  await pool.query('DELETE FROM rivet_schedule_runs');
  await pool.query('DELETE FROM rivet_schedule_requests');
  const source = ScheduledRunStore.sqlite(path.join(root, 'scheduled-runs.sqlite'));
  try {
    const imported = await source.save({ ...s, enabled: true }, undefined, 0, randomUUID());
    await source.runNow(imported.id, imported.revision, randomUUID());
    const running = (await source.tick('source'))!;
    assert.equal(await source.accept(running.occurrence.id, 'source', { graphId: 'main' }), true);
  } finally {
    await source.close();
  }
  const target = {
    databaseMode: 'local-docker' as const,
    databaseUrl: config.connectionString,
    databaseSslMode: 'disable' as const,
    objectStorageBucket: 'unused-fixture',
    objectStorageRegion: 'unused',
    objectStorageEndpoint: null,
    objectStorageAccessKeyId: 'unused',
    objectStorageSecretAccessKey: 'unused',
    objectStoragePrefix: '',
    objectStorageForcePathStyle: true,
  };
  assert.equal(await migrateOperationalSqlite({ sourceAppDataRoot: root, target }), 4);
  assert.equal(await migrateOperationalSqlite({ sourceAppDataRoot: root, target, verifyOnly: true }), 4);
  const importedState = await a.list();
  assert.equal(importedState.schedules[0]?.enabled, false);
  assert.equal(importedState.history[0]?.status, 'interrupted');
  assert.equal(await b.tick('destination'), undefined);
  console.log(
    'Real PostgreSQL scheduler migration, competing claims, queue expiry, history bounds, CAS and lost-worker checks passed.',
  );
} finally {
  await a?.close();
  await b?.close();
  await pool?.end();
  if (container) docker('rm', '-f', container);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

// Use the API's compiled migration owner and dependency scope, just like the
// migration image. No caller-provided database is accepted by this destructive test.
const require = createRequire(new URL('../../../packages/studio-server-api/package.json', import.meta.url));
const { Pool } = require('pg');
const { migrateManagedWorkflowSchema, verifyManagedWorkflowSchema, CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION } =
  await import(
    '../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/schema-migrations.js'
  );
const name = `rivet-schema-check-${randomUUID()}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
let containerId;
let pool;
try {
  // Only publish on loopback and let Docker allocate an unused host port.
  containerId = docker(
    'run',
    '-d',
    '--name',
    name,
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_DB=rivet_schema_check',
    'postgres:16.8-alpine',
  );
  const port = Number(
    docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', containerId),
  );
  assert.ok(Number.isInteger(port) && port > 0, 'Docker must publish a PostgreSQL port');
  pool = new Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database: 'rivet_schema_check',
    connectionTimeoutMillis: 1_000,
    query_timeout: 30_000,
    max: 2,
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(250);
    }
  }
  const compatibilityWindow = {
    minimumVersion: CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
    maximumVersion: CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
  };
  const options = { compatibilityWindow };
  const migrated = await migrateManagedWorkflowSchema(pool, options);
  assert.equal(migrated.currentVersion, CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION);
  assert.equal((await verifyManagedWorkflowSchema(pool, options)).currentVersion, migrated.currentVersion);
  assert.deepEqual((await migrateManagedWorkflowSchema(pool, options)).appliedVersions, []);

  // Preserve strict validation: accepting real catalog formatting must not
  // accept a same-named index that omits suspicious recordings.
  await pool.query('DROP INDEX workflow_recordings_workflow_failed_created_at_recording_id_idx');
  await pool.query(`CREATE INDEX workflow_recordings_workflow_failed_created_at_recording_id_idx
    ON workflow_recordings (workflow_id, created_at DESC, recording_id DESC) WHERE status = 'failed'`);
  await assert.rejects(
    verifyManagedWorkflowSchema(pool, options),
    /workflow_recordings_workflow_failed_created_at_recording_id_idx/,
  );
  console.log(
    'Managed schema: fresh migration, verification, idempotence and index-drift rejection passed on PostgreSQL 16.8.',
  );
} finally {
  try {
    await pool?.end();
  } finally {
    if (containerId) {
      const cleanup = spawnSync('docker', ['rm', '-f', '-v', containerId], { encoding: 'utf8', timeout: 60_000 });
      if (cleanup.error || cleanup.status !== 0) {
        console.error(
          `Failed to remove owned schema-check container ${name}: ${cleanup.error?.message ?? cleanup.stderr}`,
        );
        process.exitCode = 1;
      }
    }
  }
}

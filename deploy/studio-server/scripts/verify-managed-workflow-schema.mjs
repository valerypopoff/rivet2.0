import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { containerServerConfig, createManagedCompose } from './lib/container-server-config.mjs';
import { verifyFolderParentMigration } from './lib/verify-folder-parent-migration.mjs';
import { verifyNamespaceMutations } from './lib/verify-namespace-mutations.mjs';

// Use the API's compiled migration owner and dependency scope, just like the
// migration image. No caller-provided database is accepted by this destructive test.
const require = createRequire(new URL('../../../packages/studio-server-api/package.json', import.meta.url));
const { Pool } = require('pg');
const {
  migrateManagedWorkflowSchema,
  verifyManagedWorkflowSchema,
  getManagedWorkflowSchemaCompatibilityWindow,
  CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
  MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE,
  MANAGED_WORKFLOW_SCHEMA_MIGRATIONS,
} = await import(
  '../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/schema-migrations.js'
);
// Exercise the deployment's actual environment projection, not an options
// argument the migration writer deliberately does not accept as an override.
// These are fixture values only; never read the operator's .env.
const config = containerServerConfig(
  {
    RIVET_DEV_COMPOSE_PROJECT: 'rivet-schema-fixture',
    RIVET_KEY: 'schema-fixture-key-'.repeat(3),
    RIVET_LOCAL_POSTGRES_PASSWORD: 'schema-fixture-postgres',
    RIVET_LOCAL_S3_SECRET_ACCESS_KEY: 'schema-fixture-minio',
  },
  'dev',
  'local-storage',
);
const model = createManagedCompose(config, { api: 'fixture/api', web: 'fixture/web', proxy: 'fixture/proxy' });
const migrationEnv = model.services.migrate.environment;
const servingEnv = model.services.backend.environment;
assert.deepEqual(
  getManagedWorkflowSchemaCompatibilityWindow(migrationEnv),
  {
    minimumVersion: CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
    maximumVersion: CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
  },
  'The generated migration environment must match the compiled API schema exactly',
);

async function withSchemaEnvironment(env, run) {
  const names = ['RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION', 'RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION'];
  const original = names.map((name) => process.env[name]);
  try {
    for (const name of names) process.env[name] = env[name];
    return await run();
  } finally {
    names.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
  }
}
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
  // Reader compatibility is not permission to mutate application DDL. When
  // this release has a wider reader window, reproduce the startup rejection.
  if (servingEnv.RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION !== migrationEnv.RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION) {
    await withSchemaEnvironment(servingEnv, () =>
      assert.rejects(migrateManagedWorkflowSchema(pool), /migrations require the exact schema version/),
    );
    const untouched = await pool.query('SELECT to_regclass($1) AS name', [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE]);
    assert.equal(untouched.rows[0].name, null, 'Rejected writer policy must not create even the migration ledger');
  }
  const compatibilityWindow = getManagedWorkflowSchemaCompatibilityWindow(servingEnv);
  const options = { compatibilityWindow };
  const migrated = await withSchemaEnvironment(migrationEnv, () => migrateManagedWorkflowSchema(pool));
  assert.equal(migrated.currentVersion, CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION);
  assert.equal((await verifyManagedWorkflowSchema(pool, options)).currentVersion, migrated.currentVersion);
  assert.deepEqual(
    (await withSchemaEnvironment(migrationEnv, () => migrateManagedWorkflowSchema(pool))).appliedVersions,
    [],
  );

  // Retain the fresh-install assertion above as well as a real 16 -> 17 upgrade.
  // This second database is inside the same newly owned disposable container.
  await pool.query('CREATE DATABASE rivet_folder_migration_check');
  const repairPool = new Pool({ ...pool.options, database: 'rivet_folder_migration_check' });
  try {
    await withSchemaEnvironment(migrationEnv, () =>
      verifyFolderParentMigration(repairPool, {
        migrations: MANAGED_WORKFLOW_SCHEMA_MIGRATIONS,
        migrate: migrateManagedWorkflowSchema,
        verify: verifyManagedWorkflowSchema,
        options,
      }),
    );
    await verifyNamespaceMutations(repairPool);
  } finally {
    await repairPool.end();
  }

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
    'Managed schema: generated launcher policy, fresh migration, serving verification, idempotence and index-drift rejection passed on PostgreSQL 16.8.',
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

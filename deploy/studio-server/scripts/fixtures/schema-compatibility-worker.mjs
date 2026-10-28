import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { probeSchemaRepositories } from './schema-compatibility-probe.mjs';

assert.equal(process.env.RIVET_SCHEMA_COMPATIBILITY_FIXTURE, 'isolated');
const root = '/app/packages/studio-server-api';
const require = createRequire(`${root}/package.json`);
const { Pool } = require('pg');
const load = (name) => import(pathToFileURL(`${root}/dist/studio-server-api/src/routes/workflows/managed/${name}.js`));
const [migrations, factory, recordings, db, mappers] = await Promise.all(
  ['schema-migrations', 'revision-factory', 'recordings', 'db', 'mappers'].map(load),
);
const version = migrations.CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION;
assert.equal(version, Number(process.env.RIVET_SCHEMA_PROBE_VERSION), 'Probe used an unexpected image schema');
if (process.env.RIVET_SCHEMA_PROBE_ROLE === 'candidate') {
  assert.equal(migrations.ROLLING_SCHEMA_LOCK_TIMEOUT_MS, 1000, 'Unqualified rolling lock budget');
  assert.equal(migrations.ROLLING_SCHEMA_STATEMENT_TIMEOUT_MS, 5000, 'Unqualified rolling statement budget');
  assert.equal(migrations.MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.find((m) => m.version === 18)?.rollingSafe, true);
}
const pool = new Pool({
  host: 'release-gate-postgres',
  database: process.env.RIVET_SCHEMA_PROBE_DATABASE ?? 'rivet',
  user: process.env.RIVET_SCHEMA_PROBE_USER ?? 'rivet',
  password: process.env.RIVET_SCHEMA_PROBE_DB_PASSWORD,
  max: 5,
  connectionTimeoutMillis: 3000,
  query_timeout: 10000,
});
try {
  await migrations.verifyManagedWorkflowSchema(pool, {
    compatibilityWindow: { minimumVersion: version, maximumVersion: Number(process.env.RIVET_SCHEMA_PROBE_TARGET) },
  });
  const result = await probeSchemaRepositories({
    pool,
    modules: { migrations, factory, recordings, db, mappers },
    role: process.env.RIVET_SCHEMA_PROBE_ROLE,
    runId: process.env.RIVET_SCHEMA_PROBE_ID,
    version,
  });
  console.log(`RIVET_SCHEMA_PROBE_RESULT ${JSON.stringify(result)}`);
} finally {
  await pool.end();
}

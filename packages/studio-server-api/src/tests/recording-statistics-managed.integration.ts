import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { checkStatisticsQueries, statisticsFixture } from './recording-statistics-sql.test.js';
import type { RecordingStatisticsSqlRow } from '../routes/workflows/recording-statistics-sql.js';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
let container: string | undefined;
let pool: Pool | undefined;
try {
  container = docker(
    'run',
    '--rm',
    '-d',
    '--name',
    `rivet-statistics-${randomUUID()}`,
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:16.8-alpine',
  );
  const port = docker(
    'inspect',
    '--format',
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    container,
  );
  pool = new Pool({
    connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`,
    connectionTimeoutMillis: 1_000,
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await delay(100);
    }
  }
  await pool.query(`CREATE TABLE workflow_recordings (
    recording_id text PRIMARY KEY, workflow_id text NOT NULL, source_project_name text NOT NULL,
    created_at timestamptz NOT NULL, run_kind text NOT NULL, status text NOT NULL,
    duration_ms double precision NOT NULL, endpoint_name_at_execution text NOT NULL,
    execution_surface text, ui_graph_id_at_execution text, component_id_at_execution text,
    ui_graph_name_at_execution text, component_type_at_execution text, component_label_at_execution text
  )`);
  for (const row of statisticsFixture) {
    const identity = row.executionIdentity;
    await pool.query('INSERT INTO workflow_recordings VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [
      row.recordingId,
      row.workflowId,
      row.sourceProjectName,
      row.createdAt,
      row.runKind,
      row.status,
      row.durationMs,
      row.endpointNameAtExecution,
      identity?.surface ?? null,
      identity?.uiGraphId ?? null,
      identity?.componentId ?? null,
      identity?.uiGraphName ?? null,
      identity?.componentType ?? null,
      identity?.componentLabel ?? null,
    ]);
  }
  const database = pool;
  await checkStatisticsQueries(
    'postgres',
    async ({ sql, values }) => (await database.query<RecordingStatisticsSqlRow>(sql, values)).rows,
  );
  console.log('PostgreSQL and SQLite statistics parity passed on real database engines.');
} finally {
  await pool?.end();
  if (container) docker('stop', container);
}

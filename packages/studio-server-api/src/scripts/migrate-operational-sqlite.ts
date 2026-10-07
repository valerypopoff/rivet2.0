import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Pool, type PoolClient } from 'pg';

import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import type { ManagedWorkflowStorageConfig } from '../routes/workflows/storage-config.js';

type Row = Record<string, unknown>;
type Table = {
  name: string;
  sourceSql: string;
  targetSql: string;
  insertSql: string;
  parameters(row: Row): unknown[];
  required?: boolean;
};

const evaluationTables: Table[] = [
  {
    name: 'evaluation_library',
    sourceSql: 'SELECT revision, library_json AS json, updated_at_ms AS timestamp_ms FROM evaluation_library',
    targetSql: `SELECT revision, library_json AS json,
      (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS timestamp_ms FROM evaluation_library`,
    insertSql: `INSERT INTO evaluation_library (singleton_key, revision, library_json, updated_at)
      VALUES (TRUE, $1, $2::jsonb, TO_TIMESTAMP($3::double precision / 1000)) ON CONFLICT DO NOTHING`,
    parameters: (row) => [row.revision, row.json, row.timestamp_ms],
    required: true,
  },
  {
    name: 'evaluation_library_imports',
    sourceSql: 'SELECT source_fingerprint, imported_at_ms AS timestamp_ms FROM evaluation_library_imports',
    targetSql: `SELECT source_fingerprint,
      (EXTRACT(EPOCH FROM imported_at) * 1000)::bigint AS timestamp_ms FROM evaluation_library_imports`,
    insertSql: `INSERT INTO evaluation_library_imports (source_fingerprint, imported_at)
      VALUES ($1, TO_TIMESTAMP($2::double precision / 1000)) ON CONFLICT DO NOTHING`,
    parameters: (row) => [row.source_fingerprint, row.timestamp_ms],
  },
  {
    name: 'evaluation_runs',
    sourceSql:
      'SELECT project_id, run_id, suite_id, started_at, run_json AS json, updated_at_ms AS timestamp_ms FROM evaluation_runs',
    targetSql: `SELECT project_id, run_id, suite_id, started_at, run_json AS json,
      (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS timestamp_ms FROM evaluation_runs`,
    insertSql: `INSERT INTO evaluation_runs (project_id, run_id, suite_id, started_at, run_json, updated_at)
      VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb, TO_TIMESTAMP($6::double precision / 1000)) ON CONFLICT DO NOTHING`,
    parameters: (row) => [row.project_id, row.run_id, row.suite_id, row.started_at, row.json, row.timestamp_ms],
    required: true,
  },
  {
    name: 'evaluation_recordings',
    sourceSql:
      'SELECT project_id, recording_id, run_id, artifact_json AS json, created_at_ms AS timestamp_ms FROM evaluation_recordings',
    targetSql: `SELECT project_id, recording_id, run_id, artifact_json AS json,
      (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS timestamp_ms FROM evaluation_recordings`,
    insertSql: `INSERT INTO evaluation_recordings (project_id, recording_id, run_id, artifact_json, created_at)
      VALUES ($1, $2, $3, $4::jsonb, TO_TIMESTAMP($5::double precision / 1000)) ON CONFLICT DO NOTHING`,
    parameters: (row) => [row.project_id, row.recording_id, row.run_id, row.json, row.timestamp_ms],
    required: true,
  },
  {
    name: 'evaluation_dataset_snapshots',
    sourceSql: `SELECT project_id, dataset_fingerprint, snapshot_json AS json,
      created_at_ms AS timestamp_ms FROM evaluation_dataset_snapshots`,
    targetSql: `SELECT project_id, dataset_fingerprint, snapshot_json AS json,
      (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS timestamp_ms FROM evaluation_dataset_snapshots`,
    insertSql: `INSERT INTO evaluation_dataset_snapshots
      (project_id, dataset_fingerprint, snapshot_json, created_at)
      VALUES ($1, $2, $3::jsonb, TO_TIMESTAMP($4::double precision / 1000)) ON CONFLICT DO NOTHING`,
    parameters: (row) => [row.project_id, row.dataset_fingerprint, row.json, row.timestamp_ms],
    required: true,
  },
];

const scheduleTables: Table[] = [
  {
    name: 'rivet_schedule_requests',
    sourceSql: 'SELECT id,fingerprint,expires_at,resource_id,json FROM rivet_schedule_requests',
    targetSql: 'SELECT id,fingerprint,expires_at,resource_id,json FROM rivet_schedule_requests',
    insertSql:
      'INSERT INTO rivet_schedule_requests(id,fingerprint,expires_at,resource_id,json) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    parameters: (r) => [r.id, r.fingerprint, r.expires_at, r.resource_id, r.json],
    required: true,
  },
  {
    name: 'rivet_schedules',
    sourceSql: 'SELECT id,revision,enabled,next_at,json FROM rivet_schedules',
    targetSql: 'SELECT id,revision,enabled,next_at,json FROM rivet_schedules',
    insertSql:
      'INSERT INTO rivet_schedules(id,revision,enabled,next_at,json) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    parameters: (r) => [r.id, r.revision, r.enabled, r.next_at, r.json],
    required: true,
  },
  {
    name: 'rivet_schedule_runs',
    sourceSql: 'SELECT id,schedule_id,status,owner,lease_until,scheduled_at,json,draft_json FROM rivet_schedule_runs',
    targetSql: 'SELECT id,schedule_id,status,owner,lease_until,scheduled_at,json,draft_json FROM rivet_schedule_runs',
    insertSql:
      'INSERT INTO rivet_schedule_runs(id,schedule_id,status,owner,lease_until,scheduled_at,json,draft_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
    parameters: (r) => [r.id, r.schedule_id, r.status, r.owner, r.lease_until, r.scheduled_at, r.json, r.draft_json],
    required: true,
  },
];

/** Operational import deliberately disables schedules and retires in-flight
 * work. Verification compares this documented safe transform, not live leases. */
function pauseImportedSchedules(rows: Map<string, Row[]>): void {
  for (const row of rows.get('rivet_schedules') ?? []) {
    const s = JSON.parse(String(row.json));
    s.enabled = false;
    s.nextAt = null;
    row.enabled = 0;
    row.next_at = null;
    row.json = JSON.stringify(s);
  }
  for (const row of rows.get('rivet_schedule_runs') ?? []) {
    if (!['queued', 'claimed', 'running'].includes(String(row.status))) continue;
    const run = JSON.parse(String(row.json));
    run.status = row.status === 'running' ? 'interrupted' : 'cancelled';
    run.reason = 'Imported installation; enable schedules explicitly after review.';
    row.status = run.status;
    row.owner = null;
    row.lease_until = null;
    row.json = JSON.stringify(run);
  }
}

const healthTable: Table = {
  name: 'llm_profile_health',
  sourceSql: 'SELECT key, project_id, entry_json AS json, updated_at_ms AS timestamp_ms FROM llm_profile_health',
  targetSql: `SELECT key, project_id, entry_json AS json,
    (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS timestamp_ms FROM llm_profile_health`,
  insertSql: `INSERT INTO llm_profile_health (key, project_id, entry_json, updated_at)
    VALUES ($1, $2, $3::jsonb, TO_TIMESTAMP($4::double precision / 1000)) ON CONFLICT DO NOTHING`,
  parameters: (row) => [row.key, row.project_id, row.json, row.timestamp_ms],
  required: true,
};

// Filesystem mode has no durable hosted-Evaluation scheduler or web-app action
// ledger. A migration importer also must not acquire a maintenance lease.
// Rows here indicate another installation or a prematurely started pod.
const targetOnlyRuntimeTables = [
  'evaluation_hosted_runs',
  'evaluation_hosted_trial_jobs',
  'evaluation_hosted_trial_attempts',
  'web_app_action_runs',
  'web_app_action_run_events',
  'web_app_action_cancel_commands',
  'managed_maintenance_leases',
] as const;

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function canonicalRow(row: Row): string {
  return canonicalJson(
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        key === 'json' && typeof value === 'string'
          ? JSON.parse(value)
          : ['timestamp_ms', 'revision', 'next_at', 'lease_until', 'scheduled_at', 'expires_at'].includes(key) &&
              value !== null
            ? String(value)
            : key === 'started_at'
              ? new Date(String(value)).toISOString()
              : value,
      ]),
    ),
  );
}

async function readSourceRows(filePath: string, tables: Table[]): Promise<Map<string, Row[]>> {
  const result = new Map<string, Row[]>();
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      for (const table of tables) result.set(table.name, []);
      return result;
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Source SQLite database is not a regular file: ${filePath}`);
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 5000;');
    for (const table of tables) {
      const exists = database
        .prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
        .get('table', table.name);
      if (!exists) {
        if (table.required) throw new Error(`Source SQLite database is missing table ${table.name}`);
        result.set(table.name, []);
        continue;
      }
      // Older VM health databases predate project-scoped entries. The normal
      // filesystem store adds this column on open, but migration must not
      // modify its read-only source just to make that compatibility step.
      const columns =
        table.name === 'llm_profile_health'
          ? database.prepare('PRAGMA table_info(llm_profile_health)').all<{ name: string }>()
          : [];
      const sourceSql =
        table.name === 'llm_profile_health' && !columns.some((column) => column.name === 'project_id')
          ? table.sourceSql.replace('key, project_id,', 'key, NULL AS project_id,')
          : table.sourceSql;
      const rows = database.prepare(sourceSql).all<Row>();
      if (table.name === 'llm_profile_health') {
        for (const row of rows) {
          const entry = JSON.parse(String(row.json)) as {
            identity?: { projectId?: unknown };
            failureTimestamps?: unknown;
          };
          if (!Array.isArray(entry.failureTimestamps)) {
            throw new Error(`Source LLM Profile health entry is invalid: ${String(row.key)}`);
          }
          const identityProjectId = entry.identity?.projectId;
          const inferredProjectId =
            typeof identityProjectId === 'string' && identityProjectId.trim() ? identityProjectId : null;
          if (row.project_id != null && inferredProjectId != null && row.project_id !== inferredProjectId) {
            throw new Error(`Source LLM Profile health project scope differs from its entry: ${String(row.key)}`);
          }
          if (row.project_id == null) row.project_id = inferredProjectId;
        }
      }
      for (const row of rows) canonicalRow(row); // Fail before target writes on invalid JSON or timestamps.
      result.set(table.name, rows);
    }
    return result;
  } finally {
    database.close();
  }
}

function assertRowsMatch(table: Table, source: Row[], target: Row[]): void {
  if (source.length !== target.length) throw new Error(`Managed ${table.name} row count differs from source`);
  const sourceRows = source.map(canonicalRow).sort();
  const targetRows = target.map(canonicalRow).sort();
  for (let index = 0; index < sourceRows.length; index += 1) {
    if (sourceRows[index] !== targetRows[index]) {
      throw new Error(`Managed ${table.name} row contents differ from source`);
    }
  }
}

async function copyAndVerify(
  client: PoolClient,
  tables: Table[],
  source: Map<string, Row[]>,
  verifyOnly: boolean,
): Promise<number> {
  let rows = 0;
  for (const table of tables) {
    const sourceRows = source.get(table.name) ?? [];
    if (!verifyOnly) {
      for (const row of sourceRows) await client.query(table.insertSql, table.parameters(row));
    }
    const targetRows = (await client.query<Row>(table.targetSql)).rows;
    assertRowsMatch(table, sourceRows, targetRows);
    rows += sourceRows.length;
  }
  return rows;
}

/** Import exact SQLite operational state after workflow identities exist in PostgreSQL. */
export async function migrateOperationalSqlite(options: {
  sourceAppDataRoot: string;
  target: ManagedWorkflowStorageConfig;
  verifyOnly?: boolean;
}): Promise<number> {
  const [evaluation, health, schedules] = await Promise.all([
    readSourceRows(path.join(options.sourceAppDataRoot, 'evaluation-runs.sqlite'), evaluationTables),
    readSourceRows(path.join(options.sourceAppDataRoot, 'llm-profile-health.sqlite'), [healthTable]),
    readSourceRows(path.join(options.sourceAppDataRoot, 'scheduled-runs.sqlite'), scheduleTables),
  ]);
  pauseImportedSchedules(schedules);
  const pool = new Pool(getManagedDbPoolConfig(options.target));
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const table of targetOnlyRuntimeTables) {
        const existing = await client.query(`SELECT 1 FROM ${table} LIMIT 1`);
        if (existing.rowCount) throw new Error(`Unexpected managed ${table} rows; the destination must stay offline.`);
      }
      const rowCount =
        (await copyAndVerify(client, evaluationTables, evaluation, options.verifyOnly === true)) +
        (await copyAndVerify(client, [healthTable], health, options.verifyOnly === true)) +
        (await copyAndVerify(client, scheduleTables, schedules, options.verifyOnly === true));
      await client.query('COMMIT');
      return rowCount;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

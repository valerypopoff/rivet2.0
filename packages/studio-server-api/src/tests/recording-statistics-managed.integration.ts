import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { familyRows, verifyFamilyQueries } from './helpers/recording-family-fixture.js';
import { checkStatisticsQueries, statisticsFixture } from './recording-statistics-sql.test.js';
import {
  recordingStatisticsRowsSql,
  type RecordingStatisticsSqlRow,
} from '../routes/workflows/recording-statistics-sql.js';
import { createManagedWorkflowRecordingService } from '../routes/workflows/managed/recordings.js';
import { migrateManagedWorkflowSchema } from '../routes/workflows/managed/schema-migrations.js';
import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import { queryOne, queryRows } from '../routes/workflows/managed/db.js';
import * as mappers from '../routes/workflows/managed/mappers.js';

type ExplainPlan = {
  'Node Type': string;
  'Group Key'?: string[];
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Index Cond'?: string;
  Plans?: ExplainPlan[];
};

async function verifySubRunPresence(database: Pool): Promise<void> {
  await database.query('DROP TABLE workflow_recordings');
  await migrateManagedWorkflowSchema(database, { logger: { log() {}, warn() {} } });
  const recordingText = JSON.stringify({
    strings: {},
    recording: { events: [{ type: 'start', data: { inputs: { input: { value: { matched: true } } } } }] },
  });
  const insert = async (
    id: string,
    surface: string | null,
    key: string | null,
    status = 'succeeded',
    workflow = 'caller',
  ) => {
    await database.query(
      `INSERT INTO workflow_recordings (
      recording_id, workflow_id, source_project_name, source_project_relative_path,
      run_kind, status, duration_ms, endpoint_name_at_execution, execution_surface,
      correlation_id, recording_blob_key, replay_project_blob_key, recording_uncompressed_bytes, recording_compressed_bytes
    ) VALUES ($1,$2,'Fixture','fixture.rivet-project','published',$3,1,'flow',$4,$5,$1,$1,$6,$6)`,
      [id, workflow, status, surface, key, Buffer.byteLength(recordingText)],
    );
  };
  const key = (name: string) => `rvt-postgres-presence-${name}`;
  await insert('root', 'workflow_endpoint', key('children'), 'failed');
  await insert('child', 'subgraph_project', key('children'), 'succeeded', 'called');
  await insert('failed-child', 'subgraph_project', key('children'), 'failed', 'called');
  await insert('nested-child', 'subgraph_project', key('children'), 'suspicious', 'nested');
  await insert('empty', 'workflow_endpoint', key('empty'), 'failed');
  await insert('ambiguous', 'workflow_endpoint', key('ambiguous'), 'failed');
  await insert('outside-primary', 'workflow_endpoint', key('ambiguous'), 'succeeded', 'outside');
  await insert('ambiguous-child', 'subgraph_project', key('ambiguous'), 'succeeded', 'called');
  await insert('legacy', null, key('legacy'));
  await insert('legacy-child', 'subgraph_project', key('legacy'), 'failed', 'called');
  await insert('unlinked', 'workflow_endpoint', null);
  await insert('blank', 'workflow_endpoint', ' '.repeat(16));
  const windows: Array<{ sql: string; parameters: unknown[] }> = [];
  const artifactReads: string[] = [];
  const context = {
    pool: database,
    initialize: async () => {},
    revisions: {},
    mappers,
    db: {
      queryOne,
      queryRows: async (client: Pool, sql: string, parameters: unknown[] = []) => {
        if (sql.includes('recording_cursor_created_at')) windows.push({ sql, parameters });
        return queryRows(client, sql, parameters);
      },
    },
    blobStore: {
      getText: async (blob: string) => {
        artifactReads.push(blob);
        return recordingText;
      },
    },
  } as unknown as ManagedWorkflowContext;
  const service = createManagedWorkflowRecordingService({ context });
  const browse = () =>
    service.listWorkflowRecordingRunsPage('caller', 1, 20, 'all', null, 0, undefined, undefined, true, 'families');
  const page = await browse();
  const presence = new Map(page.runs.map((run) => [run.id, run.hasSubRuns]));
  assert.equal(presence.get('root'), true);
  for (const id of ['empty', 'ambiguous', 'unlinked', 'blank']) assert.equal(presence.get(id), false, id);
  assert.equal(presence.get('legacy'), true, 'legacy null surfaces remain valid primaries');
  const children = await service.listWorkflowRecordingRunsPage(
    'root',
    1,
    100,
    'all',
    null,
    0,
    undefined,
    undefined,
    true,
    'children',
  );
  assert.deepEqual(new Set(children.runs.map((run) => run.id)), new Set(['child', 'failed-child', 'nested-child']));
  assert.ok(children.runs.every((run) => run.hasSubRuns === false));
  assert.equal(
    (
      await service.listWorkflowRecordingRunsPage(
        'ambiguous',
        1,
        100,
        'all',
        null,
        0,
        undefined,
        undefined,
        true,
        'children',
      )
    ).totalRuns,
    0,
  );
  assert.equal(artifactReads.length, 0, 'ordinary presence and child discovery must remain metadata-only');
  let filtered = await service.listWorkflowRecordingRunsPage('caller', 1, 20, 'failed', {
    path: '$.matched',
    operator: '==' as const,
    value: 'true',
  });
  const matches = [...filtered.runs];
  for (let attempt = 0; filtered.hasMore && attempt < 20; attempt++) {
    filtered = await service.listWorkflowRecordingRunsPage(
      'caller',
      1,
      20,
      'failed',
      { path: '$.matched', operator: '==' as const, value: 'true' },
      filtered.nextInputCursor,
      undefined,
      filtered.nextInputAfter,
    );
    matches.push(...filtered.runs);
  }
  assert.equal(
    matches.find((run) => run.id === 'root')?.hasSubRuns,
    true,
    `root filters do not filter child presence: ${JSON.stringify({ matches: matches.map((run) => run.id), analyzed: filtered.inputSearchAnalyzedRuns, hasMore: filtered.hasMore, artifactReads })}`,
  );
  assert.ok(artifactReads.every((id) => !id.includes('child')));
  await insert('cursor-new', 'workflow_endpoint', key('cursor-new'), 'failed', 'cursor');
  await insert('cursor-old', 'workflow_endpoint', key('cursor-old'), 'failed', 'cursor');
  await database.query(`UPDATE workflow_recordings SET created_at = CASE recording_id
    WHEN 'cursor-new' THEN '2026-10-19T00:00:00.000123Z'::timestamptz
    ELSE '2026-10-19T00:00:00.000122Z'::timestamptz END WHERE workflow_id = 'cursor'`);
  const filter = { path: '$.matched', operator: '==' as const, value: 'true' };
  const cursorFirst = await service.listWorkflowRecordingRunsPage('cursor', 1, 1, 'failed', filter);
  assert.equal(cursorFirst.runs[0]?.id, 'cursor-new');
  assert.ok(cursorFirst.nextInputAfter);
  assert.ok(Buffer.from(cursorFirst.nextInputAfter, 'base64url').toString().includes('.000123Z'));
  const cursorSecond = await service.listWorkflowRecordingRunsPage(
    'cursor',
    1,
    1,
    'failed',
    filter,
    0,
    undefined,
    cursorFirst.nextInputAfter,
  );
  assert.equal(
    cursorSecond.runs[0]?.id,
    'cursor-old',
    'the CTE must preserve PostgreSQL microseconds across input pages',
  );
  await database.query("DELETE FROM workflow_recordings WHERE recording_id = 'failed-child'");
  assert.equal((await browse()).runs.find((run) => run.id === 'root')?.hasSubRuns, true);
  await database.query("DELETE FROM workflow_recordings WHERE recording_id IN ('child', 'nested-child')");
  assert.equal((await browse()).runs.find((run) => run.id === 'root')?.hasSubRuns, false);
  // Exercise the actual service window against a retained history much larger
  // than the page. Existing production indexes/schema only, no test-only index.
  await database.query(`INSERT INTO workflow_recordings (
    recording_id, workflow_id, source_project_name, source_project_relative_path,
    run_kind, status, duration_ms, endpoint_name_at_execution, execution_surface,
    correlation_id, recording_blob_key, replay_project_blob_key
  ) SELECT 'history-' || i, 'history', 'History', 'history.rivet-project',
    'published', 'succeeded', 1, 'history', 'workflow_endpoint',
    'rvt-postgres-history-' || i, 'unused', 'unused' FROM generate_series(1, 50000) i`);
  await database.query('ANALYZE workflow_recordings');
  await database.query("SET work_mem = '64kB'");
  await service.listWorkflowRecordingRunsPage('caller', 1, 20, 'all');
  const window = windows.at(-1)!;
  const { rows } = await database.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${window.sql}`, window.parameters);
  const report = rows[0]['QUERY PLAN'][0];
  const nodes = (plan: ExplainPlan): ExplainPlan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
  const groups = nodes(report.Plan).filter((plan) =>
    plan['Group Key']?.some((column) => column.includes('member.correlation_id')),
  );
  assert.ok(groups.length > 0, 'the actual presence aggregation must be measured');
  console.log(
    JSON.stringify({
      check: 'postgres-recording-presence',
      historyRows: 50000,
      presenceGroups: groups.map((plan) => plan['Actual Rows']),
      presenceKeysProcessed: groups.map((plan) => plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)),
      executionMs: report['Execution Time'],
    }),
  );
  assert.ok(
    groups.every((plan) => plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0) <= 20),
    'presence must aggregate only visible-page keys, not the complete history',
  );
  await service.listWorkflowRecordingRunsPage('legacy', 1, 100, 'all', null, 0, undefined, undefined, true, 'children');
  const childWindow = windows.at(-1)!;
  const childExplain = await database.query(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${childWindow.sql}`,
    childWindow.parameters,
  );
  const childGroups = nodes(childExplain.rows[0]['QUERY PLAN'][0].Plan).filter((plan) =>
    plan['Group Key']?.some((column) => column.includes('member.correlation_id')),
  );
  assert.ok(
    childGroups.every((plan) => plan['Actual Loops'] === 0),
    'child-only pages must not execute the presence aggregation',
  );

  // Cost statistics use the same metadata-only projection, with the real
  // migrated indexes. A narrow target must not materialize unrelated history.
  await database.query(`UPDATE workflow_recordings SET cost_json = CASE recording_id
    WHEN 'cursor-new' THEN '{"status":"partial","knownCostUsd":0.125}'
    ELSE '{"status":"unknown","knownCostUsd":null}' END WHERE workflow_id = 'cursor'`);
  const statisticsQuery = recordingStatisticsRowsSql('postgres', {
    target: { surface: 'endpoint', workflowId: 'cursor' },
    period: { from: '2026-10-19T00:00:00Z', to: '2026-10-20T00:00:00Z' },
    runKind: 'both',
    includeFailed: false,
    includeWarnings: false,
  });
  const selected = await database.query<RecordingStatisticsSqlRow>(statisticsQuery.sql, statisticsQuery.values);
  assert.deepEqual(
    selected.rows.map((row) => JSON.parse(row.cost_json!)),
    [
      { status: 'unknown', knownCostUsd: null },
      { status: 'partial', knownCostUsd: 0.125 },
    ],
  );
  const statisticsExplain = await database.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statisticsQuery.sql}`,
    statisticsQuery.values,
  );
  const statisticsPlan = statisticsExplain.rows[0]['QUERY PLAN'][0];
  const indexed = nodes(statisticsPlan.Plan).filter((plan) => plan['Index Cond']?.includes('workflow_id'));
  assert.ok(indexed.length > 0, 'a narrow statistics target must use an existing workflow index');
  assert.ok(indexed.every((plan) => plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0) <= 2));
  console.log(
    JSON.stringify({
      check: 'postgres-cost-statistics',
      historyRows: 50000,
      selectedRows: selected.rows.length,
      executionMs: statisticsPlan['Execution Time'],
    }),
  );
}

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
    max: 1,
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
    ui_graph_name_at_execution text, component_type_at_execution text, component_label_at_execution text, cost_json text
  )`);
  for (const row of statisticsFixture) {
    const identity = row.executionIdentity;
    await pool.query('INSERT INTO workflow_recordings VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [
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
      row.cost ? JSON.stringify(row.cost) : null,
    ]);
  }
  const database = pool;
  await checkStatisticsQueries(
    'postgres',
    async ({ sql, values }) => (await database.query<RecordingStatisticsSqlRow>(sql, values)).rows,
  );
  console.log('PostgreSQL and SQLite statistics parity passed on real database engines.');
  await pool.query('DROP TABLE workflow_recordings');
  await pool.query(`CREATE TABLE workflow_recordings (id text, recording_id text PRIMARY KEY, workflow_id text,
    execution_surface text, correlation_id text, status text, created_at timestamptz, metadata_json text)`);
  for (const row of familyRows)
    await pool.query('INSERT INTO workflow_recordings VALUES ($1,$1,$2,$3,$4,$5,$6,$7)', [
      row.id,
      row.workflow,
      row.surface,
      row.correlation,
      row.status,
      row.created,
      JSON.stringify({
        status: row.status,
        createdAt: row.created,
        executionIdentity: { surface: row.surface, correlationId: row.correlation },
      }),
    ]);
  await verifyFamilyQueries('managed', async (sql, values) => (await database.query<{ id: string }>(sql, values)).rows);
  console.log('PostgreSQL family pagination and complete child browsing passed.');
  await test('PostgreSQL sub-run presence, retention and indexed cost statistics over retained history', () =>
    verifySubRunPresence(database));
} finally {
  await pool?.end();
  if (container) docker('stop', container);
}

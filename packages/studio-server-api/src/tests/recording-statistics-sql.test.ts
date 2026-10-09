import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  recordingStatisticsCatalogSql,
  recordingStatisticsRowsSql,
  statisticsSqlRow,
  type RecordingStatisticsSqlRow,
} from '../routes/workflows/recording-statistics-sql.js';
import {
  buildWorkflowRunStatistics,
  buildWorkflowRunStatisticsCatalog,
  type WorkflowRecordingStatisticsRow,
} from '../routes/workflows/recording-statistics.js';
import type { WorkflowRunStatisticsTarget } from '../../../studio-server-shared/workflow-recording-types.js';

export const statisticsFixture = Array.from({ length: 240 }, (_, index) => {
  const identity = [
    undefined,
    { surface: 'workflow_endpoint' },
    { surface: 'web_app_action', uiGraphId: 'ui', componentId: 'button' },
    { surface: 'web_app_action', uiGraphId: '', componentId: 'button' },
    { surface: 'editor_local' },
    { surface: 'subgraph_project' },
    { surface: 'scheduled' },
    undefined,
  ][index % 8] as WorkflowRecordingStatisticsRow['executionIdentity'];
  return {
    recordingId: `recording-${String(index).padStart(3, '0')}`,
    workflowId: index % 3 ? 'workflow-a' : 'workflow-b',
    sourceProjectName: `Project ${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 4, Math.floor(index / 12))).toISOString(),
    runKind: index % 2 ? 'latest' : 'published',
    status: (['succeeded', 'failed', 'suspicious'] as const)[index % 3]!,
    durationMs: index * 13,
    endpointNameAtExecution: index % 8 === 7 || identity?.surface === 'web_app_action' ? '/apps/renamed' : 'endpoint',
    executionIdentity: identity && {
      ...identity,
      ...(index < 120 && identity.surface === 'web_app_action'
        ? { uiGraphName: `UI ${index}`, componentType: 'button' as const, componentLabel: `Button ${index}` }
        : {}),
    },
  } satisfies WorkflowRecordingStatisticsRow & { recordingId: string };
});

export async function checkStatisticsQueries(
  dialect: 'sqlite' | 'postgres',
  read: (query: { sql: string; values: string[] }) => Promise<RecordingStatisticsSqlRow[]>,
) {
  // Ascending timestamp/ID defines the latest row and fallback label semantics.
  const baseline = [...statisticsFixture].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.recordingId.localeCompare(b.recordingId),
  );
  for (const surface of ['endpoint', 'web_app'] as const) {
    const rows = await read(recordingStatisticsCatalogSql(dialect, surface));
    const expected = buildWorkflowRunStatisticsCatalog(baseline, surface);
    assert.equal(rows.length, expected.targets.length, 'SQL returns one row per target, not one row per run');
    assert.deepEqual(buildWorkflowRunStatisticsCatalog(rows.map(statisticsSqlRow), surface), expected);
  }
  const targets: WorkflowRunStatisticsTarget[] = [
    { surface: 'endpoint', workflowId: 'workflow-a' },
    { surface: 'web_app', workflowId: 'workflow-a', uiGraphId: 'ui', componentId: 'button' },
    { surface: 'web_app', workflowId: 'workflow-b', legacyEndpointName: '/apps/renamed' },
    { surface: 'endpoint', workflowId: 'missing' },
  ];
  for (const target of targets) {
    for (const runKind of ['both', 'published', 'latest'] as const) {
      const query = {
        target,
        period: { from: '2026-08-04T04:00:00.000Z', to: '2026-08-04T16:00:00.000Z' },
        runKind,
        includeFailed: false,
        includeWarnings: true,
      };
      const sqlRows = await read(recordingStatisticsRowsSql(dialect, query));
      assert.deepEqual(
        buildWorkflowRunStatistics(sqlRows.map(statisticsSqlRow), query),
        buildWorkflowRunStatistics(baseline, query),
      );
      for (const row of sqlRows) {
        assert.equal(row.workflow_id, target.workflowId);
        assert.ok(new Date(row.created_at).toISOString() >= query.period.from);
        assert.ok(new Date(row.created_at).toISOString() < query.period.to);
        assert.ok(runKind === 'both' || row.run_kind === runKind);
        assert.equal('recording_blob_key' in row, false);
        assert.equal('metadata_json' in row, false);
      }
    }
  }
}

function sqliteFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE recordings (recording_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, metadata_json TEXT NOT NULL);
    CREATE INDEX recordings_workflow_created_at ON recordings(workflow_id, json_extract(metadata_json, '$.createdAt'));`);
  const insert = db.prepare('INSERT INTO recordings VALUES (?, ?, ?)');
  for (const row of statisticsFixture) {
    const { endpointNameAtExecution, ...metadata } = row;
    insert.run(row.recordingId, row.workflowId, JSON.stringify({ ...metadata, endpointName: endpointNameAtExecution }));
  }
  return db;
}

test('SQLite compact statistics queries preserve exact metrics, counts, identities and historical labels', async () => {
  const db = sqliteFixture();
  try {
    await checkStatisticsQueries(
      'sqlite',
      async ({ sql, values }) => db.prepare(sql).all(...values) as RecordingStatisticsSqlRow[],
    );
    const query = recordingStatisticsRowsSql('sqlite', {
      target: { surface: 'endpoint', workflowId: 'workflow-a' },
      period: { from: '2026-08-04T04:00:00.000Z', to: '2026-08-04T16:00:00.000Z' },
      runKind: 'published',
      includeFailed: false,
      includeWarnings: false,
    });
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.values);
    assert.match(JSON.stringify(plan), /SEARCH recordings USING INDEX recordings_workflow_created_at/);
  } finally {
    db.close();
  }
});

test('SQLite statistics fail closed on malformed metadata instead of reporting plausible counts', () => {
  const db = sqliteFixture();
  try {
    db.prepare(
      "UPDATE recordings SET metadata_json = json_set(metadata_json, '$.durationMs', -1) WHERE recording_id = ?",
    ).run('recording-000');
    const query = recordingStatisticsCatalogSql('sqlite', 'endpoint');
    assert.throws(
      () => (db.prepare(query.sql).all(...query.values) as RecordingStatisticsSqlRow[]).map(statisticsSqlRow),
      /inconsistent/,
    );
  } finally {
    db.close();
  }
});

test('statistics reject invalid aggregate counts', () => {
  for (const total_runs of ['0', '-1', '1.5', '9007199254740992', 'bad']) {
    assert.throws(
      () => statisticsSqlRow({ metadata_valid: 1, duration_ms: 1, total_runs } as RecordingStatisticsSqlRow),
      /count is invalid/,
    );
  }
});

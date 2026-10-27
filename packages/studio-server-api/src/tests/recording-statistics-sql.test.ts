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
    runKind: index % 31 === 0 ? 'editor' : index % 2 ? 'latest' : 'published',
    status: (['succeeded', 'failed', 'suspicious'] as const)[index % 3]!,
    durationMs: index * 13,
    cost:
      index % 3 === 0
        ? { status: 'complete' as const, knownCostUsd: index / 1000 }
        : index % 3 === 1
          ? { status: 'partial' as const, knownCostUsd: index / 2000 }
          : undefined,
    endpointNameAtExecution: index % 8 === 7 || identity?.surface === 'web_app_action' ? '/apps/renamed' : 'endpoint',
    executionIdentity: identity && {
      ...identity,
      ...(index < 120 && identity.surface === 'web_app_action'
        ? { uiGraphName: `UI ${index}`, componentType: 'button' as const, componentLabel: `Button ${index}` }
        : {}),
    },
  } satisfies WorkflowRecordingStatisticsRow & { recordingId: string };
});

test('SQLite statistics exclude editor runs even if their execution surface is missing or conflicting', () => {
  const db = sqliteFixture();
  try {
    const insert = db.prepare('INSERT INTO recordings VALUES (?, ?, ?)');
    for (const [index, identity, endpoint] of [
      [0, undefined, 'endpoint'],
      [1, { surface: 'workflow_endpoint' }, 'endpoint'],
      [2, { surface: 'web_app_action', uiGraphId: 'ui', componentId: 'button' }, '/app'],
      [3, undefined, '/app'],
    ] as const) {
      const recordingId = `editor-only-${index}`;
      insert.run(
        recordingId,
        'editor-only',
        JSON.stringify({
          recordingId,
          workflowId: 'editor-only',
          sourceProjectName: 'Editor',
          createdAt: '2026-08-04T12:00:00.000Z',
          runKind: 'editor',
          status: 'succeeded',
          durationMs: 1,
          endpointName: endpoint,
          executionIdentity: identity,
        }),
      );
    }
    for (const surface of ['endpoint', 'web_app'] as const) {
      const catalog = recordingStatisticsCatalogSql('sqlite', surface);
      const rows = db.prepare(catalog.sql).all(...catalog.values) as RecordingStatisticsSqlRow[];
      assert.equal(
        rows.some((row) => row.workflow_id === 'editor-only'),
        false,
      );
    }
    for (const target of [
      { surface: 'endpoint' as const, workflowId: 'editor-only' },
      { surface: 'web_app' as const, workflowId: 'editor-only', uiGraphId: 'ui', componentId: 'button' },
      { surface: 'web_app' as const, workflowId: 'editor-only', legacyEndpointName: '/app' },
    ]) {
      const statement = recordingStatisticsRowsSql('sqlite', {
        target,
        period: { from: '2026-08-04T00:00:00.000Z', to: '2026-08-05T00:00:00.000Z' },
        runKind: 'both',
        includeFailed: true,
        includeWarnings: true,
      });
      assert.equal(db.prepare(statement.sql).all(...statement.values).length, 0);
    }
  } finally {
    db.close();
  }
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
    { surface: 'endpoint', workflowId: 'workflow-b' },
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
        aggregation: 'day' as const,
        costAggregation: 'week' as const,
      };
      const sqlRows = await read(recordingStatisticsRowsSql(dialect, query));
      assert.deepEqual(
        buildWorkflowRunStatistics(sqlRows.map(statisticsSqlRow), query, { includeCost: true }),
        buildWorkflowRunStatistics(baseline, query, { includeCost: true }),
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

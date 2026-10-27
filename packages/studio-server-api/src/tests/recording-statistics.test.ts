import assert from 'node:assert/strict';
import test from 'node:test';
import { readWorkflowRunCost } from '../../../studio-server-shared/workflow-recording-types.js';

import {
  buildWorkflowRunStatistics,
  buildWorkflowRunStatisticsCatalog,
  getStatisticsQueryPeriod,
  type WorkflowRecordingStatisticsRow,
} from '../routes/workflows/recording-statistics.js';

test('stored cost metadata preserves real zero and rejects malformed estimates without inventing free usage', () => {
  for (const status of ['complete', 'partial'] as const) {
    assert.deepEqual(readWorkflowRunCost({ status, knownCostUsd: 0 }), { status, knownCostUsd: 0 });
    assert.deepEqual(readWorkflowRunCost(JSON.stringify({ status, knownCostUsd: 0.125 })), {
      status,
      knownCostUsd: 0.125,
    });
  }
  assert.deepEqual(readWorkflowRunCost('{"status":"unknown","knownCostUsd":null}'), {
    status: 'unknown',
    knownCostUsd: null,
  });
  for (const value of [
    undefined,
    null,
    'not-json',
    [],
    { status: 'complete', knownCostUsd: null },
    { status: 'complete', knownCostUsd: -1 },
    { status: 'complete', knownCostUsd: Infinity },
    { status: 'partial', knownCostUsd: '0' },
    { status: 'unknown', knownCostUsd: 0 },
  ]) {
    assert.equal(readWorkflowRunCost(value), undefined);
  }
});

function row(overrides: Partial<WorkflowRecordingStatisticsRow> = {}): WorkflowRecordingStatisticsRow {
  return {
    workflowId: 'workflow-a',
    sourceProjectName: 'Project A',
    createdAt: '2026-08-04T12:00:00.000Z',
    runKind: 'published',
    status: 'succeeded',
    durationMs: 100,
    endpointNameAtExecution: 'project-a',
    ...overrides,
  };
}

const period = getStatisticsQueryPeriod({
  from: '2026-08-04T00:00:00.000Z',
  to: '2026-08-05T00:00:00.000Z',
});

test('run statistics calculate selected-period metrics and time buckets from metadata rows', () => {
  const rows = [
    row({ createdAt: '2026-08-03T02:00:00.000Z', durationMs: 600 }),
    row({ createdAt: '2026-08-03T03:00:00.000Z', durationMs: 400 }),
    row({ createdAt: '2026-08-04T02:00:00.000Z', durationMs: 100 }),
    row({ createdAt: '2026-08-04T04:00:00.000Z', durationMs: 200 }),
    row({ createdAt: '2026-08-04T06:00:00.000Z', durationMs: 300 }),
    row({ createdAt: '2026-08-04T08:00:00.000Z', durationMs: 400 }),
    row({ createdAt: '2026-08-04T10:00:00.000Z', durationMs: 500 }),
  ];

  const statistics = buildWorkflowRunStatistics(rows, {
    target: { surface: 'endpoint', workflowId: 'workflow-a' },
    period,
    runKind: 'published',
    includeFailed: false,
    includeWarnings: false,
  });

  assert.deepEqual(statistics.current, {
    runCount: 5,
    medianDurationMs: 300,
    p95DurationMs: 480,
    averageDurationMs: 300,
    minDurationMs: 100,
    maxDurationMs: 500,
  });
  assert.deepEqual(Object.keys(statistics).sort(), [
    'buckets',
    'current',
    'currentExcludedStatusCounts',
    'currentStatusCounts',
    'period',
    'target',
  ]);
  assert.equal(statistics.buckets.length, 5);
  assert.equal(statistics.buckets[0]?.medianDurationMs, 100);
  assert.equal(statistics.buckets.at(-1)?.p95DurationMs, 500);
});

test('independent duration and cost grouping uses the same included population', () => {
  const rows = [3, 4, 5].map((day) =>
    row({
      createdAt: `2026-08-0${day}T12:00:00.000Z`,
      cost: { status: 'complete', knownCostUsd: 0.25 },
    }),
  );
  for (const [aggregation, costAggregation] of [['day', 'week'], ['week', 'day']] as const) {
    const query = {
      target: { surface: 'endpoint' as const, workflowId: 'workflow-a' },
      period: { from: '2026-08-03T00:00:00.000Z', to: '2026-08-10T00:00:00.000Z' },
      runKind: 'published' as const,
      includeFailed: false,
      includeWarnings: false,
      aggregation,
      costAggregation,
    };
    const statistics = buildWorkflowRunStatistics(rows, query, { includeCost: true });
    assert.equal(statistics.buckets.length, aggregation === 'day' ? 3 : 1);
    assert.equal(statistics.costBuckets?.length, costAggregation === 'day' ? 3 : 1);
    assert.equal(statistics.current.runCount, 3);
    assert.equal(statistics.cost?.runCount, 3);
    assert.equal(statistics.cost?.knownCostUsd, 0.75);
    assert.equal(statistics.cost?.averageCompleteCostUsd, 0.25);
  }
});

test('shared outcome filters govern duration, cost, coverage and cost buckets', () => {
  for (const includeFailed of [false, true]) {
    for (const includeWarnings of [false, true]) {
      const statistics = buildWorkflowRunStatistics(
        [
          row({ cost: { status: 'complete', knownCostUsd: 0 } }),
          row({ cost: { status: 'complete', knownCostUsd: 0.1 } }),
          row({ status: 'failed', cost: { status: 'partial', knownCostUsd: 0.2 } }),
          row({ status: 'failed', cost: { status: 'complete', knownCostUsd: 0.3 } }),
          row({ status: 'suspicious' }),
          row({ cost: { status: 'complete', knownCostUsd: Number.NaN } }),
        ],
        {
          target: { surface: 'endpoint', workflowId: 'workflow-a' },
          period,
          runKind: 'published',
          includeFailed,
          includeWarnings,
        },
        { includeCost: true },
      );
      const included = 3 + 2 * Number(includeFailed) + Number(includeWarnings);
      assert.equal(statistics.current.runCount, included);
      assert.deepEqual(statistics.cost, {
        runCount: included,
        completeCount: 2 + Number(includeFailed),
        partialCount: Number(includeFailed),
        unknownCount: 1 + Number(includeWarnings),
        knownCostUsd: includeFailed ? 0.1 + 0.2 + 0.3 : 0.1,
        averageCompleteCostUsd: includeFailed ? 0.4 / 3 : 0.05,
      });
      assert.equal(statistics.costBuckets?.length, 1);
      assert.equal(statistics.costBuckets?.[0]?.runCount, included);
      assert.equal(statistics.costBuckets?.[0]?.unknownCount, 1 + Number(includeWarnings));
      assert.equal(statistics.costBuckets?.[0]?.knownCostUsd, statistics.cost?.knownCostUsd);
      assert.deepEqual(statistics.currentStatusCounts, { succeeded: 3, failed: 2, suspicious: 1 });
    }
  }
});

test('historical and malformed cost evidence remains unknown, not free', () => {
  const statistics = buildWorkflowRunStatistics(
    [
      row(),
      row({ cost: { status: 'partial', knownCostUsd: -1 } }),
      row({ cost: { status: 'unknown', knownCostUsd: null } }),
      row({ cost: { status: 'complete', knownCostUsd: Infinity } }),
      row({ cost: { status: 'complete', knownCostUsd: null } as never }),
      row({ cost: { status: 'unknown', knownCostUsd: 0 } as never }),
    ],
    {
      target: { surface: 'endpoint', workflowId: 'workflow-a' },
      period,
      runKind: 'both',
      includeFailed: true,
      includeWarnings: true,
    },
    { includeCost: true },
  );
  assert.deepEqual(statistics.cost, {
    runCount: 6,
    completeCount: 0,
    partialCount: 0,
    unknownCount: 6,
    knownCostUsd: null,
    averageCompleteCostUsd: null,
  });
});

test('cost buckets use the selected target and version and never sum child recordings', () => {
  const statistics = buildWorkflowRunStatistics(
    [
      row({ createdAt: '2026-08-04T02:00:00.000Z', cost: { status: 'complete', knownCostUsd: 6 } }),
      row({
        createdAt: '2026-08-04T02:00:00.000Z',
        cost: { status: 'complete', knownCostUsd: 5 },
        executionIdentity: { surface: 'subgraph_project', correlationId: 'shared' },
      }),
      row({ createdAt: '2026-08-04T04:00:00.000Z', cost: { status: 'complete', knownCostUsd: 3 } }),
      row({ runKind: 'latest', cost: { status: 'complete', knownCostUsd: 50 } }),
      row({ workflowId: 'another-project', cost: { status: 'complete', knownCostUsd: 100 } }),
      row({
        executionIdentity: { surface: 'web_app_action', uiGraphId: 'ui', componentId: 'button' },
        cost: { status: 'complete', knownCostUsd: 200 },
      }),
      row({ runKind: 'editor', cost: { status: 'complete', knownCostUsd: 500 } }),
    ],
    {
      target: { surface: 'endpoint', workflowId: 'workflow-a' },
      period,
      runKind: 'published',
      includeFailed: false,
      includeWarnings: false,
    },
    { includeCost: true },
  );
  assert.equal(statistics.cost?.knownCostUsd, 9);
  assert.equal(statistics.current.runCount, 2);
  assert.equal(statistics.cost?.runCount, 2);
  assert.equal(statistics.cost?.completeCount, 2);
  assert.equal(statistics.cost?.partialCount, 0);
  assert.equal(statistics.cost?.unknownCount, 0);
  assert.equal(statistics.cost?.averageCompleteCostUsd, 4.5);
  assert.deepEqual(
    statistics.costBuckets?.map((bucket) => bucket.knownCostUsd),
    [6, 3],
  );
});

test('cost capability is independent of whether the selected period has evidence', () => {
  const query = {
    target: { surface: 'endpoint' as const, workflowId: 'workflow-a' },
    period,
    runKind: 'published' as const,
    includeFailed: false,
    includeWarnings: false,
  };
  const supported = buildWorkflowRunStatistics([row(), row()], query, { includeCost: true });
  assert.deepEqual(supported.cost, {
    runCount: 2,
    completeCount: 0,
    partialCount: 0,
    unknownCount: 2,
    knownCostUsd: null,
    averageCompleteCostUsd: null,
  });
  assert.equal(supported.costBuckets?.[0]?.unknownCount, 2);
  const empty = buildWorkflowRunStatistics([], query, { includeCost: true });
  assert.equal(empty.cost?.runCount, 0);
  assert.equal(empty.cost?.knownCostUsd, null);
  assert.deepEqual(empty.costBuckets, []);
  const unsupported = buildWorkflowRunStatistics([row({ cost: { status: 'complete', knownCostUsd: 1 } })], query);
  assert.equal(unsupported.cost, undefined);
  assert.equal(unsupported.costBuckets, undefined);
});

test('an overflowing sum does not turn an otherwise representable average into an invalid number', () => {
  const query = {
    target: { surface: 'endpoint' as const, workflowId: 'workflow-a' },
    period,
    runKind: 'published' as const,
    includeFailed: false,
    includeWarnings: false,
  };
  const cost = { status: 'complete' as const, knownCostUsd: Number.MAX_VALUE };
  const result = buildWorkflowRunStatistics([row({ cost }), row({ cost })], query, { includeCost: true });
  assert.equal(result.cost?.knownCostUsd, null);
  assert.equal(result.cost?.averageCompleteCostUsd, Number.MAX_VALUE);
});

test('run statistics exclude failed and warning runs by default without losing status counts', () => {
  const rows = [
    row({ durationMs: 100 }),
    row({ status: 'failed', durationMs: 1_000 }),
    row({ status: 'suspicious', durationMs: 2_000 }),
  ];

  const excluded = buildWorkflowRunStatistics(rows, {
    target: { surface: 'endpoint', workflowId: 'workflow-a' },
    period,
    runKind: 'published',
    includeFailed: false,
    includeWarnings: false,
  });
  assert.equal(excluded.current.runCount, 1);
  assert.deepEqual(excluded.currentStatusCounts, { succeeded: 1, failed: 1, suspicious: 1 });
  assert.deepEqual(excluded.currentExcludedStatusCounts, { succeeded: 0, failed: 1, suspicious: 1 });

  const included = buildWorkflowRunStatistics(rows, {
    target: { surface: 'endpoint', workflowId: 'workflow-a' },
    period,
    runKind: 'published',
    includeFailed: true,
    includeWarnings: true,
  });
  assert.equal(included.current.runCount, 3);
  assert.equal(included.current.medianDurationMs, 1_000);
});

test('run statistics clamp chart bucket bounds to a custom selected period', () => {
  const statistics = buildWorkflowRunStatistics([row({ createdAt: '2026-08-04T12:45:00.000Z', durationMs: 100 })], {
    target: { surface: 'endpoint', workflowId: 'workflow-a' },
    period: {
      from: '2026-08-04T12:30:00.000Z',
      to: '2026-08-04T13:15:00.000Z',
    },
    runKind: 'published',
    includeFailed: false,
    includeWarnings: false,
  });

  assert.deepEqual(statistics.buckets, [
    {
      from: '2026-08-04T12:30:00.000Z',
      to: '2026-08-04T13:00:00.000Z',
      runCount: 1,
      medianDurationMs: 100,
      p95DurationMs: 100,
      averageDurationMs: 100,
      minDurationMs: 100,
      maxDurationMs: 100,
    },
  ]);
});

test('run statistics can group chart buckets by UTC day or ISO week', () => {
  const groupingPeriod = {
    from: '2026-08-02T12:00:00.000Z',
    to: '2026-08-11T06:00:00.000Z',
  };
  const rows = [
    row({ createdAt: '2026-08-02T13:00:00.000Z', durationMs: 100 }),
    row({ createdAt: '2026-08-03T09:00:00.000Z', durationMs: 200 }),
    row({ createdAt: '2026-08-03T22:00:00.000Z', durationMs: 300 }),
    row({ createdAt: '2026-08-04T10:00:00.000Z', durationMs: 400 }),
    row({ createdAt: '2026-08-10T23:00:00.000Z', durationMs: 500 }),
  ];
  const query = {
    target: { surface: 'endpoint' as const, workflowId: 'workflow-a' },
    period: groupingPeriod,
    runKind: 'published' as const,
    includeFailed: false,
    includeWarnings: false,
  };

  const daily = buildWorkflowRunStatistics(rows, { ...query, aggregation: 'day' });
  assert.deepEqual(
    daily.buckets.map(({ from, to, runCount }) => ({ from, to, runCount })),
    [
      { from: '2026-08-02T12:00:00.000Z', to: '2026-08-03T00:00:00.000Z', runCount: 1 },
      { from: '2026-08-03T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z', runCount: 2 },
      { from: '2026-08-04T00:00:00.000Z', to: '2026-08-05T00:00:00.000Z', runCount: 1 },
      { from: '2026-08-10T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z', runCount: 1 },
    ],
  );

  const weekly = buildWorkflowRunStatistics(rows, { ...query, aggregation: 'week' });
  assert.deepEqual(
    weekly.buckets.map(({ from, to, runCount }) => ({ from, to, runCount })),
    [
      { from: '2026-08-02T12:00:00.000Z', to: '2026-08-03T00:00:00.000Z', runCount: 1 },
      { from: '2026-08-03T00:00:00.000Z', to: '2026-08-10T00:00:00.000Z', runCount: 3 },
      { from: '2026-08-10T00:00:00.000Z', to: '2026-08-11T06:00:00.000Z', runCount: 1 },
    ],
  );
});

test('statistics catalog keeps endpoints, known web-app actions, and incomplete legacy web-app actions distinct', () => {
  const rows = [
    row(),
    row({
      endpointNameAtExecution: '/apps/notes',
      executionIdentity: {
        surface: 'web_app_action',
        uiGraphId: 'ui-notes',
        uiGraphName: 'Notes',
        componentId: 'save',
        componentType: 'button',
        componentLabel: 'Save note',
      },
    }),
    row({ endpointNameAtExecution: '/apps/legacy' }),
    row({
      endpointNameAtExecution: '/apps/partial',
      executionIdentity: { surface: 'web_app_action', uiGraphId: 'ui-partial' },
    }),
  ];

  const endpointCatalog = buildWorkflowRunStatisticsCatalog(rows, 'endpoint');
  assert.equal(endpointCatalog.targets.length, 1);
  assert.deepEqual(endpointCatalog.targets[0]?.target, { surface: 'endpoint', workflowId: 'workflow-a' });

  const webAppCatalog = buildWorkflowRunStatisticsCatalog(rows, 'web_app');
  assert.equal(webAppCatalog.targets.length, 3);
  assert.deepEqual(
    webAppCatalog.targets.map((target) => target.target),
    [
      { surface: 'web_app', workflowId: 'workflow-a', legacyEndpointName: '/apps/legacy' },
      { surface: 'web_app', workflowId: 'workflow-a', legacyEndpointName: '/apps/partial' },
      { surface: 'web_app', workflowId: 'workflow-a', uiGraphId: 'ui-notes', componentId: 'save' },
    ],
  );
  assert.equal(webAppCatalog.targets[0]?.isLegacy, true);

  const partialStatistics = buildWorkflowRunStatistics(rows, {
    target: { surface: 'web_app', workflowId: 'workflow-a', legacyEndpointName: '/apps/partial' },
    period,
    runKind: 'published',
    includeFailed: false,
    includeWarnings: false,
  });
  assert.equal(partialStatistics.current.runCount, 1);
});

test('statistics catalog uses the newest labels and keeps colon-containing target IDs distinct', () => {
  const rows = [
    row({
      workflowId: 'workflow:a',
      sourceProjectName: 'Older project name',
      createdAt: '2026-08-04T01:00:00.000Z',
      endpointNameAtExecution: '/apps/old-name',
      executionIdentity: {
        surface: 'web_app_action',
        uiGraphId: 'ui:report',
        uiGraphName: 'Older web app name',
        componentId: 'button:generate',
        componentLabel: 'Older button label',
      },
    }),
    row({
      workflowId: 'workflow:a',
      sourceProjectName: 'Newest project name',
      createdAt: '2026-08-04T02:00:00.000Z',
      endpointNameAtExecution: '/apps/new-name',
      executionIdentity: {
        surface: 'web_app_action',
        uiGraphId: 'ui:report',
        uiGraphName: 'Newest web app name',
        componentId: 'button:generate',
        componentLabel: 'Newest button label',
      },
    }),
    row({
      workflowId: 'workflow',
      sourceProjectName: 'Separate project',
      createdAt: '2026-08-04T03:00:00.000Z',
      executionIdentity: {
        surface: 'web_app_action',
        uiGraphId: 'a:ui',
        componentId: 'report:button:generate',
      },
    }),
  ];

  const catalog = buildWorkflowRunStatisticsCatalog(rows, 'web_app');
  assert.equal(catalog.targets.length, 2);
  const renamedTarget = catalog.targets.find((entry) => entry.target.workflowId === 'workflow:a');
  assert.equal(renamedTarget?.projectName, 'Newest project name');
  assert.equal(renamedTarget?.uiGraphName, 'Newest web app name');
  assert.equal(renamedTarget?.componentLabel, 'Newest button label');
  assert.equal(renamedTarget?.endpointNameAtExecution, '/apps/new-name');
});

test('statistics catalog keeps retained targets when the selected query has no matching period or version', () => {
  const retainedRow = row({
    workflowId: 'workflow-history',
    sourceProjectName: 'Historical project',
    createdAt: '2026-08-01T12:00:00.000Z',
    runKind: 'latest',
  });

  const catalog = buildWorkflowRunStatisticsCatalog([retainedRow], 'endpoint');
  assert.deepEqual(
    catalog.targets.map((entry) => entry.target),
    [{ surface: 'endpoint', workflowId: 'workflow-history' }],
  );

  const statistics = buildWorkflowRunStatistics([retainedRow], {
    target: { surface: 'endpoint', workflowId: 'workflow-history' },
    period,
    runKind: 'published',
    includeFailed: false,
    includeWarnings: false,
  });
  assert.deepEqual(statistics.currentStatusCounts, { succeeded: 0, failed: 0, suspicious: 0 });
  assert.equal(statistics.current.runCount, 0);
});

test('statistics target and run-kind matching never mix endpoint and web-app action rows', () => {
  const rows = [
    row({ runKind: 'latest', durationMs: 500 }),
    row({
      durationMs: 800,
      executionIdentity: {
        surface: 'web_app_action',
        uiGraphId: 'ui-a',
        componentId: 'send',
      },
    }),
  ];

  const endpointStatistics = buildWorkflowRunStatistics(rows, {
    target: { surface: 'endpoint', workflowId: 'workflow-a' },
    period,
    runKind: 'published',
    includeFailed: false,
    includeWarnings: false,
  });
  assert.equal(endpointStatistics.current.runCount, 0);

  const webAppStatistics = buildWorkflowRunStatistics(rows, {
    target: { surface: 'web_app', workflowId: 'workflow-a', uiGraphId: 'ui-a', componentId: 'send' },
    period,
    runKind: 'published',
    includeFailed: false,
    includeWarnings: false,
  });
  assert.equal(webAppStatistics.current.runCount, 1);
  assert.equal(webAppStatistics.current.medianDurationMs, 800);
});

test('statistics catalog excludes local editor and called-project replays', () => {
  const catalog = buildWorkflowRunStatisticsCatalog(
    [
      row(),
      row({
        sourceProjectName: 'Local diagnostic replay',
        runKind: 'editor',
        executionIdentity: { surface: 'editor_local' },
      }),
      row({
        sourceProjectName: 'Called project replay',
        executionIdentity: { surface: 'subgraph_project', graphId: 'child' },
      }),
    ],
    'endpoint',
  );

  assert.equal(catalog.targets.length, 1);
  assert.deepEqual(catalog.targets[0]?.target, { surface: 'endpoint', workflowId: 'workflow-a' });
  assert.equal(catalog.targets[0]?.projectName, 'Project A');
  assert.equal(catalog.targets[0]?.totalRuns, 1);
});

test('editor runs never become production statistics, even with missing or conflicting surface metadata', () => {
  const editorRows = [
    row({ runKind: 'editor' }),
    row({ runKind: 'editor', executionIdentity: { surface: 'workflow_endpoint' } }),
    row({
      runKind: 'editor',
      executionIdentity: { surface: 'web_app_action', uiGraphId: 'ui-a', componentId: 'send' },
    }),
    row({ runKind: 'editor', endpointNameAtExecution: '/apps/legacy' }),
  ];
  for (const surface of ['endpoint', 'web_app'] as const) {
    assert.deepEqual(buildWorkflowRunStatisticsCatalog(editorRows, surface).targets, []);
  }
  for (const target of [
    { surface: 'endpoint' as const, workflowId: 'workflow-a' },
    { surface: 'web_app' as const, workflowId: 'workflow-a', uiGraphId: 'ui-a', componentId: 'send' },
    { surface: 'web_app' as const, workflowId: 'workflow-a', legacyEndpointName: '/apps/legacy' },
  ]) {
    const statistics = buildWorkflowRunStatistics(
      editorRows,
      {
        target,
        period,
        runKind: 'both',
        includeFailed: true,
        includeWarnings: true,
      },
      { includeCost: true },
    );
    assert.equal(statistics.current.runCount, 0);
    assert.equal(statistics.cost?.runCount, 0);
  }
});

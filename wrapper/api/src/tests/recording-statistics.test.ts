import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWorkflowRunStatistics,
  buildWorkflowRunStatisticsCatalog,
  getStatisticsQueryPeriod,
  type WorkflowRecordingStatisticsRow,
} from '../routes/workflows/recording-statistics.js';

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
  const statistics = buildWorkflowRunStatistics([
    row({ createdAt: '2026-08-04T12:45:00.000Z', durationMs: 100 }),
  ], {
    target: { surface: 'endpoint', workflowId: 'workflow-a' },
    period: {
      from: '2026-08-04T12:30:00.000Z',
      to: '2026-08-04T13:15:00.000Z',
    },
    runKind: 'published',
    includeFailed: false,
    includeWarnings: false,
  });

  assert.deepEqual(statistics.buckets, [{
    from: '2026-08-04T12:30:00.000Z',
    to: '2026-08-04T13:00:00.000Z',
    runCount: 1,
    medianDurationMs: 100,
    p95DurationMs: 100,
    averageDurationMs: 100,
    minDurationMs: 100,
    maxDurationMs: 100,
  }]);
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

  const endpointCatalog = buildWorkflowRunStatisticsCatalog(rows, 'endpoint', period);
  assert.equal(endpointCatalog.targets.length, 1);
  assert.deepEqual(endpointCatalog.targets[0]?.target, { surface: 'endpoint', workflowId: 'workflow-a' });

  const webAppCatalog = buildWorkflowRunStatisticsCatalog(rows, 'web_app', period);
  assert.equal(webAppCatalog.targets.length, 3);
  assert.deepEqual(webAppCatalog.targets.map((target) => target.target), [
    { surface: 'web_app', workflowId: 'workflow-a', legacyEndpointName: '/apps/legacy' },
    { surface: 'web_app', workflowId: 'workflow-a', legacyEndpointName: '/apps/partial' },
    { surface: 'web_app', workflowId: 'workflow-a', uiGraphId: 'ui-notes', componentId: 'save' },
  ]);
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

  const catalog = buildWorkflowRunStatisticsCatalog(rows, 'web_app', period);
  assert.equal(catalog.targets.length, 2);
  const renamedTarget = catalog.targets.find((entry) => entry.target.workflowId === 'workflow:a');
  assert.equal(renamedTarget?.projectName, 'Newest project name');
  assert.equal(renamedTarget?.uiGraphName, 'Newest web app name');
  assert.equal(renamedTarget?.componentLabel, 'Newest button label');
  assert.equal(renamedTarget?.endpointNameAtExecution, '/apps/new-name');
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

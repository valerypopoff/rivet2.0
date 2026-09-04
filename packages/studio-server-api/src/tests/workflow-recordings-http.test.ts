import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { writeWorkflowProjectStatsCacheFromContents } from '../routes/workflows/project-stats.js';
import {
  readJson,
  waitForRecordingWorkflows,
  waitForWorkflowRecordingRunCount,
} from './helpers/workflow-api-harness.js';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';

const {
  workflowsRoot,
  workflowMutations,
  workflowFs,
  workflowRecordings,
  workflowStorageBackend,
  workflowExecution,
  rivetNode,
  withWorkflowExecutionServer,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();
const { writeRunRecordingsSettings } = await import('../routes/workflows/recordings-config.js');

test.beforeEach(resetAndEnsureWorkflowsRoot);
test.after(cleanupWorkflowSuite);

test('published and latest workflow execution create replayable recordings that are listed over HTTP', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Recorded');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'recorded-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl, latestBaseUrl }) => {
    const publishedResponse = await fetch(`${publishedBaseUrl}/recorded-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'published' }),
    });
    assert.equal(publishedResponse.ok, true);

    const publishedCorrelationId = publishedResponse.headers.get('x-rivet-correlation-id');
    assert.match(publishedCorrelationId ?? '', /^rvt-[a-f0-9-]{36}$/);
    const latestResponse = await fetch(`${latestBaseUrl}/recorded-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'latest' }),
    });
    assert.equal(latestResponse.ok, true);

    const latestCorrelationId = latestResponse.headers.get('x-rivet-correlation-id');
    assert.match(latestCorrelationId ?? '', /^rvt-[a-f0-9-]{36}$/);
    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === 2,
    ) as {
      workflows: Array<{
        workflowId: string;
        project: { absolutePath: string; settings: { endpointName: string } };
        totalRuns: number;
      }>;
    };

    assert.equal(workflowsResponse.workflows.length, 1);
    assert.equal(workflowsResponse.workflows[0]?.project.absolutePath, created.absolutePath);
    assert.equal(workflowsResponse.workflows[0]?.project.settings.endpointName, 'recorded-endpoint');
    assert.equal(workflowsResponse.workflows[0]?.totalRuns, 2);

    const workflowId = workflowsResponse.workflows[0]!.workflowId;
    const runsResponse = await readJson<{
      totalRuns: number;
      runs: Array<{
        id: string;
        runKind: string;
        status: string;
        executionIdentity?: { correlationId?: string };
      }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=20&status=all`));

    assert.equal(runsResponse.totalRuns, 2);
    assert.equal(runsResponse.runs.length, 2);
    assert.deepEqual(
      runsResponse.runs.map((recording) => recording.runKind).sort(),
      ['latest', 'published'],
    );
    assert.deepEqual(
      runsResponse.runs.map((recording) => recording.status),
      ['succeeded', 'succeeded'],
    );

    const sourceProject = await rivetNode.loadProjectFromFile(created.absolutePath);
    const recordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowFs.getWorkflowRecordingsRoot(workflowsRoot), sourceProject.metadata.id);

    assert.deepEqual(
      runsResponse.runs.map((recording) => recording.executionIdentity?.correlationId).sort(),
      [latestCorrelationId, publishedCorrelationId].sort(),
    );
    for (const recording of runsResponse.runs) {
      const bundlePath = path.join(recordingsRoot, recording.id);
      const recordingPath = workflowFs.getWorkflowRecordingPath(bundlePath);
      const replayProjectPath = workflowFs.getWorkflowRecordingReplayProjectPath(bundlePath);

      assert.equal(await workflowFs.pathExists(recordingPath), true);
      assert.equal(await workflowFs.pathExists(replayProjectPath), true);

      const replayProject = rivetNode.loadProjectFromString(
        await workflowRecordings.readWorkflowRecordingArtifact(workflowsRoot, recording.id, 'replay-project'),
      );
      const serializedRecording = await workflowRecordings.readWorkflowRecordingArtifact(workflowsRoot, recording.id, 'recording');
      const recorder = rivetNode.ExecutionRecorder.deserializeFromString(serializedRecording);

      assert.notEqual(replayProject.metadata.id, sourceProject.metadata.id);
      assert.deepEqual(Object.keys(replayProject.graphs), Object.keys(sourceProject.graphs));
      assert.ok(recorder.events.length > 0);
    }
  });
});

test('recordings list keeps once-published workflows after unpublish', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'RecordedHistory');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'recorded-history-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    const publishedResponse = await fetch(`${publishedBaseUrl}/recorded-history-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'published' }),
    });
    assert.equal(publishedResponse.ok, true);

    await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);

    const workflowsResponse = await readJson<{
      workflows: Array<{
        workflowId: string;
        project: { absolutePath: string; settings: { status: string; endpointName: string } };
        totalRuns: number;
      }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows`));

    assert.equal(workflowsResponse.workflows.length, 1);
    assert.equal(workflowsResponse.workflows[0]?.project.absolutePath, created.absolutePath);
    assert.equal(workflowsResponse.workflows[0]?.project.settings.status, 'unpublished');
    assert.equal(workflowsResponse.workflows[0]?.project.settings.endpointName, 'recorded-history-endpoint');
    assert.equal(workflowsResponse.workflows[0]?.totalRuns, 1);

    const runsResponse = await readJson<{
      runs: Array<{ runKind: string; status: string }>;
    }>(await fetch(
      `${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowsResponse.workflows[0]!.workflowId)}/runs?page=1&pageSize=20&status=all`,
    ));

    assert.equal(runsResponse.runs.length, 1);
    assert.equal(runsResponse.runs[0]?.runKind, 'published');
    assert.equal(runsResponse.runs[0]?.status, 'succeeded');
  });
});

test('workflow recording runs endpoint paginates and filters failed runs server-side', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Paged');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'paged-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    for (let index = 0; index < 3; index++) {
      const response = await fetch(`${publishedBaseUrl}/paged-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: index }),
      });
      assert.equal(response.ok, true);
    }

    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === 3,
    ) as {
      workflows: Array<{ workflowId: string }>;
    };
    const workflowId = workflowsResponse.workflows[0]!.workflowId;

    const pageOne = await readJson<{
      page: number;
      pageSize: number;
      totalRuns: number;
      runs: Array<{ id: string }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=2&status=all`));

    assert.equal(pageOne.page, 1);
    assert.equal(pageOne.pageSize, 2);
    assert.equal(pageOne.totalRuns, 3);
    assert.equal(pageOne.runs.length, 2);

    const failedOnly = await readJson<{
      totalRuns: number;
      runs: Array<{ status: string }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=20&status=failed`));

    assert.equal(failedOnly.totalRuns, 0);
    assert.equal(failedOnly.runs.length, 0);
  });
});

test('workflow recording classification marks control-flow-excluded outputs as suspicious', () => {
  assert.equal(
    workflowExecution.getWorkflowRecordingStatusFromOutputs({
      output: { type: 'control-flow-excluded', value: undefined },
    }),
    'suspicious',
  );
  assert.equal(
    workflowExecution.getWorkflowRecordingStatusFromOutputs({
      output: { type: 'string', value: 'ok' },
    }),
    'succeeded',
  );
});

test('workflow recording failed filter includes suspicious runs', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Suspicious');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  const workflowId = loadedProject.metadata.id!;

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'suspicious-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'suspicious-recording',
        events: [],
        startTs: 1,
        finishTs: 1,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'published',
    status: 'suspicious',
    durationMs: 1,
  });

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'suspicious-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'successful-recording',
        events: [],
        startTs: 2,
        finishTs: 2,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 2,
  });

  const failedOnly = await workflowRecordings.listWorkflowRecordingRunsPage(
    workflowsRoot,
    workflowId,
    1,
    20,
    'failed',
  );
  const workflowsResponse = await workflowRecordings.listWorkflowRecordingWorkflows(workflowsRoot);

  assert.equal(failedOnly.totalRuns, 1);
  assert.deepEqual(
    failedOnly.runs.map((run) => run.status),
    ['suspicious'],
  );
  assert.match(
    await workflowRecordings.readWorkflowRecordingArtifact(workflowsRoot, failedOnly.runs[0]!.id, 'recording'),
    /suspicious-recording/,
  );

  const allRuns = await workflowRecordings.listWorkflowRecordingRunsPage(
    workflowsRoot,
    workflowId,
    1,
    20,
    'all',
  );
  const succeededRun = allRuns.runs.find((run) => run.status === 'succeeded');
  assert.ok(succeededRun);
  assert.match(
    await workflowRecordings.readWorkflowRecordingArtifact(workflowsRoot, succeededRun.id, 'recording'),
    /successful-recording/,
  );
  assert.equal(workflowsResponse.workflows[0]?.failedRuns, 0);
  assert.equal(workflowsResponse.workflows[0]?.suspiciousRuns, 1);
});

test('workflow recording input filter evaluates JSON paths against the request input root', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Input Filtered');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  const workflowId = loadedProject.metadata.id!;

  const persistRecording = (recordingId: string, input: unknown, durationMs: number) =>
    workflowRecordings.persistWorkflowExecutionRecording({
      workflowsRoot,
      sourceProject: loadedProject,
      sourceProjectPath: created.absolutePath,
      executedProject: loadedProject,
      executedAttachedData: attachedData,
      executedDatasets: [],
      endpointName: 'input-filtered',
      recordingSerialized: JSON.stringify({
        version: 1,
        recording: {
          recordingId,
          events: [
            {
              type: 'start',
              data: {
                inputs: {
                  input: {
                    type: 'any',
                    value: input,
                  },
                },
              },
              ts: durationMs,
            },
          ],
          startTs: durationMs,
          finishTs: durationMs,
        },
        assets: {},
        strings: {},
      }),
      runKind: 'published',
      status: 'succeeded',
      durationMs,
    });

  await persistRecording('input-filter-bar', { foo: 'bar', score: 5 }, 1);
  await persistRecording('input-filter-baz', { foo: 'baz', score: 12 }, 2);

  const equalsBar = await workflowRecordings.listWorkflowRecordingRunsPage(
    workflowsRoot,
    workflowId,
    1,
    20,
    'all',
    { path: '$.foo', operator: '==', value: 'bar' },
  );

  assert.equal(equalsBar.totalRuns, 1);
  assert.match(
    await workflowRecordings.readWorkflowRecordingArtifact(workflowsRoot, equalsBar.runs[0]!.id, 'recording'),
    /input-filter-bar/,
  );

  const greaterThanTen = await workflowRecordings.listWorkflowRecordingRunsPage(
    workflowsRoot,
    workflowId,
    1,
    20,
    'all',
    { path: '$.score', operator: '>', value: '10' },
  );

  assert.equal(greaterThanTen.totalRuns, 1);
  assert.match(
    await workflowRecordings.readWorkflowRecordingArtifact(workflowsRoot, greaterThanTen.runs[0]!.id, 'recording'),
    /input-filter-baz/,
  );

  const rootContainsSingleQuotedText = await workflowRecordings.listWorkflowRecordingRunsPage(
    workflowsRoot,
    workflowId,
    1,
    20,
    'all',
    { path: '$', operator: 'contains', value: "'bar'" },
  );

  assert.equal(rootContainsSingleQuotedText.totalRuns, 1);
  assert.match(
    await workflowRecordings.readWorkflowRecordingArtifact(
      workflowsRoot,
      rootContainsSingleQuotedText.runs[0]!.id,
      'recording',
    ),
    /input-filter-bar/,
  );
});

test('filesystem recording statistics use indexed identities for endpoint and web-app targets', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Statistics');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  const workflowId = loadedProject.metadata.id!;
  const recordingSerialized = (recordingId: string) => JSON.stringify({
    version: 1,
    recording: { recordingId, events: [], startTs: 1, finishTs: 1 },
    assets: {},
    strings: {},
  });

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'statistics-endpoint',
    recordingSerialized: recordingSerialized('statistics-endpoint'),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 125,
    executionIdentity: {
      surface: 'workflow_endpoint',
      graphId: 'main',
      graphName: 'Main',
    },
  });
  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: '/apps/statistics',
    recordingSerialized: recordingSerialized('statistics-web-app'),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 250,
    executionIdentity: {
      surface: 'web_app_action',
      uiGraphId: 'ui-statistics',
      uiGraphName: 'Statistics app',
      componentId: 'run-button',
      componentType: 'button',
      componentLabel: 'Run report',
    },
  });
  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: '/apps/statistics-partial',
    recordingSerialized: recordingSerialized('statistics-web-app-partial'),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 175,
    executionIdentity: {
      surface: 'web_app_action',
      uiGraphId: 'ui-statistics',
    },
  });

  const now = new Date();
  const period = {
    from: new Date(now.getTime() - 60_000).toISOString(),
    to: new Date(now.getTime() + 60_000).toISOString(),
  };
  const endpointCatalog = await workflowRecordings.listWorkflowRunStatisticsCatalog(
    workflowsRoot,
    'endpoint',
  );
  const webAppCatalog = await workflowRecordings.listWorkflowRunStatisticsCatalog(
    workflowsRoot,
    'web_app',
  );

  assert.deepEqual(endpointCatalog.targets.map((target) => target.target), [
    { surface: 'endpoint', workflowId },
  ]);
  assert.deepEqual(webAppCatalog.targets.map((target) => target.target), [
    { surface: 'web_app', workflowId, legacyEndpointName: '/apps/statistics-partial' },
    { surface: 'web_app', workflowId, uiGraphId: 'ui-statistics', componentId: 'run-button' },
  ]);

  const stableWebAppTarget = webAppCatalog.targets.find((entry) => 'uiGraphId' in entry.target);
  const partialWebAppTarget = webAppCatalog.targets.find((entry) => 'legacyEndpointName' in entry.target);
  assert.ok(stableWebAppTarget);
  assert.ok(partialWebAppTarget);

  const webAppStatistics = await workflowRecordings.getWorkflowRunStatistics(workflowsRoot, {
    target: stableWebAppTarget.target,
    period,
    runKind: 'published',
    includeFailed: false,
    includeWarnings: false,
  });
  assert.equal(webAppStatistics.current.runCount, 1);
  assert.equal(webAppStatistics.current.medianDurationMs, 250);

  const partialWebAppStatistics = await workflowRecordings.getWorkflowRunStatistics(workflowsRoot, {
    target: partialWebAppTarget.target,
    period,
    runKind: 'published',
    includeFailed: false,
    includeWarnings: false,
  });
  assert.equal(partialWebAppStatistics.current.runCount, 1);
  assert.equal(partialWebAppStatistics.current.medianDurationMs, 175);

  await withWorkflowExecutionServer(async ({ apiBaseUrl }) => {
    const targetsResponse = await fetch(
      `${apiBaseUrl}/run-statistics/targets?${new URLSearchParams({ surface: 'web_app' })}`,
    );
    assert.equal(targetsResponse.ok, true);
    const targets = await readJson<{
      targets: Array<{
        target: {
          surface: string;
          workflowId: string;
          uiGraphId?: string;
          componentId?: string;
          legacyEndpointName?: string;
        };
      }>;
    }>(targetsResponse);
    assert.deepEqual(targets.targets.map((entry) => entry.target), [
      { surface: 'web_app', workflowId, legacyEndpointName: '/apps/statistics-partial' },
      { surface: 'web_app', workflowId, uiGraphId: 'ui-statistics', componentId: 'run-button' },
    ]);

    const stableTarget = targets.targets.find((entry) => entry.target.uiGraphId)?.target;
    assert.ok(stableTarget);

    const statisticsResponse = await fetch(`${apiBaseUrl}/run-statistics/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: stableTarget,
        period,
        runKind: 'published',
        includeFailed: false,
        includeWarnings: false,
        aggregation: 'week',
      }),
    });
    assert.equal(statisticsResponse.ok, true);
    const statistics = await readJson<{ current: { runCount: number; medianDurationMs: number | null } }>(statisticsResponse);
    assert.equal(statistics.current.runCount, 1);
    assert.equal(statistics.current.medianDurationMs, 250);

    const invalidAggregationResponse = await fetch(`${apiBaseUrl}/run-statistics/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: stableTarget,
        period,
        runKind: 'published',
        includeFailed: false,
        includeWarnings: false,
        aggregation: 'month',
      }),
    });
    assert.equal(invalidAggregationResponse.status, 400);
  });
});

test('workflow recording delete route removes a single recording and updates totals', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DeleteOneRecording');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'delete-one-recording-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    for (let index = 0; index < 2; index++) {
      const response = await fetch(`${publishedBaseUrl}/delete-one-recording-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: index }),
      });
      assert.equal(response.ok, true);
    }

    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === 2,
    ) as {
      workflows: Array<{ workflowId: string; totalRuns: number }>;
    };
    const workflowId = workflowsResponse.workflows[0]!.workflowId;

    const runsResponse = await readJson<{
      totalRuns: number;
      runs: Array<{ id: string }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=20&status=all`));

    assert.equal(runsResponse.totalRuns, 2);
    assert.equal(runsResponse.runs.length, 2);
    const deletedRecordingId = runsResponse.runs[0]!.id;
    const recordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowFs.getWorkflowRecordingsRoot(workflowsRoot), workflowId);
    const deletedBundlePath = path.join(recordingsRoot, deletedRecordingId);
    assert.equal(await workflowFs.pathExists(deletedBundlePath), true);

    const deleteResponse = await fetch(
      `${apiBaseUrl}/recordings/${encodeURIComponent(deletedRecordingId)}`,
      { method: 'DELETE' },
    );

    assert.equal(deleteResponse.ok, true);

    const updatedWorkflows = await readJson<{
      workflows: Array<{ workflowId: string; totalRuns: number }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows`));
    const updatedRuns = await readJson<{
      totalRuns: number;
      runs: Array<{ id: string }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=20&status=all`));

    assert.equal(updatedWorkflows.workflows[0]?.totalRuns, 1);
    assert.equal(updatedRuns.totalRuns, 1);
    assert.equal(updatedRuns.runs.length, 1);
    assert.notEqual(updatedRuns.runs[0]?.id, deletedRecordingId);
    assert.equal(await workflowFs.pathExists(deletedBundlePath), false);

    const deletedArtifactResponse = await fetch(
      `${apiBaseUrl}/recordings/${encodeURIComponent(deletedRecordingId)}/recording`,
    );
    assert.equal(deletedArtifactResponse.status, 404);
  });
});

test('workflow recording delete route removes the last unpublished recording from disk and index', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DeleteLastRecording');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'delete-last-recording-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    const response = await fetch(`${publishedBaseUrl}/delete-last-recording-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'only-run' }),
    });
    assert.equal(response.ok, true);

    await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);

    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === 1,
    ) as {
      workflows: Array<{ workflowId: string; totalRuns: number }>;
    };
    const workflowId = workflowsResponse.workflows[0]!.workflowId;

    const runsResponse = await readJson<{
      totalRuns: number;
      runs: Array<{ id: string }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=20&status=all`));

    assert.equal(runsResponse.totalRuns, 1);
    const deletedRecordingId = runsResponse.runs[0]!.id;
    const workflowRecordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowFs.getWorkflowRecordingsRoot(workflowsRoot), workflowId);
    const deletedBundlePath = path.join(workflowRecordingsRoot, deletedRecordingId);

    assert.equal(await workflowFs.pathExists(deletedBundlePath), true);
    assert.equal(await workflowFs.pathExists(workflowRecordingsRoot), true);

    const deleteResponse = await fetch(
      `${apiBaseUrl}/recordings/${encodeURIComponent(deletedRecordingId)}`,
      { method: 'DELETE' },
    );
    assert.equal(deleteResponse.ok, true);

    const updatedWorkflows = await readJson<{
      workflows: Array<{ workflowId: string; totalRuns: number }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows`));

    assert.equal(updatedWorkflows.workflows.length, 0);
    assert.equal(await workflowFs.pathExists(deletedBundlePath), false);
    assert.equal(await workflowFs.pathExists(workflowRecordingsRoot), false);

    const deletedRecordingArtifactResponse = await fetch(
      `${apiBaseUrl}/recordings/${encodeURIComponent(deletedRecordingId)}/recording`,
    );
    const deletedProjectArtifactResponse = await fetch(
      `${apiBaseUrl}/recordings/${encodeURIComponent(deletedRecordingId)}/replay-project`,
    );

    assert.equal(deletedRecordingArtifactResponse.status, 404);
    assert.equal(deletedProjectArtifactResponse.status, 404);
  });
});

test('workflow recording persistence snapshots the executed in-memory project state', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Stable');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  const mutatedContents = (await fs.readFile(created.absolutePath, 'utf8')).replace('Stable', 'Mutated');

  await fs.writeFile(created.absolutePath, mutatedContents, 'utf8');

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'stable-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'recording-id',
        events: [],
        startTs: 0,
        finishTs: 0,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'latest',
    status: 'succeeded',
    durationMs: 1,
  });

  const recordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowFs.getWorkflowRecordingsRoot(workflowsRoot), loadedProject.metadata.id);
  const bundles = await fs.readdir(recordingsRoot);
  assert.equal(bundles.length, 1);

  const replayProject = rivetNode.loadProjectFromString(
    await workflowRecordings.readWorkflowRecordingArtifact(workflowsRoot, bundles[0]!, 'replay-project'),
  );
  const mutatedProject = await rivetNode.loadProjectFromFile(created.absolutePath);

  assert.equal(replayProject.metadata.title, 'Stable');
  assert.equal(mutatedProject.metadata.title, 'Mutated');
});

test('workflow recording cleanup keeps only the newest configured runs per endpoint', async () => {
  await writeRunRecordingsSettings({
    maxPendingWrites: 100,
    maxRunsPerEndpoint: 2,
    retentionDays: 14,
  });

  const created = await workflowMutations.createWorkflowProjectItem('', 'EndpointLimited');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  const workflowId = loadedProject.metadata.id!;

  for (const index of [1, 2, 3]) {
    await workflowRecordings.persistWorkflowExecutionRecording({
      workflowsRoot,
      sourceProject: loadedProject,
      sourceProjectPath: created.absolutePath,
      executedProject: loadedProject,
      executedAttachedData: attachedData,
      executedDatasets: [],
      endpointName: 'endpoint-limited',
      recordingSerialized: JSON.stringify({
        version: 1,
        recording: {
          recordingId: `recording-${index}`,
          events: [],
          startTs: index,
          finishTs: index,
        },
        assets: {},
        strings: {},
      }),
      runKind: 'published',
      status: 'succeeded',
      durationMs: index,
    });
  }

  const runsPage = await waitForWorkflowRecordingRunCount(
    workflowRecordings.listWorkflowRecordingRunsPage,
    workflowsRoot,
    workflowId,
    2,
  );

  assert.equal(runsPage.runs.length, 2);
  assert.deepEqual(
    runsPage.runs.map((run) => run.durationMs),
    [3, 2],
  );

  const recordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowFs.getWorkflowRecordingsRoot(workflowsRoot), workflowId);
  const bundles = (await fs.readdir(recordingsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.equal(bundles.length, 2);
});

test('local editor replay persistence links health evidence after a project rename', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'LocalHealthEvidence');
  const [project, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  const projectId = project.metadata.id!;
  const correlationId = 'rvt-local-0f01eb95-2b7d-4fb4-8c77-9b50e3e4ce5c';
  const healthStore = await workflowStorageBackend.getLLMProfileHealthStore();
  const identity = {
    key: 'local-editor-health-evidence',
    projectId,
    profileNodeId: 'profile-node' as never,
    profileName: 'Local evidence profile',
    provider: 'openai' as never,
    model: 'local-model',
    customProviderApi: 'completions' as const,
    configurationFingerprint: 'sha256:local-editor-evidence',
  };
  const policy = {
    failureThreshold: 1,
    failureWindowMs: 60_000,
    openDurationMs: 60_000,
    halfOpenLeaseMs: 10_000,
  };
  const attempt = await healthStore.begin({ identity, policy });
  await healthStore.finish({
    identity,
    policy,
    permitId: attempt.permitId!,
    outcome: 'unhealthy',
    executionCorrelationId: correlationId,
  });

  const staleProjectPath = created.absolutePath;
  const renamed = await workflowMutations.renameWorkflowProjectItem(created.relativePath, 'LocalHealthEvidenceRenamed');
  assert.notEqual(renamed.project.absolutePath, staleProjectPath);

  await withWorkflowExecutionServer(async ({ apiBaseUrl }) => {
    const capability = await readJson<{ supported: boolean }>(
      await fetch(`${apiBaseUrl}/local-editor-recordings/capability`),
    );
    assert.equal(capability.supported, true);

    const persistResponse = await fetch(`${apiBaseUrl}/local-editor-recordings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        projectPath: staleProjectPath,
        projectContents: rivetNode.serializeProject(project, attachedData),
        recordingSerialized: JSON.stringify({
          version: 1,
          recording: {
            recordingId: 'local-health-evidence-recording',
            events: [],
            startTs: 1,
            finishTs: 2,
          },
          assets: {},
          strings: {},
        }),
        status: 'failed',
        durationMs: 12,
        errorMessage: 'Provider request failed.',
        executionIdentity: {
          correlationId,
          graphId: project.metadata.mainGraphId,
        },
      }),
    });
    const persisted = await readJson<{ availability: string; recordingId?: string }>(persistResponse);
    assert.equal(persisted.availability, 'available');
    assert.ok(persisted.recordingId);

    const [health] = await healthStore.listAdmin({ projectId });
    assert.equal(health?.contributingRuns[0]?.availability, 'available');
    assert.equal(health?.contributingRuns[0]?.recordingId, persisted.recordingId);

    const runs = await readJson<{ runs: Array<{ id: string; runKind: string; status: string }> }>(
      await fetch(
        `${apiBaseUrl}/recordings/workflows/${encodeURIComponent(projectId)}/runs?page=1&pageSize=20&status=all`,
      ),
    );
    assert.deepEqual(
      runs.runs.map((run) => [run.id, run.runKind, run.status]),
      [[persisted.recordingId, 'editor', 'failed']],
    );
  });
});

test('local editor replay persistence resolves a nested relative path when the tree index has no metadata id', async () => {
  await workflowMutations.createWorkflowFolderItem('Nested', '');
  const created = await workflowMutations.createWorkflowProjectItem('Nested', 'LocalRelativeReplay');
  const [project, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  const projectId = project.metadata.id!;
  const sidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);
  const projectContents = rivetNode.serializeProject(project, attachedData);
  if (typeof projectContents !== 'string') {
    throw new Error('Expected the test project to serialize to text.');
  }

  // Start with a current, fingerprint-valid generated sidecar, then remove
  // only its metadata ID. The source remains valid, but the tree must select
  // it through the normalized relative path instead of the ID lookup.
  await writeWorkflowProjectStatsCacheFromContents(created.absolutePath, projectContents);
  const generatedCache = JSON.parse(await fs.readFile(sidecars.stats, 'utf8')) as Record<string, unknown>;
  await fs.writeFile(sidecars.stats, `${JSON.stringify({ ...generatedCache, projectMetadataId: null })}\n`, 'utf8');

  await withWorkflowExecutionServer(async ({ apiBaseUrl }) => {
    const persistResponse = await fetch(`${apiBaseUrl}/local-editor-recordings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        projectPath: `./${created.relativePath.replace(/\//g, '\\')}`,
        projectContents,
        recordingSerialized: JSON.stringify({
          version: 1,
          recording: {
            recordingId: 'local-relative-replay-recording',
            events: [],
            startTs: 1,
            finishTs: 2,
          },
          assets: {},
          strings: {},
        }),
        status: 'failed',
        durationMs: 12,
        errorMessage: 'Provider request failed.',
        executionIdentity: {
          correlationId: 'rvt-local-41b71494-3788-45e9-99b7-20212546da21',
          graphId: project.metadata.mainGraphId,
        },
      }),
    });

    assert.equal(persistResponse.status, 201);
    const persisted = await readJson<{ availability: string; recordingId?: string }>(persistResponse);
    assert.equal(persisted.availability, 'available');
    assert.ok(persisted.recordingId);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
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
  workflowExecution,
  rivetNode,
  withWorkflowExecutionServer,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();

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

    const latestResponse = await fetch(`${latestBaseUrl}/recorded-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'latest' }),
    });
    assert.equal(latestResponse.ok, true);

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
  const previousMaxRunsPerEndpoint = process.env.RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT;
  process.env.RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT = '2';

  try {
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
  } finally {
    if (previousMaxRunsPerEndpoint == null) {
      delete process.env.RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT;
    } else {
      process.env.RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT = previousMaxRunsPerEndpoint;
    }
  }
});

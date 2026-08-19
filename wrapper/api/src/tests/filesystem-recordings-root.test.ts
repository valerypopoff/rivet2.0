import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createWorkflowTestRoots, resetWorkflowTestRoots } from './helpers/workflow-fixtures.js';

const envKeys = [
  'RIVET_WORKSPACE_ROOT',
  'RIVET_WORKFLOWS_ROOT',
  'RIVET_WORKFLOW_RECORDINGS_ROOT',
  'RIVET_APP_DATA_ROOT',
  'RIVET_STORAGE_MODE',
] as const;

const previousEnv = new Map<string, string | undefined>();
for (const key of envKeys) {
  previousEnv.set(key, process.env[key]);
}

const {
  tempRoot,
  workflowsRoot,
  recordingsRoot,
  appDataRoot,
} = await createWorkflowTestRoots('rivet-filesystem-recordings-root-');

process.env.RIVET_WORKSPACE_ROOT = tempRoot;
process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = recordingsRoot;
process.env.RIVET_APP_DATA_ROOT = appDataRoot;
process.env.RIVET_STORAGE_MODE = 'filesystem';

const workflowFs = await import('../routes/workflows/fs-helpers.js');
const workflowMutations = await import('../routes/workflows/workflow-mutations.js');
const workflowRecordings = await import('../routes/workflows/recordings.js');
const workflowRecordingDb = await import('../routes/workflows/recordings-db.js');
const { writeRunRecordingsSettings } = await import('../routes/workflows/recordings-config.js');
const rivetNode = await import('@valerypopoff/rivet2-node');

async function resetFilesystemRoots(): Promise<void> {
  await workflowRecordings.resetWorkflowRecordingStorageForTests();
  await resetWorkflowTestRoots({ workflowsRoot, recordingsRoot, appDataRoot });
}

test.beforeEach(async () => {
  await resetFilesystemRoots();
});

test.after(async () => {
  await workflowRecordings.resetWorkflowRecordingStorageForTests();
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

  for (const key of envKeys) {
    const previousValue = previousEnv.get(key);
    if (previousValue == null) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
  }
});

test('workflow and recordings roots initialize separately', async () => {
  await fs.rm(recordingsRoot, { recursive: true, force: true });
  await workflowFs.ensureWorkflowsRoot();
  await workflowRecordings.initializeWorkflowRecordingStorage(workflowsRoot);

  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, '.published')), true);
  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, '.recordings')), false);
  assert.equal(await workflowFs.pathExists(recordingsRoot), true);
});

test('recording index migrates from WAL to volume-compatible rollback journaling', async () => {
  const databasePath = path.join(appDataRoot, 'recordings.sqlite');
  await fs.mkdir(appDataRoot, { recursive: true });

  const legacyDatabase = new DatabaseSync(databasePath);
  legacyDatabase.exec('PRAGMA journal_mode = WAL; CREATE TABLE legacy_recordings (id TEXT PRIMARY KEY);');
  legacyDatabase.close();

  await workflowRecordings.initializeWorkflowRecordingStorage(workflowsRoot);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const journalMode = database.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>();
    assert.ok(journalMode);
    assert.equal(journalMode.journal_mode, 'delete');
  } finally {
    database.close();
  }
});

test('recording bundle index insertion rolls back the workflow row when the run insert fails', async () => {
  const workflowId = 'atomic-recording-workflow';
  const createdAt = new Date().toISOString();

  await assert.rejects(
    workflowRecordingDb.upsertWorkflowRecordingBundle(
      {
        workflowId,
        sourceProjectMetadataId: workflowId,
        sourceProjectPath: path.join(workflowsRoot, 'Atomic.rivet-project'),
        sourceProjectRelativePath: 'Atomic.rivet-project',
        sourceProjectName: 'Atomic',
        updatedAt: createdAt,
      },
      {
        id: 'atomic-recording-run',
        workflowId: 'missing-workflow',
        createdAt,
        runKind: 'published',
        status: 'succeeded',
        durationMs: 1,
        endpointNameAtExecution: 'atomic',
        bundlePath: path.join(recordingsRoot, workflowId, 'atomic-recording-run'),
        encoding: 'identity',
        hasReplayDataset: false,
        recordingCompressedBytes: 1,
        recordingUncompressedBytes: 1,
        projectCompressedBytes: 1,
        projectUncompressedBytes: 1,
        datasetCompressedBytes: 0,
        datasetUncompressedBytes: 0,
      },
    ),
  );

  const indexedWorkflows = await workflowRecordingDb.listWorkflowRecordingWorkflowStatsRows();
  assert.equal(indexedWorkflows.some((workflow) => workflow.workflowId === workflowId), false);
});

test('recording index rebuild keeps workflow metadata from the newest bundle', async () => {
  const workflowId = 'workflow-metadata-order';
  const workflowRoot = path.join(recordingsRoot, workflowId);
  const writeBundleMetadata = async (
    bundleName: string,
    createdAt: string,
    sourceProjectName: string,
  ): Promise<void> => {
    const bundlePath = path.join(workflowRoot, bundleName);
    await fs.mkdir(bundlePath, { recursive: true });
    await fs.writeFile(path.join(bundlePath, 'metadata.json'), `${JSON.stringify({
      version: 2,
      id: bundleName,
      workflowId,
      sourceProjectMetadataId: workflowId,
      sourceProjectName,
      sourceProjectPath: path.join(workflowsRoot, `${sourceProjectName}.rivet-project`),
      sourceProjectRelativePath: `${sourceProjectName}.rivet-project`,
      endpointNameAtExecution: 'metadata-order',
      createdAt,
      runKind: 'published',
      status: 'succeeded',
      durationMs: 1,
      encoding: 'identity',
      hasReplayDataset: false,
      recordingCompressedBytes: 1,
      recordingUncompressedBytes: 1,
      projectCompressedBytes: 1,
      projectUncompressedBytes: 1,
      datasetCompressedBytes: 0,
      datasetUncompressedBytes: 0,
    })}\n`, 'utf8');
  };

  // Directory order intentionally scans the newer bundle first and the older
  // bundle last. Workflow metadata must still come from the newest run.
  await writeBundleMetadata('a-newer', '2026-08-03T00:00:00.000Z', 'New project name');
  await writeBundleMetadata('z-older', '2026-08-01T00:00:00.000Z', 'Old project name');
  // This test exercises index ordering, not retention. Keep its fixed fixture
  // dates from expiring as calendar time moves forward.
  await writeRunRecordingsSettings({ retentionDays: 0 });
  await workflowRecordings.initializeWorkflowRecordingStorage(workflowsRoot);

  const [workflow] = await workflowRecordingDb.listWorkflowRecordingWorkflowStatsRows();
  assert.ok(workflow);
  assert.equal(workflow.sourceProjectName, 'New project name');
  assert.equal(workflow.sourceProjectRelativePath, 'New project name.rivet-project');
  assert.equal(workflow.updatedAt, '2026-08-03T00:00:00.000Z');
  assert.equal(workflow.totalRuns, 2);
});

test('filesystem recording persistence writes bundles under the configured recordings root', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'RootSplit');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'root-split-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'root-split-recording',
        events: [],
        startTs: 1,
        finishTs: 1,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'latest',
    status: 'succeeded',
    durationMs: 1,
  });

  const projectRecordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(recordingsRoot, loadedProject.metadata.id!);
  const bundleDirectories = (await fs.readdir(projectRecordingsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));

  assert.equal(bundleDirectories.length, 1);
  const bundlePath = path.join(projectRecordingsRoot, bundleDirectories[0]!.name);
  const bundleFiles = await fs.readdir(bundlePath);
  assert.equal(bundleFiles.includes('metadata.json'), true);
  assert.equal(bundleFiles.some((fileName) => fileName.endsWith('.tmp')), false);
  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, '.recordings')), false);
  assert.equal(projectRecordingsRoot.startsWith(recordingsRoot), true);
});

test('recordings listing repairs on-disk index drift without blocking the list response', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DriftRepair');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'drift-repair-endpoint',
  });
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'drift-repair-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'drift-repair-recording',
        events: [],
        startTs: 1,
        finishTs: 1,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 1,
  });

  await workflowRecordingDb.clearWorkflowRecordingIndex();

  const staleWorkflows = await workflowRecordings.listWorkflowRecordingWorkflows(workflowsRoot);
  const stale = staleWorkflows.workflows.find((workflow) => workflow.workflowId === loadedProject.metadata.id);
  assert.ok(stale);
  assert.equal(stale.totalRuns, 0);

  await workflowRecordings.flushWorkflowRecordingIndexRepairForTests();
  const repairedWorkflows = await workflowRecordings.listWorkflowRecordingWorkflows(workflowsRoot);
  const repaired = repairedWorkflows.workflows.find((workflow) => workflow.workflowId === loadedProject.metadata.id);

  assert.ok(repaired);
  assert.equal(repaired.totalRuns, 1);
  assert.equal(repaired.project.settings.publicationStatus, undefined);
  assert.equal(repaired.project.stats, undefined);
});

test('recording index replacement is atomic and rejects a stale concurrent scan', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'AtomicRecordingIndex');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'atomic-recording-index-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'atomic-recording-index-recording',
        events: [],
        startTs: 1,
        finishTs: 1,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 1,
  });

  const workflowId = loadedProject.metadata.id!;
  const [existingRun] = await workflowRecordingDb.listWorkflowRecordingRunRowsForWorkflow(workflowId);
  assert.ok(existingRun);

  await assert.rejects(
    workflowRecordingDb.replaceWorkflowRecordingIndex([], [existingRun]),
  );

  const workflows = await workflowRecordingDb.listWorkflowRecordingWorkflowStatsRows();
  let runs = await workflowRecordingDb.listWorkflowRecordingRunRowsForWorkflow(workflowId);
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]?.workflowId, workflowId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.id, existingRun.id);

  const scanRevision = workflowRecordingDb.getWorkflowRecordingIndexRevision();
  await workflowRecordingDb.upsertWorkflowRecordingRun({
    ...existingRun,
    id: 'concurrent-recording-index-write',
  });
  const replaced = await workflowRecordingDb.replaceWorkflowRecordingIndex(
    [workflows[0]!],
    [existingRun],
    { expectedRevision: scanRevision },
  );

  assert.equal(replaced, false);
  runs = await workflowRecordingDb.listWorkflowRecordingRunRowsForWorkflow(workflowId);
  assert.equal(runs.length, 2);
  assert.equal(runs.some((run) => run.id === 'concurrent-recording-index-write'), true);
});

test('recordings drift repair detects swapped bundle rows when counts stay equal', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'EqualCountDrift');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'equal-count-drift-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'equal-count-drift-recording',
        events: [],
        startTs: 1,
        finishTs: 1,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 1,
  });

  const workflowId = loadedProject.metadata.id!;
  const [storedRun] = await workflowRecordingDb.listWorkflowRecordingRunRowsForWorkflow(workflowId);
  const [storedWorkflow] = await workflowRecordingDb.listWorkflowRecordingWorkflowStatsRows();
  assert.ok(storedRun);
  assert.ok(storedWorkflow);

  const indexOnlyRun = {
    ...storedRun,
    id: 'equal-count-drift-index-only-recording',
    bundlePath: path.join(recordingsRoot, workflowId, 'equal-count-drift-index-only-recording'),
  };
  await workflowRecordingDb.replaceWorkflowRecordingIndex([storedWorkflow], [indexOnlyRun]);

  await workflowRecordings.listWorkflowRecordingWorkflows(workflowsRoot);
  await workflowRecordings.flushWorkflowRecordingIndexRepairForTests();

  const repairedRuns = await workflowRecordingDb.listWorkflowRecordingRunRowsForWorkflow(workflowId);
  assert.equal(repairedRuns.length, 1);
  assert.equal(repairedRuns[0]?.id, storedRun.id);
  assert.equal(repairedRuns[0]?.bundlePath, storedRun.bundlePath);
});

test('recordings listing ignores empty workflow recording directories during drift repair', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'EmptyRecordingRoots');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'empty-recording-roots-endpoint',
  });
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'empty-recording-roots-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'empty-recording-roots-recording',
        events: [],
        startTs: 1,
        finishTs: 1,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 1,
  });

  await fs.mkdir(path.join(recordingsRoot, 'empty-workflow-recording-root'), { recursive: true });
  const sentinelUpdatedAt = '2099-01-01T00:00:00.000Z';
  await workflowRecordingDb.upsertWorkflowRecordingWorkflow({
    workflowId: loadedProject.metadata.id!,
    sourceProjectMetadataId: loadedProject.metadata.id!,
    sourceProjectPath: created.absolutePath,
    sourceProjectRelativePath: created.relativePath,
    sourceProjectName: 'EmptyRecordingRoots',
    updatedAt: sentinelUpdatedAt,
  });

  const workflows = await workflowRecordings.listWorkflowRecordingWorkflows(workflowsRoot);
  const indexedWorkflows = await workflowRecordingDb.listWorkflowRecordingWorkflowStatsRows();

  assert.equal(workflows.workflows.length, 1);
  assert.equal(workflows.workflows[0]?.workflowId, loadedProject.metadata.id);
  assert.equal(workflows.workflows[0]?.totalRuns, 1);
  assert.equal(indexedWorkflows.length, 1);
  assert.equal(indexedWorkflows[0]?.workflowId, loadedProject.metadata.id);
  assert.equal(indexedWorkflows[0]?.updatedAt, sentinelUpdatedAt);
});

test('recordings listing does not repeat an unrepairable drift rebuild on every request', async (t) => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'CorruptRecordingMetadata');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'corrupt-recording-metadata-endpoint',
  });
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'corrupt-recording-metadata-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'corrupt-recording-metadata-valid-recording',
        events: [],
        startTs: 1,
        finishTs: 1,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 1,
  });

  const corruptBundleRoot = path.join(recordingsRoot, loadedProject.metadata.id!, 'corrupt-bundle');
  await fs.mkdir(corruptBundleRoot, { recursive: true });
  await fs.writeFile(path.join(corruptBundleRoot, 'metadata.json'), '{', 'utf8');

  const warnings: unknown[] = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  t.after(() => {
    console.warn = originalConsoleWarn;
  });

  await workflowRecordings.listWorkflowRecordingWorkflows(workflowsRoot);
  await workflowRecordings.flushWorkflowRecordingIndexRepairForTests();

  const sentinelUpdatedAt = '2099-01-01T00:00:00.000Z';
  await workflowRecordingDb.upsertWorkflowRecordingWorkflow({
    workflowId: loadedProject.metadata.id!,
    sourceProjectMetadataId: loadedProject.metadata.id!,
    sourceProjectPath: created.absolutePath,
    sourceProjectRelativePath: created.relativePath,
    sourceProjectName: 'CorruptRecordingMetadata',
    updatedAt: sentinelUpdatedAt,
  });

  await workflowRecordings.listWorkflowRecordingWorkflows(workflowsRoot);
  const indexedWorkflows = await workflowRecordingDb.listWorkflowRecordingWorkflowStatsRows();

  assert.equal(indexedWorkflows.length, 1);
  assert.equal(indexedWorkflows[0]?.workflowId, loadedProject.metadata.id);
  assert.equal(indexedWorkflows[0]?.totalRuns, 1);
  assert.equal(indexedWorkflows[0]?.updatedAt, sentinelUpdatedAt);
  assert.equal(warnings.some((args) => String((args as unknown[])[0] ?? '').includes('Recording index repair did not converge')), true);
});

test('recordings cleanup tolerates a permission failure deleting one stale bundle', async (t) => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'CleanupPermissions');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);

  const persistRun = async (recordingId: string) => {
    await workflowRecordings.persistWorkflowExecutionRecording({
      workflowsRoot,
      sourceProject: loadedProject,
      sourceProjectPath: created.absolutePath,
      executedProject: loadedProject,
      executedAttachedData: attachedData,
      executedDatasets: [],
      endpointName: 'cleanup-permissions-endpoint',
      recordingSerialized: JSON.stringify({
        version: 1,
        recording: {
          recordingId,
          events: [],
          startTs: 1,
          finishTs: 1,
        },
        assets: {},
        strings: {},
      }),
      runKind: 'latest',
      status: 'succeeded',
      durationMs: 1,
    });
  };

  await persistRun('cleanup-permissions-recording-1');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await persistRun('cleanup-permissions-recording-2');

  const runs = await workflowRecordingDb.listWorkflowRecordingRunRowsByWorkflowId(loadedProject.metadata.id!, {
    page: 1,
    pageSize: 10,
    statusFilter: 'all',
  });
  assert.equal(runs.length, 2);
  const run = runs[runs.length - 1];
  assert.ok(run);

  await writeRunRecordingsSettings({
    maxPendingWrites: 100,
    maxRunsPerEndpoint: 1,
    retentionDays: 14,
  });

  const originalRm = fs.rm;
  const errors: unknown[] = [];
  const originalConsoleError = console.error;

  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  t.after(() => {
    console.error = originalConsoleError;
  });

  t.mock.method(fs, 'rm', async (
    targetPath: Parameters<typeof fs.rm>[0],
    options?: Parameters<typeof fs.rm>[1],
  ) => {
    if (String(targetPath) === run.bundlePath) {
      const error = new Error(`EACCES: permission denied, rmdir '${run.bundlePath}'`) as Error & { code?: string };
      error.code = 'EACCES';
      throw error;
    }

    return originalRm(targetPath, options);
  });

  await (await import('../routes/workflows/recordings-maintenance.js')).cleanupWorkflowRecordingStorage();

  const rowAfterCleanup = await workflowRecordingDb.getWorkflowRecordingRunRow(run.id);
  assert.ok(rowAfterCleanup);
  assert.equal(errors.length > 0, true);
  const [firstErrorArgs] = errors as unknown[] as Array<unknown[]>;
  assert.match(String(firstErrorArgs?.[0] ?? ''), /Failed to delete recording during cleanup/);
});

test('recordings cleanup keeps independent limits when projects reuse an endpoint slug', async () => {
  const createdAt = ['2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', '2026-08-01T12:00:00.000Z'];
  const workflows = [
    { workflowId: 'workflow-a', runId: 'a-old', createdAt: createdAt[0] },
    { workflowId: 'workflow-a', runId: 'a-new', createdAt: createdAt[1] },
    { workflowId: 'workflow-b', runId: 'b-only', createdAt: createdAt[2] },
  ];

  for (const item of workflows) {
    await workflowRecordingDb.upsertWorkflowRecordingBundle(
      {
        workflowId: item.workflowId,
        sourceProjectMetadataId: item.workflowId,
        sourceProjectPath: path.join(workflowsRoot, `${item.workflowId}.rivet-project`),
        sourceProjectRelativePath: `${item.workflowId}.rivet-project`,
        sourceProjectName: item.workflowId,
        updatedAt: item.createdAt!,
      },
      {
        id: item.runId,
        workflowId: item.workflowId,
        createdAt: item.createdAt!,
        runKind: 'published',
        status: 'succeeded',
        durationMs: 1,
        endpointNameAtExecution: 'shared',
        bundlePath: path.join(recordingsRoot, item.workflowId, item.runId),
        encoding: 'identity',
        hasReplayDataset: false,
        recordingCompressedBytes: 1,
        recordingUncompressedBytes: 1,
        projectCompressedBytes: 1,
        projectUncompressedBytes: 1,
        datasetCompressedBytes: 0,
        datasetUncompressedBytes: 0,
      },
    );
  }

  await writeRunRecordingsSettings({
    maxPendingWrites: 100,
    maxRunsPerEndpoint: 1,
    retentionDays: 0,
  });
  await (await import('../routes/workflows/recordings-maintenance.js')).cleanupWorkflowRecordingStorage();

  assert.equal(await workflowRecordingDb.getWorkflowRecordingRunRow('a-old'), null);
  assert.ok(await workflowRecordingDb.getWorkflowRecordingRunRow('a-new'));
  assert.ok(await workflowRecordingDb.getWorkflowRecordingRunRow('b-only'));
});

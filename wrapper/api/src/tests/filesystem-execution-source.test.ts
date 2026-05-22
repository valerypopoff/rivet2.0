import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  createRootPublishedProjectFactory,
  createWorkflowTestRoots,
  resetWorkflowTestRoots,
} from './helpers/workflow-fixtures.js';

const envKeys = [
  'RIVET_WORKSPACE_ROOT',
  'RIVET_WORKFLOWS_ROOT',
  'RIVET_WORKFLOW_RECORDINGS_ROOT',
  'RIVET_APP_DATA_ROOT',
  'RIVET_RUNTIME_LIBRARIES_ROOT',
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
  runtimeLibrariesRoot,
} = await createWorkflowTestRoots('rivet-filesystem-execution-source-');

process.env.RIVET_WORKSPACE_ROOT = tempRoot;
process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = recordingsRoot;
process.env.RIVET_APP_DATA_ROOT = appDataRoot;
process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeLibrariesRoot;
process.env.RIVET_STORAGE_MODE = 'filesystem';

const workflowFs = await import('../routes/workflows/fs-helpers.js');
const workflowMutations = await import('../routes/workflows/workflow-mutations.js');
const workflowPublication = await import('../routes/workflows/publication.js');
const executionSource = await import('../routes/workflows/filesystem-execution-source.js');
const rivetNode = await import('@valerypopoff/rivet2-node');

const createRootPublishedProject = createRootPublishedProjectFactory(workflowMutations);

async function resetFilesystemRoots(): Promise<void> {
  await resetWorkflowTestRoots({ workflowsRoot, recordingsRoot, appDataRoot, runtimeLibrariesRoot });
  await workflowFs.ensureWorkflowsRoot();
}

function createDatasetsContents(value: string): string {
  return rivetNode.serializeDatasets([
    {
      meta: {
        id: 'dataset-1' as never,
        projectId: 'project-1' as never,
        name: 'Example Dataset',
        description: '',
      },
      data: {
        id: 'dataset-1' as never,
        rows: [
          {
            id: 'row-1',
            data: [value],
          },
        ],
      },
    },
  ]);
}

test.beforeEach(async () => {
  await resetFilesystemRoots();
});

test.after(async () => {
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

test('filesystem execution source resolves latest pointers to the live project path', async () => {
  const created = await createRootPublishedProject('Latest Pointer Project', 'latest-pointer-endpoint');

  const pointer = await executionSource.resolveFilesystemLatestExecutionPointer(workflowsRoot, 'latest-pointer-endpoint');
  assert.ok(pointer);
  assert.equal(pointer.sourceProjectPath, created.absolutePath);
  assert.equal(pointer.executionProjectPath, created.absolutePath);

  const latestMatch = await workflowPublication.findLatestWorkflowByEndpoint(workflowsRoot, 'latest-pointer-endpoint');
  assert.ok(latestMatch);
  assert.equal(pointer.sourceProjectPath, latestMatch.projectPath);
});

test('filesystem execution source resolves latest pointers from the draft endpoint after publish settings diverge', async () => {
  const created = await createRootPublishedProject('Latest Draft Pointer Project', 'published-latest-pointer-endpoint');
  const settingsPath = workflowFs.getWorkflowProjectSettingsPath(created.absolutePath);
  const settings = await workflowPublication.readStoredWorkflowProjectSettings(created.absolutePath, created.name);

  await fs.writeFile(
    settingsPath,
    `${JSON.stringify({
      ...settings,
      endpointName: 'draft-latest-pointer-endpoint',
    }, null, 2)}\n`,
    'utf8',
  );

  const latestPointer = await executionSource.resolveFilesystemLatestExecutionPointer(
    workflowsRoot,
    'draft-latest-pointer-endpoint',
  );
  assert.ok(latestPointer);
  assert.equal(latestPointer.sourceProjectPath, created.absolutePath);
  assert.equal(latestPointer.executionProjectPath, created.absolutePath);

  const publishedPointer = await executionSource.resolveFilesystemPublishedExecutionPointer(
    workflowsRoot,
    'published-latest-pointer-endpoint',
  );
  assert.ok(publishedPointer);
  assert.equal(publishedPointer.sourceProjectPath, created.absolutePath);
});

test('filesystem execution source stops resolving both public endpoint families after full unpublish while keeping the saved draft endpoint', async () => {
  const created = await createRootPublishedProject('Unpublished Latest Pointer Project', 'unpublished-latest-pointer-endpoint');

  await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);

  const storedSettings = await workflowPublication.readStoredWorkflowProjectSettings(created.absolutePath, created.name);
  assert.equal(storedSettings.endpointName, 'unpublished-latest-pointer-endpoint');

  const latestPointer = await executionSource.resolveFilesystemLatestExecutionPointer(
    workflowsRoot,
    'unpublished-latest-pointer-endpoint',
  );
  const publishedPointer = await executionSource.resolveFilesystemPublishedExecutionPointer(
    workflowsRoot,
    'unpublished-latest-pointer-endpoint',
  );
  const latestMatch = await workflowPublication.findLatestWorkflowByEndpoint(
    workflowsRoot,
    'unpublished-latest-pointer-endpoint',
  );
  const publishedMatch = await workflowPublication.findPublishedWorkflowByEndpoint(
    workflowsRoot,
    'unpublished-latest-pointer-endpoint',
  );

  assert.equal(latestPointer, null);
  assert.equal(publishedPointer, null);
  assert.equal(latestMatch, null);
  assert.equal(publishedMatch, null);
});

test('filesystem execution source prefers the published snapshot when unpublished changes exist', async () => {
  const created = await createRootPublishedProject('Snapshot Pointer Project', 'snapshot-pointer-endpoint');
  const latestContents = await fs.readFile(created.absolutePath, 'utf8');
  await fs.writeFile(created.absolutePath, `${latestContents}\n# unpublished change\n`, 'utf8');

  const pointer = await executionSource.resolveFilesystemPublishedExecutionPointer(workflowsRoot, 'snapshot-pointer-endpoint');
  assert.ok(pointer);
  assert.equal(pointer.sourceProjectPath, created.absolutePath);
  assert.notEqual(pointer.executionProjectPath, created.absolutePath);

  const publishedMatch = await workflowPublication.findPublishedWorkflowByEndpoint(workflowsRoot, 'snapshot-pointer-endpoint');
  assert.ok(publishedMatch);
  assert.equal(pointer.executionProjectPath, publishedMatch.publishedProjectPath);
});

test('filesystem execution source skips stale live-backed published candidates in favor of a healthy later candidate', async () => {
  const staleCandidate = await workflowMutations.createWorkflowProjectItem('', 'SourceStaleCandidate');
  const staleOriginalContents = await fs.readFile(staleCandidate.absolutePath, 'utf8');
  const sharedEndpoint = 'source-shared-published-endpoint';
  const publishedStateHash = await workflowPublication.createWorkflowPublicationStateHash(
    staleCandidate.absolutePath,
    sharedEndpoint,
  );

  await workflowMutations.createWorkflowFolderItem('Nested', '');
  const healthyCandidate = await workflowMutations.createWorkflowProjectItem('Nested', 'SourceHealthyCandidate');
  await workflowMutations.publishWorkflowProjectItem(healthyCandidate.relativePath, {
    endpointName: sharedEndpoint,
  });

  await fs.writeFile(staleCandidate.absolutePath, `${staleOriginalContents}\n# stale\n`, 'utf8');
  await fs.writeFile(
    workflowFs.getProjectSidecarPaths(staleCandidate.absolutePath).settings,
    `${JSON.stringify({
      endpointName: sharedEndpoint,
      publishedEndpointName: sharedEndpoint,
      publishedSnapshotId: null,
      publishedStateHash,
      lastPublishedAt: '2025-01-01T00:00:00.000Z',
    }, null, 2)}\n`,
    'utf8',
  );

  const pointer = await executionSource.resolveFilesystemPublishedExecutionPointer(workflowsRoot, sharedEndpoint);
  assert.ok(pointer);
  assert.equal(pointer.sourceProjectPath, healthyCandidate.absolutePath);
});

test('filesystem execution source falls back to the live project when a published snapshot is missing but the live state still matches', async () => {
  const created = await createRootPublishedProject('Missing Snapshot Fallback', 'missing-snapshot-fallback-endpoint');
  const storedSettings = await workflowPublication.readStoredWorkflowProjectSettings(created.absolutePath, created.name);
  assert.ok(storedSettings.publishedSnapshotId);

  await fs.rm(
    workflowFs.getPublishedWorkflowSnapshotPath(workflowsRoot, storedSettings.publishedSnapshotId),
    { force: true },
  );

  const pointer = await executionSource.resolveFilesystemPublishedExecutionPointer(
    workflowsRoot,
    'missing-snapshot-fallback-endpoint',
  );
  assert.ok(pointer);
  assert.equal(pointer.sourceProjectPath, created.absolutePath);
  assert.equal(pointer.executionProjectPath, created.absolutePath);
});

test('filesystem execution source materializes project contents, dataset contents, and file signatures', async () => {
  const created = await createRootPublishedProject('Materialized Source Project', 'materialized-source-endpoint');
  const datasetPath = workflowFs.getWorkflowDatasetPath(created.absolutePath);
  await fs.writeFile(datasetPath, createDatasetsContents('source-dataset-value'), 'utf8');

  const pointer = await executionSource.resolveFilesystemLatestExecutionPointer(workflowsRoot, 'materialized-source-endpoint');
  assert.ok(pointer);

  const materialization = await executionSource.loadFilesystemExecutionMaterialization(pointer);
  assert.equal(materialization.sourceProjectPath, created.absolutePath);
  assert.equal(materialization.executionProjectPath, created.absolutePath);
  assert.equal(materialization.project.metadata.title, 'Materialized Source Project');
  assert.equal(materialization.projectSignature.type, 'file');
  assert.equal(materialization.datasetSignature.type, 'file');
  assert.ok(materialization.datasetsContents);

  const datasets = rivetNode.deserializeDatasets(materialization.datasetsContents);
  assert.deepEqual(
    datasets.flatMap((dataset) => dataset.data.rows.map((row) => String(row.data[0] ?? ''))),
    ['source-dataset-value'],
  );
});

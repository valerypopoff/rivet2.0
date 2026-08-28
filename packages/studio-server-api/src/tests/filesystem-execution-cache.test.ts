import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createRootPublishedProjectFactory,
  createWorkflowTestRoots,
  resetWorkflowTestRoots,
} from './helpers/workflow-fixtures.js';

const envKeys = [
  'RIVET_WORKSPACE_ROOT',
  'RIVET_WORKFLOWS_ROOT',
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
  appDataRoot,
  runtimeLibrariesRoot,
} = await createWorkflowTestRoots('rivet-filesystem-execution-cache-');

process.env.RIVET_WORKSPACE_ROOT = tempRoot;
process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
process.env.RIVET_APP_DATA_ROOT = appDataRoot;
process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeLibrariesRoot;
process.env.RIVET_STORAGE_MODE = 'filesystem';

const workflowFs = await import('../routes/workflows/fs-helpers.js');
const workflowMutations = await import('../routes/workflows/workflow-mutations.js');
const workflowPublication = await import('../routes/workflows/publication.js');
const {
  FilesystemExecutionCache,
  resetFilesystemExecutionCacheForTests,
} = await import('../routes/workflows/filesystem-execution-cache.js');
const rivetNode = await import('@valerypopoff/rivet2-node');

const createRootPublishedProject = createRootPublishedProjectFactory(workflowMutations);

async function resetFilesystemRoots(): Promise<void> {
  resetFilesystemExecutionCacheForTests();
  await resetWorkflowTestRoots({ workflowsRoot, appDataRoot, runtimeLibrariesRoot });
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

async function exportDatasetValues(datasetProvider: InstanceType<typeof rivetNode.NodeDatasetProvider>): Promise<string[]> {
  const datasets = await datasetProvider.exportDatasetsForProject('ignored' as never);
  return datasets.flatMap((dataset) => dataset.data.rows.map((row) => String(row.data[0] ?? '')));
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

test.beforeEach(async () => {
  await resetFilesystemRoots();
});

test.after(async () => {
  resetFilesystemExecutionCacheForTests();
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

test('filesystem execution cache warms published and latest endpoint pointers at startup', async () => {
  const created = await createRootPublishedProject('WarmIndex', 'warm-index-endpoint');
  const cache = new FilesystemExecutionCache();

  await cache.initialize(workflowsRoot);

  const published = await cache.loadPublishedExecutionProject(workflowsRoot, 'warm-index-endpoint');
  const latest = await cache.loadLatestExecutionProject(workflowsRoot, 'warm-index-endpoint');

  assert.ok(published);
  assert.ok(latest);
  assert.equal(published.projectVirtualPath, created.absolutePath);
  assert.equal(latest.projectVirtualPath, created.absolutePath);
  assert.equal(published.debug.cacheStatus, 'hit');
  assert.equal(latest.debug.cacheStatus, 'hit');
});

test('filesystem execution cache invalidates published snapshot materializations by source project path', async () => {
  const created = await createRootPublishedProject('Published Source Invalidation', 'published-source-invalidation');
  const cache = new FilesystemExecutionCache();

  await cache.initialize(workflowsRoot);

  const initial = await cache.loadPublishedExecutionProject(workflowsRoot, 'published-source-invalidation');
  assert.ok(initial);

  const warmHit = await cache.loadPublishedExecutionProject(workflowsRoot, 'published-source-invalidation');
  assert.ok(warmHit);
  assert.equal(warmHit.debug.cacheStatus, 'hit');
  assert.strictEqual(warmHit.project, initial.project);

  cache.invalidateProjectMaterializations([created.absolutePath]);

  const afterInvalidation = await cache.loadPublishedExecutionProject(workflowsRoot, 'published-source-invalidation');
  assert.ok(afterInvalidation);
  assert.equal(afterInvalidation.debug.cacheStatus, 'hit');
  assert.notStrictEqual(afterInvalidation.project, initial.project);
  assert.equal(afterInvalidation.project.metadata.title, 'Published Source Invalidation');
});

test('filesystem execution cache rebuilds after settings and directory changes', async () => {
  const created = await createRootPublishedProject('RebuildIndex', 'before-index-rebuild');
  const cache = new FilesystemExecutionCache();

  await cache.initialize(workflowsRoot);

  const initial = await cache.loadPublishedExecutionProject(workflowsRoot, 'before-index-rebuild');
  assert.ok(initial);
  assert.equal(initial.debug.cacheStatus, 'hit');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'after-index-rebuild',
  });

  const rebuiltAfterSettings = await cache.loadPublishedExecutionProject(workflowsRoot, 'after-index-rebuild');
  assert.ok(rebuiltAfterSettings);
  assert.equal(rebuiltAfterSettings.debug.cacheStatus, 'miss');

  await workflowMutations.createWorkflowFolderItem('Nested', '');
  const nestedProject = await workflowMutations.createWorkflowProjectItem('Nested', 'Nested Endpoint');
  await workflowMutations.publishWorkflowProjectItem(nestedProject.relativePath, {
    endpointName: 'directory-index-rebuild',
  });

  const rebuiltAfterDirectoryChange = await cache.loadLatestExecutionProject(workflowsRoot, 'directory-index-rebuild');
  assert.ok(rebuiltAfterDirectoryChange);
  assert.equal(rebuiltAfterDirectoryChange.debug.cacheStatus, 'miss');

  const warmAgain = await cache.loadLatestExecutionProject(workflowsRoot, 'directory-index-rebuild');
  assert.ok(warmAgain);
  assert.equal(warmAgain.debug.cacheStatus, 'hit');
});

test('filesystem execution cache resolves latest endpoints from the draft endpoint after settings change', async () => {
  const created = await createRootPublishedProject('Draft Latest Cache Project', 'draft-latest-cache-published');
  const cache = new FilesystemExecutionCache();

  await cache.initialize(workflowsRoot);

  const settingsPath = workflowFs.getWorkflowProjectSettingsPath(created.absolutePath);
  const settings = await workflowPublication.readStoredWorkflowProjectSettings(created.absolutePath, created.name);
  await fs.writeFile(
    settingsPath,
    `${JSON.stringify({
      ...settings,
      endpointName: 'draft-latest-cache-current',
    }, null, 2)}\n`,
    'utf8',
  );

  const rebuiltLatest = await cache.loadLatestExecutionProject(workflowsRoot, 'draft-latest-cache-current');
  assert.ok(rebuiltLatest);
  assert.equal(rebuiltLatest.projectVirtualPath, created.absolutePath);
  assert.equal(rebuiltLatest.debug.cacheStatus, 'miss');

  const staleLatest = await cache.loadLatestExecutionProject(workflowsRoot, 'draft-latest-cache-published');
  assert.equal(staleLatest, null);

  const published = await cache.loadPublishedExecutionProject(workflowsRoot, 'draft-latest-cache-published');
  assert.ok(published);
  assert.equal(published.projectVirtualPath, created.absolutePath);
});

test('filesystem execution cache drops both public endpoint families after full unpublish while keeping the saved draft endpoint', async () => {
  const created = await createRootPublishedProject('Draft Latest Cache Unpublish', 'draft-latest-cache-unpublish');
  const cache = new FilesystemExecutionCache();

  await cache.initialize(workflowsRoot);

  const warmLatest = await cache.loadLatestExecutionProject(workflowsRoot, 'draft-latest-cache-unpublish');
  assert.ok(warmLatest);
  assert.equal(warmLatest.debug.cacheStatus, 'hit');

  await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);

  const storedSettings = await workflowPublication.readStoredWorkflowProjectSettings(created.absolutePath, created.name);
  assert.equal(storedSettings.endpointName, 'draft-latest-cache-unpublish');

  const latestAfterUnpublish = await cache.loadLatestExecutionProject(workflowsRoot, 'draft-latest-cache-unpublish');
  const publishedAfterUnpublish = await cache.loadPublishedExecutionProject(workflowsRoot, 'draft-latest-cache-unpublish');

  assert.equal(latestAfterUnpublish, null);
  assert.equal(publishedAfterUnpublish, null);
});

test('filesystem execution cache preserves stale published candidate skipping and notices stale candidate healing', async () => {
  const staleCandidate = await workflowMutations.createWorkflowProjectItem('', 'EndpointStaleCandidate');
  const staleOriginalContents = await fs.readFile(staleCandidate.absolutePath, 'utf8');
  const sharedEndpoint = 'shared-published-endpoint';
  const publishedStateHash = await workflowPublication.createWorkflowPublicationStateHash(
    staleCandidate.absolutePath,
    sharedEndpoint,
  );

  await workflowMutations.createWorkflowFolderItem('Nested', '');
  const healthyCandidate = await workflowMutations.createWorkflowProjectItem('Nested', 'EndpointHealthyCandidate');
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

  const cache = new FilesystemExecutionCache();
  await cache.initialize(workflowsRoot);

  const initialPublished = await cache.loadPublishedExecutionProject(workflowsRoot, sharedEndpoint);
  assert.ok(initialPublished);
  assert.equal(initialPublished.projectVirtualPath, healthyCandidate.absolutePath);
  assert.equal(initialPublished.debug.cacheStatus, 'hit');

  await fs.writeFile(staleCandidate.absolutePath, staleOriginalContents, 'utf8');

  const bypassPublished = await cache.loadPublishedExecutionProject(workflowsRoot, sharedEndpoint);
  assert.ok(bypassPublished);
  assert.equal(bypassPublished.projectVirtualPath, staleCandidate.absolutePath);
  assert.equal(bypassPublished.debug.cacheStatus, 'bypass');

  const rebuiltPublished = await cache.loadPublishedExecutionProject(workflowsRoot, sharedEndpoint);
  assert.ok(rebuiltPublished);
  assert.equal(rebuiltPublished.projectVirtualPath, staleCandidate.absolutePath);
  assert.equal(rebuiltPublished.debug.cacheStatus, 'miss');

  const warmPublished = await cache.loadPublishedExecutionProject(workflowsRoot, sharedEndpoint);
  assert.ok(warmPublished);
  assert.equal(warmPublished.projectVirtualPath, staleCandidate.absolutePath);
  assert.equal(warmPublished.debug.cacheStatus, 'hit');
});

test('filesystem execution cache reuses cached materialization and reloads project and dataset contents when files change', async () => {
  const created = await createRootPublishedProject('Materialized Project', 'materialized-project-endpoint');
  const sidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);
  await fs.writeFile(sidecars.dataset, createDatasetsContents('before'), 'utf8');

  const cache = new FilesystemExecutionCache();
  await cache.initialize(workflowsRoot);

  const initial = await cache.loadLatestExecutionProject(workflowsRoot, 'materialized-project-endpoint');
  assert.ok(initial);
  assert.equal(initial.project.metadata.title, 'Materialized Project');
  assert.deepEqual(await exportDatasetValues(initial.datasetProvider), ['before']);

  const warmHit = await cache.loadLatestExecutionProject(workflowsRoot, 'materialized-project-endpoint');
  assert.ok(warmHit);
  assert.equal(warmHit.debug.cacheStatus, 'hit');
  assert.strictEqual(warmHit.project, initial.project);
  assert.strictEqual(warmHit.attachedData, initial.attachedData);
  assert.deepEqual(await exportDatasetValues(warmHit.datasetProvider), ['before']);

  const updatedProjectContents = (await fs.readFile(created.absolutePath, 'utf8'))
    .replace('title: "Materialized Project"', 'title: "Materialized Project Updated"');
  await fs.writeFile(created.absolutePath, updatedProjectContents, 'utf8');
  await fs.writeFile(sidecars.dataset, createDatasetsContents('after'), 'utf8');

  const afterFileChanges = await cache.loadLatestExecutionProject(workflowsRoot, 'materialized-project-endpoint');
  assert.ok(afterFileChanges);
  assert.equal(afterFileChanges.debug.cacheStatus, 'hit');
  assert.notStrictEqual(afterFileChanges.project, initial.project);
  assert.notStrictEqual(afterFileChanges.attachedData, initial.attachedData);
  assert.equal(afterFileChanges.project.metadata.title, 'Materialized Project Updated');
  assert.deepEqual(await exportDatasetValues(afterFileChanges.datasetProvider), ['after']);

  await fs.rm(sidecars.dataset, { force: true });

  const afterDatasetRemoval = await cache.loadLatestExecutionProject(workflowsRoot, 'materialized-project-endpoint');
  assert.ok(afterDatasetRemoval);
  assert.equal(afterDatasetRemoval.debug.cacheStatus, 'hit');
  assert.deepEqual(await exportDatasetValues(afterDatasetRemoval.datasetProvider), []);
});

test('filesystem execution cache does not let an invalidated in-flight materialization repopulate stale cache state', async (t) => {
  const created = await createRootPublishedProject('Invalidate In Flight', 'invalidate-in-flight-endpoint');
  const cache = new FilesystemExecutionCache();

  await cache.initialize(workflowsRoot);

  const blockedReadStarted = createDeferred<void>();
  const unblockRead = createDeferred<void>();
  const originalReadFile = fs.readFile.bind(fs);
  let blockedProjectRead = false;
  let projectReadCount = 0;

  t.mock.method(fs, 'readFile', async (filePath: any, ...args: any[]) => {
    if (String(filePath) === created.absolutePath) {
      projectReadCount += 1;

      if (!blockedProjectRead) {
        blockedProjectRead = true;
        blockedReadStarted.resolve();
        await unblockRead.promise;
      }
    }

    return originalReadFile(filePath, ...args);
  });

  const firstLoadPromise = cache.loadLatestExecutionProject(workflowsRoot, 'invalidate-in-flight-endpoint');
  await blockedReadStarted.promise;

  cache.invalidateProjectMaterializations([created.absolutePath]);
  unblockRead.resolve();

  const firstLoad = await firstLoadPromise;
  assert.ok(firstLoad);
  assert.equal(projectReadCount, 1);

  const secondLoad = await cache.loadLatestExecutionProject(workflowsRoot, 'invalidate-in-flight-endpoint');
  assert.ok(secondLoad);
  assert.equal(secondLoad.debug.cacheStatus, 'hit');
  assert.equal(projectReadCount, 2);
});

test('filesystem execution cache preserves dirty invalidations that arrive during an index rebuild', async (t) => {
  await createRootPublishedProject('First Indexed Project', 'first-indexed-endpoint');
  const cache = new FilesystemExecutionCache();

  await cache.initialize(workflowsRoot);

  const firstProjectSettingsPath = workflowFs.getWorkflowProjectSettingsPath(
    path.join(workflowsRoot, 'First Indexed Project.rivet-project'),
  );
  const blockedReadStarted = createDeferred<void>();
  const unblockRead = createDeferred<void>();
  const originalReadFile = fs.readFile.bind(fs);
  let blockedSettingsRead = false;

  t.mock.method(fs, 'readFile', async (filePath: any, ...args: any[]) => {
    if (String(filePath) === firstProjectSettingsPath && !blockedSettingsRead) {
      blockedSettingsRead = true;
      blockedReadStarted.resolve();
      await unblockRead.promise;
    }

    return originalReadFile(filePath, ...args);
  });

  cache.markIndexDirty();
  const rebuildingLookupPromise = cache.loadLatestExecutionProject(workflowsRoot, 'first-indexed-endpoint');
  await blockedReadStarted.promise;

  const secondProject = await workflowMutations.createWorkflowProjectItem('', 'Second Indexed Project');
  await workflowMutations.publishWorkflowProjectItem(secondProject.relativePath, {
    endpointName: 'second-indexed-endpoint',
  });
  cache.markIndexDirty();
  unblockRead.resolve();

  const rebuildingLookup = await rebuildingLookupPromise;
  assert.ok(rebuildingLookup);
  assert.equal(rebuildingLookup.debug.cacheStatus, 'miss');

  const secondLookup = await cache.loadLatestExecutionProject(workflowsRoot, 'second-indexed-endpoint');
  assert.ok(secondLookup);
  assert.equal(secondLookup.projectVirtualPath, secondProject.absolutePath);
  assert.equal(secondLookup.debug.cacheStatus, 'hit');
});

test('filesystem execution cache resets cleanly when the workflows root changes', async () => {
  await createRootPublishedProject('First Root Project', 'first-root-endpoint');
  const cache = new FilesystemExecutionCache();

  await cache.initialize(workflowsRoot);
  const firstRootResult = await cache.loadLatestExecutionProject(workflowsRoot, 'first-root-endpoint');
  assert.ok(firstRootResult);
  assert.equal(firstRootResult.debug.cacheStatus, 'hit');

  const secondRoots = await createWorkflowTestRoots('rivet-filesystem-execution-cache-second-');
  try {
    await fs.mkdir(path.join(secondRoots.workflowsRoot, '.published'), { recursive: true });

    const endpointName = 'second-root-endpoint';
    const secondProjectPath = path.join(secondRoots.workflowsRoot, 'Second Root Project.rivet-project');
    const secondSettingsPath = workflowFs.getWorkflowProjectSettingsPath(secondProjectPath);

    await fs.writeFile(secondProjectPath, workflowFs.createBlankProjectFile('Second Root Project'), 'utf8');
    await fs.writeFile(
      secondSettingsPath,
      `${JSON.stringify({
        endpointName,
        publishedEndpointName: endpointName,
        publishedSnapshotId: null,
        publishedStateHash: null,
        lastPublishedAt: '2026-04-12T00:00:00.000Z',
        status: 'published',
      }, null, 2)}\n`,
      'utf8',
    );

    await cache.initialize(secondRoots.workflowsRoot);

    const secondRootResult = await cache.loadLatestExecutionProject(secondRoots.workflowsRoot, endpointName);
    assert.ok(secondRootResult);
    assert.equal(secondRootResult.projectVirtualPath, secondProjectPath);
    assert.equal(secondRootResult.project.metadata.title, 'Second Root Project');
    assert.equal(secondRootResult.debug.cacheStatus, 'hit');

    const oldRootResult = await cache.loadLatestExecutionProject(secondRoots.workflowsRoot, 'first-root-endpoint');
    assert.equal(oldRootResult, null);
  } finally {
    await fs.rm(secondRoots.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

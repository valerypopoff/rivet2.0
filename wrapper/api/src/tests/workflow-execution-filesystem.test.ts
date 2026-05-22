import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  readJson,
  waitForRecordingWorkflows,
  withEnvOverride,
} from './helpers/workflow-api-harness.js';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';

const {
  workflowsRoot,
  workflowMutations,
  workflowFs,
  workflowPublication,
  workflowExecution,
  workflowStorageBackend,
  filesystemExecutionCache,
  rivetNode,
  withWorkflowExecutionServer,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();

test.beforeEach(resetAndEnsureWorkflowsRoot);
test.after(cleanupWorkflowSuite);

async function writeHeadersContextEchoProject(projectPath: string, projectName: string): Promise<void> {
  const project = rivetNode.loadProjectFromString(workflowFs.createBlankProjectFile(projectName));
  const graph = project.graphs[project.metadata.mainGraphId!];

  graph.nodes = [
    {
      type: 'context',
      title: 'Context',
      id: 'context-headers',
      visualData: { x: 0, y: 0, width: 300 },
      data: {
        id: 'headers',
        dataType: 'any',
        defaultValue: undefined,
        useDefaultValueInput: false,
      },
    } as never,
    {
      type: 'graphOutput',
      title: 'Graph Output',
      id: 'graph-output',
      visualData: { x: 360, y: 0, width: 300 },
      data: {
        id: 'output',
        dataType: 'any',
      },
    } as never,
  ];
  graph.connections = [
    {
      outputNodeId: 'context-headers',
      outputId: 'data',
      inputNodeId: 'graph-output',
      inputId: 'value',
    } as never,
  ];

  const serializedProject = rivetNode.serializeProject(project);
  if (typeof serializedProject !== 'string') {
    throw new TypeError('Expected serialized project to be a string');
  }
  await fs.writeFile(projectPath, serializedProject, 'utf8');
}

test('workflow request headers context is normalized to a safe string object', () => {
  const rawHeaders: Record<string, unknown> = Object.create(null);
  rawHeaders[' Content-Type '] = 'application/json';
  rawHeaders['X-Storyteller-Header'] = 'published-request-header';
  rawHeaders['x-forwarded-for'] = ['10.0.0.1', '10.0.0.2'];
  rawHeaders['x-broken-array'] = ['dropped', 123, undefined, 'also-dropped'];
  rawHeaders['x-empty-array'] = [];
  rawHeaders['x-undefined'] = undefined;
  rawHeaders['bad header'] = 'bad-name';
  rawHeaders['__proto__'] = 'polluted';
  rawHeaders['constructor'] = 'polluted';
  rawHeaders['prototype'] = 'polluted';

  const headers = workflowExecution.normalizeWorkflowRequestHeadersForContext(rawHeaders);

  assert.deepEqual(headers, {
    'content-type': 'application/json',
    'x-storyteller-header': 'published-request-header',
    'x-forwarded-for': '10.0.0.1, 10.0.0.2',
  });
  assert.equal(Object.getPrototypeOf(headers), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(headers, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(headers, 'constructor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(headers, 'prototype'), false);
  assert.ok(Object.values(headers).every((value) => typeof value === 'string'));
});

test('filesystem execution emits per-stage debug headers only when explicitly enabled', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Measured');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'measured-endpoint',
  });

  await withWorkflowExecutionServer(async ({ publishedBaseUrl, latestBaseUrl }) => {
    const debugDisabledResponse = await fetch(`${publishedBaseUrl}/measured-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'off' }),
    });

    assert.equal(debugDisabledResponse.ok, true);
    assert.equal(debugDisabledResponse.headers.get('x-workflow-resolve-ms'), null);
    assert.equal(debugDisabledResponse.headers.get('x-workflow-materialize-ms'), null);
    assert.equal(debugDisabledResponse.headers.get('x-workflow-execute-ms'), null);
    assert.equal(debugDisabledResponse.headers.get('x-workflow-cache'), null);

    await withEnvOverride('RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS', 'true', async () => {
      const publishedResponse = await fetch(`${publishedBaseUrl}/measured-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'published' }),
      });
      assert.equal(publishedResponse.ok, true);
      assert.match(publishedResponse.headers.get('x-workflow-resolve-ms') ?? '', /^\d+$/);
      assert.match(publishedResponse.headers.get('x-workflow-materialize-ms') ?? '', /^\d+$/);
      assert.match(publishedResponse.headers.get('x-workflow-execute-ms') ?? '', /^\d+$/);
      assert.equal(publishedResponse.headers.get('x-workflow-cache'), 'hit');

      const latestResponse = await fetch(`${latestBaseUrl}/measured-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'latest' }),
      });
      assert.equal(latestResponse.ok, true);
      assert.match(latestResponse.headers.get('x-workflow-resolve-ms') ?? '', /^\d+$/);
      assert.match(latestResponse.headers.get('x-workflow-materialize-ms') ?? '', /^\d+$/);
      assert.match(latestResponse.headers.get('x-workflow-execute-ms') ?? '', /^\d+$/);
      assert.equal(latestResponse.headers.get('x-workflow-cache'), 'hit');
    });
  });
});

test('filesystem execution cache rebuilds lazily after project-affecting mutations', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'WarmFilesystemExecution');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'warm-filesystem-endpoint',
  });

  await withEnvOverride('RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS', 'true', async () => {
    await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl, latestBaseUrl }) => {
      const firstPublishedResponse = await fetch(`${publishedBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'published-warm' }),
      });
      assert.equal(firstPublishedResponse.ok, true);
      assert.equal(firstPublishedResponse.headers.get('x-workflow-cache'), 'hit');

      const firstLatestResponse = await fetch(`${latestBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'latest-warm' }),
      });
      assert.equal(firstLatestResponse.ok, true);
      assert.equal(firstLatestResponse.headers.get('x-workflow-cache'), 'hit');

      const createdProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${apiBaseUrl}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Filesystem Mutation One' }),
      }));
      assert.equal(typeof createdProject.project.relativePath, 'string');

      const publishedMissResponse = await fetch(`${publishedBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'published-miss' }),
      });
      assert.equal(publishedMissResponse.ok, true);
      assert.equal(publishedMissResponse.headers.get('x-workflow-cache'), 'miss');

      const publishedHitResponse = await fetch(`${publishedBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'published-hit' }),
      });
      assert.equal(publishedHitResponse.ok, true);
      assert.equal(publishedHitResponse.headers.get('x-workflow-cache'), 'hit');

      const uploadedProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${apiBaseUrl}/projects/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderRelativePath: '',
          fileName: 'filesystem-mutation-two.rivet-project',
          contents: await fs.readFile(created.absolutePath, 'utf8'),
        }),
      }));
      assert.equal(typeof uploadedProject.project.relativePath, 'string');

      const latestMissResponse = await fetch(`${latestBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'latest-miss' }),
      });
      assert.equal(latestMissResponse.ok, true);
      assert.equal(latestMissResponse.headers.get('x-workflow-cache'), 'miss');

      const latestHitResponse = await fetch(`${latestBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'latest-hit' }),
      });
      assert.equal(latestHitResponse.ok, true);
      assert.equal(latestHitResponse.headers.get('x-workflow-cache'), 'hit');
    });
  });
});

test('filesystem saveHostedProject refreshes latest materialization without dirtying the endpoint index', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'LatestSaveRefresh');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'latest-save-refresh-endpoint',
  });

  await withEnvOverride('RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS', 'true', async () => {
    await workflowStorageBackend.initializeWorkflowStorage();

    const beforeProject = await workflowStorageBackend.resolveLatestExecutionProject('latest-save-refresh-endpoint');
    assert.ok(beforeProject);
    assert.equal(beforeProject.debug?.cacheStatus, 'hit');
    assert.equal(beforeProject.project.metadata.title, 'LatestSaveRefresh');
    assert.equal(beforeProject.project.graphs[beforeProject.project.metadata.mainGraphId!]?.metadata?.name, 'Main Graph');

    const loaded = await workflowStorageBackend.loadHostedProject(created.absolutePath);
    await workflowStorageBackend.saveHostedProject({
      projectPath: created.absolutePath,
      contents: loaded.contents.replace('name: "Main Graph"', 'name: "Updated Main Graph"'),
      datasetsContents: loaded.datasetsContents,
    });

    const afterProject = await workflowStorageBackend.resolveLatestExecutionProject('latest-save-refresh-endpoint');
    assert.ok(afterProject);
    assert.equal(afterProject.debug?.cacheStatus, 'hit');
    assert.equal(afterProject.project.metadata.title, 'LatestSaveRefresh');
    assert.equal(afterProject.project.graphs[afterProject.project.metadata.mainGraphId!]?.metadata?.name, 'Updated Main Graph');

    const followupProject = await workflowStorageBackend.resolveLatestExecutionProject('latest-save-refresh-endpoint');
    assert.ok(followupProject);
    assert.equal(followupProject.debug?.cacheStatus, 'hit');
    assert.equal(followupProject.project.metadata.title, 'LatestSaveRefresh');
    assert.equal(followupProject.project.graphs[followupProject.project.metadata.mainGraphId!]?.metadata?.name, 'Updated Main Graph');
  });
});

test('filesystem saveHostedProject exposes a permission error when the workflows root is not writable', async (t) => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PermissionSave');
  const loaded = await workflowStorageBackend.loadHostedProject(created.absolutePath);
  const originalWriteFile = fs.writeFile;

  t.mock.method(fs, 'writeFile', async (
    targetPath: Parameters<typeof fs.writeFile>[0],
    data: Parameters<typeof fs.writeFile>[1],
    options?: Parameters<typeof fs.writeFile>[2],
  ) => {
    if (String(targetPath) === created.absolutePath) {
      const error = new Error(`EACCES: permission denied, open '${created.absolutePath}'`) as Error & { code?: string };
      error.code = 'EACCES';
      throw error;
    }

    return originalWriteFile(targetPath, data, options as any);
  });

  await assert.rejects(
    workflowStorageBackend.saveHostedProject({
      projectPath: created.absolutePath,
      contents: loaded.contents.replace('title: "PermissionSave"', 'title: "PermissionSave Updated"'),
      datasetsContents: loaded.datasetsContents,
    }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 500);
      assert.equal((error as { expose?: boolean }).expose, true);
      assert.match(
        String((error as { message?: string }).message ?? ''),
        /Workflow storage is not writable/,
      );
      return true;
    },
  );
});

test('filesystem latest execution follows the draft endpoint after publish settings diverge', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DraftLatestBackend');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'draft-latest-backend-published',
  });

  await withEnvOverride('RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS', 'true', async () => {
    await workflowStorageBackend.initializeWorkflowStorage();

    const settingsPath = workflowFs.getWorkflowProjectSettingsPath(created.absolutePath);
    const settings = await workflowPublication.readStoredWorkflowProjectSettings(created.absolutePath, created.name);
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify({
        ...settings,
        endpointName: 'draft-latest-backend-current',
      }, null, 2)}\n`,
      'utf8',
    );

    const latestProject = await workflowStorageBackend.resolveLatestExecutionProject('draft-latest-backend-current');
    assert.ok(latestProject);
    assert.equal(latestProject.projectVirtualPath, created.absolutePath);
    assert.equal(latestProject.debug?.cacheStatus, 'miss');

    const staleLatestProject = await workflowStorageBackend.resolveLatestExecutionProject('draft-latest-backend-published');
    assert.equal(staleLatestProject, null);

    const publishedProject = await workflowStorageBackend.resolvePublishedExecutionProject('draft-latest-backend-published');
    assert.ok(publishedProject);
    assert.equal(publishedProject.projectVirtualPath, created.absolutePath);
  });
});

test('filesystem published execution bypasses cold when a stale live-backed candidate becomes healthy', async () => {
  const staleCandidate = await workflowMutations.createWorkflowProjectItem('', 'ExecutionStaleCandidate');
  const staleOriginalContents = await fs.readFile(staleCandidate.absolutePath, 'utf8');
  const sharedEndpoint = 'execution-shared-published-endpoint';
  const publishedStateHash = await workflowPublication.createWorkflowPublicationStateHash(
    staleCandidate.absolutePath,
    sharedEndpoint,
  );

  await workflowMutations.createWorkflowFolderItem('Nested', '');
  const healthyCandidate = await workflowMutations.createWorkflowProjectItem('Nested', 'ExecutionHealthyCandidate');
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

  await withEnvOverride('RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS', 'true', async () => {
    await workflowStorageBackend.initializeWorkflowStorage();

    const initialProject = await workflowStorageBackend.resolvePublishedExecutionProject(sharedEndpoint);
    assert.ok(initialProject);
    assert.equal(initialProject.projectVirtualPath, healthyCandidate.absolutePath);
    assert.equal(initialProject.debug?.cacheStatus, 'hit');

    await fs.writeFile(staleCandidate.absolutePath, staleOriginalContents, 'utf8');

    const bypassProject = await workflowStorageBackend.resolvePublishedExecutionProject(sharedEndpoint);
    assert.ok(bypassProject);
    assert.equal(bypassProject.projectVirtualPath, staleCandidate.absolutePath);
    assert.equal(bypassProject.debug?.cacheStatus, 'bypass');

    const rebuiltProject = await workflowStorageBackend.resolvePublishedExecutionProject(sharedEndpoint);
    assert.ok(rebuiltProject);
    assert.equal(rebuiltProject.projectVirtualPath, staleCandidate.absolutePath);
    assert.equal(rebuiltProject.debug?.cacheStatus, 'miss');

    const warmProject = await workflowStorageBackend.resolvePublishedExecutionProject(sharedEndpoint);
    assert.ok(warmProject);
    assert.equal(warmProject.projectVirtualPath, staleCandidate.absolutePath);
    assert.equal(warmProject.debug?.cacheStatus, 'hit');
  });
});

test('filesystem execution helpers do not recreate the workflows root on the warm path', async (t) => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'WarmExecutionRoot');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'warm-execution-root-endpoint',
  });

  await workflowStorageBackend.initializeWorkflowStorage();

  const originalMkdir = fs.mkdir.bind(fs);
  const mkdirTargets: string[] = [];

  t.mock.method(fs, 'mkdir', async (dirPath: any, options?: any) => {
    mkdirTargets.push(String(dirPath));
    return originalMkdir(dirPath, options);
  });

  const publishedProject = await workflowStorageBackend.resolvePublishedExecutionProject('warm-execution-root-endpoint');
  assert.ok(publishedProject);
  assert.equal(publishedProject.debug?.cacheStatus, 'hit');

  const latestProject = await workflowStorageBackend.resolveLatestExecutionProject('warm-execution-root-endpoint');
  assert.ok(latestProject);
  assert.equal(latestProject.debug?.cacheStatus, 'hit');

  const referenceLoader = await workflowStorageBackend.createExecutionProjectReferenceLoader(created.absolutePath);
  assert.equal(typeof referenceLoader.loadProject, 'function');

  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  await workflowStorageBackend.persistWorkflowExecutionRecordingWithBackend({
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'warm-execution-root-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'warm-execution-root-recording',
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

  assert.deepEqual(
    mkdirTargets.filter((target) => target === workflowsRoot || target === workflowFs.getPublishedSnapshotsRoot(workflowsRoot)),
    [],
  );
});

test('filesystem execution resolution recreates a missing workflows root once and preserves not-found semantics', async () => {
  await workflowStorageBackend.initializeWorkflowStorage();

  await fs.rm(workflowsRoot, { recursive: true, force: true });
  filesystemExecutionCache.resetFilesystemExecutionCacheForTests();

  const publishedProject = await workflowStorageBackend.resolvePublishedExecutionProject('missing-endpoint');
  assert.equal(publishedProject, null);
  assert.equal(await workflowFs.pathExists(workflowsRoot), true);
  assert.equal(await workflowFs.pathExists(workflowFs.getPublishedSnapshotsRoot(workflowsRoot)), true);

  await fs.rm(workflowsRoot, { recursive: true, force: true });
  filesystemExecutionCache.resetFilesystemExecutionCacheForTests();

  const latestProject = await workflowStorageBackend.resolveLatestExecutionProject('missing-endpoint');
  assert.equal(latestProject, null);
  assert.equal(await workflowFs.pathExists(workflowsRoot), true);
  assert.equal(await workflowFs.pathExists(workflowFs.getPublishedSnapshotsRoot(workflowsRoot)), true);
});

test('published workflow responds with any outputs and records the run asynchronously', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'AnyResponse');
  const passthroughProject = await fs.readFile(
    new URL('../../../../rivet/packages/node/test/test-graphs.rivet-project', import.meta.url),
    'utf8',
  );

  await fs.writeFile(
    created.absolutePath,
    passthroughProject
      .replace('    title: Untitled Project', [
        '    title: Untitled Project',
        '    mainGraphId: kqaNrBo0WpJ1EOc2hj0zK',
      ].join('\n'))
      .replaceAll('dataType: string', 'dataType: any'),
    'utf8',
  );

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'any-response-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    const response = await fetch(`${publishedBaseUrl}/any-response-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(response.ok, true);

    const body = await response.json() as { foo: string; durationMs: number };
    assert.equal(body.foo, 'bar');
    assert.equal(typeof body.durationMs, 'number');

    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === 1,
    ) as {
      workflows: Array<{ totalRuns: number }>;
    };

    assert.equal(workflowsResponse.workflows.length, 1);
    assert.equal(workflowsResponse.workflows[0]?.totalRuns, 1);
  });
});

test('published and latest workflows inject request headers into context', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'HeadersContext');
  await writeHeadersContextEchoProject(created.absolutePath, 'HeadersContext');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'headers-context-endpoint',
  });

  await withWorkflowExecutionServer(async ({ publishedBaseUrl, latestBaseUrl }) => {
    const requestHeaders = {
      'Content-Type': 'application/json',
      'X-Storyteller-Header': 'published-request-header',
    };

    const publishedResponse = await fetch(`${publishedBaseUrl}/headers-context-endpoint`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ ignored: true }),
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(publishedResponse.ok, true);

    const publishedBody = await publishedResponse.json() as Record<string, unknown>;
    assert.equal(publishedBody['x-storyteller-header'], 'published-request-header');
    assert.equal(publishedBody['content-type'], 'application/json');
    assert.equal(typeof publishedBody.durationMs, 'number');

    const latestResponse = await fetch(`${latestBaseUrl}/headers-context-endpoint`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ ignored: true }),
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(latestResponse.ok, true);

    const latestBody = await latestResponse.json() as Record<string, unknown>;
    assert.equal(latestBody['x-storyteller-header'], 'published-request-header');
    assert.equal(latestBody['content-type'], 'application/json');
    assert.equal(typeof latestBody.durationMs, 'number');
  });
});

test('published workflow preserves falsy top-level JSON inputs and null any outputs', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'AnyFalsyResponse');
  const passthroughProject = await fs.readFile(
    new URL('../../../../rivet/packages/node/test/test-graphs.rivet-project', import.meta.url),
    'utf8',
  );

  await fs.writeFile(
    created.absolutePath,
    passthroughProject
      .replace('    title: Untitled Project', [
        '    title: Untitled Project',
        '    mainGraphId: kqaNrBo0WpJ1EOc2hj0zK',
      ].join('\n'))
      .replaceAll('dataType: string', 'dataType: any'),
    'utf8',
  );

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'any-falsy-response-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    const cases: Array<false | 0 | '' | null> = [false, 0, '', null];

    for (const value of cases) {
      const response = await fetch(`${publishedBaseUrl}/any-falsy-response-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
        signal: AbortSignal.timeout(5000),
      });

      assert.equal(response.ok, true);
      assert.ok(response.headers.get('x-duration-ms'));
      assert.deepEqual(await response.json(), value);
    }

    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === cases.length,
    ) as {
      workflows: Array<{ totalRuns: number }>;
    };

    assert.equal(workflowsResponse.workflows.length, 1);
    assert.equal(workflowsResponse.workflows[0]?.totalRuns, cases.length);
  });
});

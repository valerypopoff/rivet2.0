import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { loadProjectAndAttachedDataFromString, serializeProject, type ProjectId } from '@valerypopoff/rivet2-node';

import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import {
  ManagedWorkflowExecutionCache,
  type ManagedWorkflowRunKind,
} from '../routes/workflows/managed/execution-cache.js';
import { ManagedWorkflowExecutionInvalidationController } from '../routes/workflows/managed/execution-invalidation.js';
import { ManagedWorkflowExecutionService } from '../routes/workflows/managed/execution-service.js';
import { getManagedWorkflowProjectVirtualPath } from '../routes/workflows/virtual-paths.js';
import { createDeferred, FakeListener } from './helpers/managed-backend-harness.js';
import type {
  ManagedExecutionPointerLookupResult,
  ManagedExecutionRevisionRecord,
  ManagedExecutionWorkflowRecord,
  ManagedWebAppAccessPolicy,
} from '../routes/workflows/managed/execution-types.js';

function createControllerFixture() {
  const listener = new FakeListener();
  const controller = new ManagedWorkflowExecutionInvalidationController({
    databaseConnectionConfig: {},
    withManagedDbRetry: async (_scope, run) => run(),
    invalidateWorkflowEndpointPointers: () => {},
    clearEndpointPointers: () => {},
    createListener: () => listener,
    scheduleReconnect: () => ({}),
  });

  return {
    controller,
    listener,
  };
}

function createExecutionServiceFixture(options: {
  resolveExecutionPointerFromDatabase?: (
    runKind: ManagedWorkflowRunKind,
    lookupName: string,
  ) => Promise<ManagedExecutionPointerLookupResult | null>;
  resolveWebAppAccessPolicy?: (lookupName: string) => Promise<ManagedWebAppAccessPolicy | null>;
  getWorkflowByRelativePath?: (relativePath: string) => Promise<ManagedExecutionWorkflowRecord | null>;
  getWorkflowById?: (workflowId: string) => Promise<ManagedExecutionWorkflowRecord | null>;
  getRevision?: (revisionId: string | null | undefined) => Promise<ManagedExecutionRevisionRecord | null>;
  readRevisionContents?: (
    revision: ManagedExecutionRevisionRecord,
  ) => Promise<{ contents: string; datasetsContents: string | null }>;
}) {
  const cache = new ManagedWorkflowExecutionCache();
  const { controller, listener } = createControllerFixture();
  const projectContents = createBlankProjectFile('Managed Cache');
  const workflow: ManagedExecutionWorkflowRecord = {
    workflow_id: 'workflow-a',
    relative_path: 'Managed Cache.rivet-project',
    current_draft_revision_id: 'revision-a',
    published_revision_id: 'revision-a',
  };
  const revision: ManagedExecutionRevisionRecord = {
    revision_id: 'revision-a',
    workflow_id: 'workflow-a',
    project_blob_key: 'project-blob',
    dataset_blob_key: null,
    created_at: new Date(),
  };
  let resolveCount = 0;
  let resolveWebAppAccessPolicyCount = 0;
  let readRevisionContentsCount = 0;
  let getWorkflowByRelativePathCount = 0;
  let getWorkflowByIdCount = 0;
  const context: ManagedWorkflowExecutionContextFixture = {
    pool: {} as Pool,
    blobStore: {
      async getText() {
        throw new Error('Unexpected blob-store read');
      },
    },
    executionCache: cache,
    executionInvalidationController: controller,
    queries: {
      getWorkflowByRelativePath: async (_client, relativePath) => {
        getWorkflowByRelativePathCount += 1;
        return options.getWorkflowByRelativePath
          ? options.getWorkflowByRelativePath(relativePath)
          : relativePath === workflow.relative_path
            ? workflow
            : null;
      },
      getWorkflowById: async (_client, workflowId) => {
        getWorkflowByIdCount += 1;
        return options.getWorkflowById
          ? options.getWorkflowById(workflowId)
          : workflowId === workflow.workflow_id
            ? workflow
            : null;
      },
      getRevision: async (_client, revisionId) =>
        options.getRevision ? options.getRevision(revisionId) : revisionId === revision.revision_id ? revision : null,
      resolveExecutionPointerFromDatabase: async (_client, runKind, lookupName) => {
        resolveCount += 1;
        return options.resolveExecutionPointerFromDatabase
          ? options.resolveExecutionPointerFromDatabase(runKind, lookupName)
          : {
              pointer: {
                workflowId: workflow.workflow_id,
                relativePath: workflow.relative_path,
                revisionId: revision.revision_id,
              },
              revision,
            };
      },
      resolveWebAppAccessPolicyFromDatabase: async (_client, lookupName) => {
        resolveWebAppAccessPolicyCount += 1;
        return options.resolveWebAppAccessPolicy
          ? options.resolveWebAppAccessPolicy(lookupName)
          : {
              relativePath: workflow.relative_path,
              uiGraphId: 'ui-graph-a',
              allowedEmails: ['user@example.com'],
              appId: 'web-app-a',
            };
      },
    },
    revisions: {
      readRevisionContents: async (loadedRevision) => {
        readRevisionContentsCount += 1;
        return options.readRevisionContents
          ? options.readRevisionContents(loadedRevision)
          : {
              contents: projectContents,
              datasetsContents: null,
            };
      },
    },
  };

  const service = new ManagedWorkflowExecutionService({
    context,
  });

  return {
    cache,
    controller,
    listener,
    service,
    workflow,
    revision,
    projectContents,
    get resolveCount() {
      return resolveCount;
    },
    get resolveWebAppAccessPolicyCount() {
      return resolveWebAppAccessPolicyCount;
    },
    get readRevisionContentsCount() {
      return readRevisionContentsCount;
    },
    get getWorkflowByRelativePathCount() {
      return getWorkflowByRelativePathCount;
    },
    get getWorkflowByIdCount() {
      return getWorkflowByIdCount;
    },
  };
}

type ManagedWorkflowExecutionContextFixture = Pick<
  {
    pool: Pool;
    blobStore: {
      getText(key: string): Promise<string>;
    };
    executionCache: ManagedWorkflowExecutionCache;
    executionInvalidationController: ManagedWorkflowExecutionInvalidationController;
  },
  'pool' | 'blobStore' | 'executionCache' | 'executionInvalidationController'
> & {
  queries: {
    getWorkflowByRelativePath(client: Pool, relativePath: string): Promise<ManagedExecutionWorkflowRecord | null>;
    getWorkflowById(client: Pool, workflowId: string): Promise<ManagedExecutionWorkflowRecord | null>;
    getRevision(client: Pool, revisionId: string | null | undefined): Promise<ManagedExecutionRevisionRecord | null>;
    resolveExecutionPointerFromDatabase(
      client: Pool,
      runKind: ManagedWorkflowRunKind,
      lookupName: string,
    ): Promise<ManagedExecutionPointerLookupResult | null>;
    resolveWebAppAccessPolicyFromDatabase(client: Pool, lookupName: string): Promise<ManagedWebAppAccessPolicy | null>;
  };
  revisions: {
    readRevisionContents(
      revision: ManagedExecutionRevisionRecord,
    ): Promise<{ contents: string; datasetsContents: string | null }>;
  };
};

test('warm pointer hit does not re-run joined DB resolution', async () => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();

  const first = await fixture.service.loadPublishedExecutionProject('hello-world');
  const second = await fixture.service.loadPublishedExecutionProject('hello-world');

  assert.ok(first);
  assert.ok(second);
  assert.equal(fixture.resolveCount, 1);
  assert.equal(fixture.readRevisionContentsCount, 1);
});

test('public workflow lookup sees committed access changes before cache invalidation arrives', async () => {
  let access: 'public' | 'internal' = 'public';
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => ({
      pointer: {
        workflowId: 'workflow-a',
        relativePath: 'Managed Cache.rivet-project',
        revisionId: 'revision-a',
        endpointAccess: access,
      },
      revision: {
        revision_id: 'revision-a',
        workflow_id: 'workflow-a',
        project_blob_key: 'project-blob',
        dataset_blob_key: null,
        created_at: new Date(),
      },
    }),
  });
  await fixture.controller.initialize();

  assert.equal((await fixture.service.loadPublishedExecutionProject('hello-world'))?.endpointAccess, 'public');
  assert.equal((await fixture.service.loadLatestExecutionProject('hello-world'))?.endpointAccess, 'public');
  access = 'internal';
  assert.equal((await fixture.service.loadPublishedExecutionProject('hello-world'))?.endpointAccess, 'public');
  assert.equal((await fixture.service.loadLatestExecutionProject('hello-world'))?.endpointAccess, 'public');
  assert.equal((await fixture.service.loadPublishedExecutionProject('hello-world', true))?.endpointAccess, 'internal');
  assert.equal((await fixture.service.loadLatestExecutionProject('hello-world', true))?.endpointAccess, 'internal');
  assert.equal(fixture.resolveCount, 4);
  assert.equal(fixture.readRevisionContentsCount, 1);
});

test('fresh public lookups do not join a pre-change lookup still in flight', async () => {
  const oldLookup = createDeferred<ManagedExecutionPointerLookupResult>();
  let lookupCount = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      lookupCount += 1;
      if (lookupCount === 1) return oldLookup.promise;
      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
          endpointAccess: 'internal',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();

  const beforeChange = fixture.service.loadPublishedExecutionProject('hello-world', true);
  const afterChange = fixture.service.loadPublishedExecutionProject('hello-world', true);
  assert.equal((await afterChange)?.endpointAccess, 'internal');
  oldLookup.resolve({
    pointer: {
      workflowId: 'workflow-a',
      relativePath: 'Managed Cache.rivet-project',
      revisionId: 'revision-a',
      endpointAccess: 'public',
    },
    revision: fixture.revision,
  });
  assert.equal((await beforeChange)?.endpointAccess, 'public');
  assert.equal(lookupCount, 2);
});

test('reads current web app access policy without loading an executable revision', async () => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();

  const policy = await fixture.service.resolveWebAppAccessPolicy('app-slug');

  assert.deepEqual(policy, {
    relativePath: 'Managed Cache.rivet-project',
    uiGraphId: 'ui-graph-a',
    allowedEmails: ['user@example.com'],
    appId: 'web-app-a',
  });
  assert.equal(fixture.resolveWebAppAccessPolicyCount, 1);
  assert.equal(fixture.resolveCount, 0);
  assert.equal(fixture.readRevisionContentsCount, 0);
});

test('service forwards the correct run kind for workflow and web app endpoint resolution', async () => {
  const observedCalls: Array<{ runKind: ManagedWorkflowRunKind; lookupName: string }> = [];
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async (runKind, lookupName) => {
      observedCalls.push({ runKind, lookupName });
      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
          webAppUiGraphId: runKind === 'web-app' || runKind === 'latest-web-app' ? 'ui-graph-a' : undefined,
          webAppId: runKind === 'web-app' || runKind === 'latest-web-app' ? 'published-app-a' : undefined,
        },
        revision: {
          revision_id: 'revision-a',
          workflow_id: 'workflow-a',
          project_blob_key: 'project-blob',
          dataset_blob_key: null,
          created_at: new Date(),
        },
      };
    },
  });
  await fixture.controller.initialize();

  const published = await fixture.service.loadPublishedExecutionProject('public-live');
  const latest = await fixture.service.loadLatestExecutionProject('latest-only');
  const webApp = await fixture.service.loadPublishedWebAppExecutionProject('app-slug');
  const latestWebApp = await fixture.service.loadLatestWebAppExecutionProject('app-slug-latest');

  assert.ok(published);
  assert.ok(latest);
  assert.ok(webApp);
  assert.ok(latestWebApp);
  assert.equal(webApp.webAppUiGraphId, 'ui-graph-a');
  assert.equal(webApp.webAppBindingId, 'managed:published-app-a');
  assert.equal(latestWebApp.webAppUiGraphId, 'ui-graph-a');
  assert.equal(latestWebApp.webAppBindingId, 'managed:published-app-a');
  assert.deepEqual(observedCalls, [
    { runKind: 'published', lookupName: 'public-live' },
    { runKind: 'latest', lookupName: 'latest-only' },
    { runKind: 'web-app', lookupName: 'app-slug' },
    { runKind: 'latest-web-app', lookupName: 'app-slug-latest' },
  ]);
});

test('pointer misses are not cached as null', async () => {
  let callCount = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      callCount += 1;
      if (callCount === 1) {
        return null;
      }

      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: {
          revision_id: 'revision-a',
          workflow_id: 'workflow-a',
          project_blob_key: 'project-blob',
          dataset_blob_key: null,
          created_at: new Date(),
        },
      };
    },
  });
  await fixture.controller.initialize();

  assert.equal(await fixture.service.loadPublishedExecutionProject('hello-world'), null);
  assert.ok(await fixture.service.loadPublishedExecutionProject('hello-world'));
  assert.equal(callCount, 2);
});

test('post-invalidation requests do not join a pre-invalidation endpoint miss', async () => {
  const firstResolve = createDeferred<ManagedExecutionPointerLookupResult>();
  let resolveInvocation = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      resolveInvocation += 1;
      if (resolveInvocation === 1) {
        return firstResolve.promise;
      }

      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();

  const firstLoad = fixture.service.loadPublishedExecutionProject('hello-world');
  fixture.controller.markWorkflowChanged('workflow-a');
  const secondLoad = fixture.service.loadPublishedExecutionProject('hello-world');

  firstResolve.resolve({
    pointer: {
      workflowId: 'workflow-a',
      relativePath: 'Managed Cache.rivet-project',
      revisionId: 'revision-a',
    },
    revision: fixture.revision,
  });

  await Promise.allSettled([firstLoad, secondLoad]);
  assert.equal(resolveInvocation >= 2, true);
});

test('unrelated workflow churn does not force retry after the workflow id is already known', async () => {
  const fixture = createExecutionServiceFixture({
    readRevisionContents: async (revision) => {
      fixture.controller.markWorkflowChanged('workflow-b');
      return {
        contents: fixture.projectContents,
        datasetsContents: null,
      };
    },
  });
  await fixture.controller.initialize();

  const result = await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.ok(result);
  assert.equal(fixture.resolveCount, 1);
});

test('same-workflow change during resolve retries correctly', async () => {
  let resolveInvocation = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      resolveInvocation += 1;
      if (resolveInvocation === 1) {
        fixture.controller.markWorkflowChanged('workflow-a');
      }

      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();

  const result = await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.ok(result);
  assert.equal(resolveInvocation, 2);
});

test('same-workflow change during materialization retries correctly', async () => {
  let readInvocation = 0;
  const fixture = createExecutionServiceFixture({
    readRevisionContents: async () => {
      readInvocation += 1;
      if (readInvocation === 1) {
        fixture.controller.markWorkflowChanged('workflow-a');
      }

      return {
        contents: fixture.projectContents,
        datasetsContents: null,
      };
    },
  });
  await fixture.controller.initialize();

  const result = await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.ok(result);
  assert.equal(fixture.resolveCount, 2);
});

test('repeated same-workflow races eventually fail instead of returning stale data', async () => {
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      fixture.controller.markWorkflowChanged('workflow-a');
      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();

  await assert.rejects(
    fixture.service.loadPublishedExecutionProject('hello-world'),
    /Workflow endpoint changed while loading\. Retry the request\./,
  );
});

test('listener-unhealthy mode bypasses pointer cache but still reuses revision materialization cache', async () => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();

  await fixture.service.loadPublishedExecutionProject('hello-world');
  fixture.listener.emitError(new Error('boom'));
  await Promise.resolve();

  await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.equal(fixture.resolveCount, 2);
  assert.equal(fixture.readRevisionContentsCount, 1);
});

test('reference loading reuses revision materialization cache once the revision id is known', async () => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();
  const loader = fixture.service.createProjectReferenceLoader();

  const currentProjectPath = getManagedWorkflowProjectVirtualPath('Main.rivet-project');
  const first = await loader.loadProject(currentProjectPath, {
    id: fixture.workflow.workflow_id,
    hintPaths: ['./Managed Cache.rivet-project'],
    title: 'Managed Cache',
  });
  const second = await loader.loadProject(currentProjectPath, {
    id: fixture.workflow.workflow_id,
    hintPaths: ['./Managed Cache.rivet-project'],
    title: 'Managed Cache',
  });

  assert.equal(first.metadata.title, second.metadata.title);
  assert.equal(fixture.readRevisionContentsCount, 1);
  assert.equal(fixture.getWorkflowByRelativePathCount, 2);
});

test('reference loading propagates real operational failures after a hint resolves to a real workflow', async () => {
  const fixture = createExecutionServiceFixture({
    readRevisionContents: async () => {
      throw new Error('blob read failed');
    },
  });
  await fixture.controller.initialize();
  const loader = fixture.service.createProjectReferenceLoader();

  await assert.rejects(
    loader.loadProject(getManagedWorkflowProjectVirtualPath('Main.rivet-project'), {
      id: fixture.workflow.workflow_id,
      hintPaths: ['./Managed Cache.rivet-project'],
      title: 'Managed Cache',
    }),
    /blob read failed/,
  );
});

test('Subgraph target resolution distinguishes managed saved and published revisions', async () => {
  const [project] = loadProjectAndAttachedDataFromString(createBlankProjectFile('Saved target'));
  project.metadata.id = 'managed-subgraph-target' as ProjectId;
  const savedContents = serializeProject(project) as string;
  project.metadata.title = 'Published target';
  const publishedContents = serializeProject(project) as string;
  const workflow: ManagedExecutionWorkflowRecord = {
    workflow_id: project.metadata.id,
    relative_path: 'Components/Target.rivet-project',
    current_draft_revision_id: 'saved-revision',
    published_revision_id: 'published-revision',
  };
  const fixture = createExecutionServiceFixture({
    getWorkflowById: async (id) => (id === workflow.workflow_id ? workflow : null),
    getRevision: async (id) =>
      id
        ? {
            revision_id: id,
            workflow_id: workflow.workflow_id,
            project_blob_key: `blob-${id}`,
            dataset_blob_key: null,
            created_at: new Date(),
          }
        : null,
    readRevisionContents: async (revision) => ({
      contents: revision.revision_id === 'saved-revision' ? savedContents : publishedContents,
      datasetsContents: null,
    }),
  });
  await fixture.controller.initialize();
  const latest = await fixture.service.loadSubgraphTarget({ projectId: project.metadata.id, version: 'latest' });
  const published = await fixture.service.loadSubgraphTarget({ projectId: project.metadata.id, version: 'published' });
  assert.equal(latest.project.metadata.title, 'Saved target');
  assert.equal(published.project.metadata.title, 'Published target');
  assert.equal(latest.sourceProjectPath, getManagedWorkflowProjectVirtualPath(workflow.relative_path));
  assert.equal(fixture.getWorkflowByIdCount, 2);

  workflow.current_draft_revision_id = 'replacement-revision';
  const nextRun = await fixture.service.loadSubgraphTarget({ projectId: project.metadata.id, version: 'latest' });
  assert.equal(latest.project.metadata.title, 'Saved target');
  assert.equal(nextRun.project.metadata.title, 'Published target');
  assert.equal(nextRun.revisionKey, 'managed:replacement-revision');

  workflow.published_revision_id = null;
  await assert.rejects(
    fixture.service.loadSubgraphTarget({ projectId: project.metadata.id, version: 'published' }),
    /no published version/,
  );
});

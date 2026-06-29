import assert from 'node:assert/strict';
import test from 'node:test';

import { createManagedWorkflowCatalogService } from '../routes/workflows/managed/catalog.js';
import * as managedMappers from '../routes/workflows/managed/mappers.js';
import type { RevisionRow, WebAppPublicationRow, WorkflowRow } from '../routes/workflows/managed/types.js';

function createWorkflowRow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    workflow_id: 'workflow-managed-stats',
    name: 'Managed Stats',
    file_name: 'Managed Stats.rivet-project',
    relative_path: 'Managed Stats.rivet-project',
    folder_relative_path: '',
    updated_at: '2026-04-08T12:00:00.000Z',
    current_draft_revision_id: 'revision-managed-stats',
    published_revision_id: null,
    published_version_id: null,
    endpoint_name: '',
    published_endpoint_name: '',
    last_published_at: null,
    ...overrides,
  };
}

function createRevisionRow(workflowId: string, revisionId: string): RevisionRow {
  return {
    revision_id: revisionId,
    workflow_id: workflowId,
    project_blob_key: 'blob/project',
    dataset_blob_key: null,
    stats_graph_count: 1,
    stats_total_node_count: 2,
    stats_web_app_count: 1,
    created_at: '2026-04-08T12:00:00.000Z',
  };
}

function createWebAppPublicationRow(
  workflowId: string,
  revisionId: string,
  uiGraphId: string,
): WebAppPublicationRow {
  return {
    app_id: `app-${uiGraphId}`,
    workflow_id: workflowId,
    revision_id: revisionId,
    ui_graph_id: uiGraphId,
    slug: uiGraphId,
    slug_lookup_name: uiGraphId,
    published_at: '2026-04-08T12:00:00.000Z',
  };
}

function createCatalogForDeleteGuard(workflowRow: WorkflowRow, webAppRows: unknown[] = []) {
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      assert.match(sql, /FROM workflow_web_apps/);
      assert.deepEqual(params, [workflowRow.workflow_id]);
      return { rows: webAppRows };
    },
  };
  const hooks = {
    onCommit() {},
    onRollback() {},
  };

  return createManagedWorkflowCatalogService({
    context: {
      pool: {} as never,
      initialize: async () => {},
      withTransaction: async <T,>(
        run: (transactionClient: typeof client, transactionHooks: typeof hooks) => Promise<T>,
      ) => run(client, hooks),
      db: {
        queryOne: async () => null,
        queryRows: async () => {
          throw new Error('Unexpected queryRows after delete guard');
        },
        isUniqueViolation: () => false,
        withManagedDbRetry: async <T,>(_scope: string, run: () => Promise<T>) => run(),
        getManagedDbConnectionConfig: () => ({}),
        getManagedDbPoolConfig: () => ({}),
      },
      queries: {
        listFolderRows: async () => [],
        listWorkflowRows: async () => [],
        getWorkflowByRelativePath: async () => workflowRow,
        getWorkflowById: async () => null,
        getRevision: async () => null,
        getCurrentDraftWorkflowRevision: async () => null,
        ensureFolderChain: async () => {},
        assertFolderExists: async () => {},
        resolveExecutionPointerFromDatabase: async () => null,
      },
      revisions: {
        readRevisionProjectContents: async () => {
          throw new Error('Unexpected project blob read');
        },
        readRevisionContents: async () => {
          throw new Error('Unexpected revision read');
        },
        deleteBlobKeysBestEffort: async () => {},
      },
      endpointSync: {
        syncWorkflowEndpointRows: async () => {},
      },
      mappers: managedMappers,
      blobStore: {
        getText: async () => {
          throw new Error('Unexpected blob store access');
        },
      },
      executionCache: {} as never,
      executionInvalidationController: {
        queueWorkflowInvalidation: async () => {},
        queueGlobalInvalidation: async () => {},
      },
      dispose: async () => {},
    } as never,
    saveHostedProject: async () => {
      throw new Error('Unexpected saveHostedProject call');
    },
  });
}

test('managed workflow tree includes graph and node stats from current draft revision metadata', async () => {
  const workflowRow = createWorkflowRow();
  const revisionRow = createRevisionRow(workflowRow.workflow_id, workflowRow.current_draft_revision_id);

  const catalog = createManagedWorkflowCatalogService({
    context: {
      pool: {} as never,
      initialize: async () => {},
      withTransaction: async () => {
        throw new Error('Unexpected transaction');
      },
      db: {
        queryOne: async () => null,
        queryRows: async () => [],
        isUniqueViolation: () => false,
        withManagedDbRetry: async <T,>(_scope: string, run: () => Promise<T>) => run(),
        getManagedDbConnectionConfig: () => ({}),
        getManagedDbPoolConfig: () => ({}),
      },
      queries: {
        listFolderRows: async () => [],
        listWorkflowRows: async () => [workflowRow],
        getWorkflowByRelativePath: async () => null,
        getWorkflowById: async () => null,
        getRevision: async (_client: unknown, revisionId: string | null | undefined) =>
          revisionId === revisionRow.revision_id ? revisionRow : null,
        getCurrentDraftWorkflowRevision: async () => null,
        ensureFolderChain: async () => {},
        assertFolderExists: async () => {},
        resolveExecutionPointerFromDatabase: async () => null,
      },
      revisions: {
        readRevisionProjectContents: async () => {
          throw new Error('Unexpected project blob read');
        },
        readRevisionContents: async () => ({
          contents: '',
          datasetsContents: null,
        }),
        deleteBlobKeysBestEffort: async () => {},
      },
      endpointSync: {
        syncWorkflowEndpointRows: async () => {},
      },
      mappers: managedMappers,
      blobStore: {
        getText: async () => {
          throw new Error('Unexpected blob store access');
        },
      },
      executionCache: {} as never,
      executionInvalidationController: {
        queueWorkflowInvalidation: async () => {},
        queueGlobalInvalidation: async () => {},
      },
      dispose: async () => {},
    } as never,
    saveHostedProject: async () => {
      throw new Error('Unexpected saveHostedProject call');
    },
  });

  const tree = await catalog.getTree();

  assert.equal(tree.projects.length, 1);
  assert.equal(tree.projects[0]?.stats?.graphCount, 1);
  assert.equal(tree.projects[0]?.stats?.totalNodeCount, 2);
  assert.equal(tree.projects[0]?.stats?.webAppCount, 1);
});

test('managed workflow tree exposes aggregate endpoint and web app publication status', async () => {
  const webAppPublishedWorkflow = createWorkflowRow({
    workflow_id: 'workflow-managed-web-app-published',
    name: 'Web App Published',
    file_name: 'Web App Published.rivet-project',
    relative_path: 'Web App Published.rivet-project',
    current_draft_revision_id: 'revision-managed-web-app-published',
  });
  const staleWebAppWorkflow = createWorkflowRow({
    workflow_id: 'workflow-managed-web-app-stale',
    name: 'Web App Stale',
    file_name: 'Web App Stale.rivet-project',
    relative_path: 'Web App Stale.rivet-project',
    current_draft_revision_id: 'revision-managed-web-app-current',
    published_revision_id: 'revision-managed-web-app-current',
    published_endpoint_name: 'web-app-stale',
    endpoint_name: 'web-app-stale',
  });
  const revisions = new Map([
    [
      webAppPublishedWorkflow.current_draft_revision_id,
      createRevisionRow(webAppPublishedWorkflow.workflow_id, webAppPublishedWorkflow.current_draft_revision_id),
    ],
    [
      staleWebAppWorkflow.current_draft_revision_id,
      createRevisionRow(staleWebAppWorkflow.workflow_id, staleWebAppWorkflow.current_draft_revision_id),
    ],
  ]);
  const webAppRows = [
    createWebAppPublicationRow(
      webAppPublishedWorkflow.workflow_id,
      webAppPublishedWorkflow.current_draft_revision_id,
      'published-web-app',
    ),
    createWebAppPublicationRow(
      staleWebAppWorkflow.workflow_id,
      'revision-managed-web-app-old',
      'stale-web-app',
    ),
  ];

  const catalog = createManagedWorkflowCatalogService({
    context: {
      pool: {} as never,
      initialize: async () => {},
      withTransaction: async () => {
        throw new Error('Unexpected transaction');
      },
      db: {
        queryOne: async () => null,
        queryRows: async () => webAppRows,
        isUniqueViolation: () => false,
        withManagedDbRetry: async <T,>(_scope: string, run: () => Promise<T>) => run(),
        getManagedDbConnectionConfig: () => ({}),
        getManagedDbPoolConfig: () => ({}),
      },
      queries: {
        listFolderRows: async () => [],
        listWorkflowRows: async () => [webAppPublishedWorkflow, staleWebAppWorkflow],
        getWorkflowByRelativePath: async () => null,
        getWorkflowById: async () => null,
        getRevision: async (_client: unknown, revisionId: string | null | undefined) =>
          revisionId ? revisions.get(revisionId) ?? null : null,
        getCurrentDraftWorkflowRevision: async () => null,
        ensureFolderChain: async () => {},
        assertFolderExists: async () => {},
        resolveExecutionPointerFromDatabase: async () => null,
      },
      revisions: {
        readRevisionProjectContents: async () => {
          throw new Error('Unexpected project blob read');
        },
        readRevisionContents: async () => ({
          contents: '',
          datasetsContents: null,
        }),
        deleteBlobKeysBestEffort: async () => {},
      },
      endpointSync: {
        syncWorkflowEndpointRows: async () => {},
      },
      mappers: managedMappers,
      blobStore: {
        getText: async () => {
          throw new Error('Unexpected blob store access');
        },
      },
      executionCache: {} as never,
      executionInvalidationController: {
        queueWorkflowInvalidation: async () => {},
        queueGlobalInvalidation: async () => {},
      },
      dispose: async () => {},
    } as never,
    saveHostedProject: async () => {
      throw new Error('Unexpected saveHostedProject call');
    },
  });

  const tree = await catalog.getTree();
  const byId = new Map(tree.projects.map((project) => [project.id, project]));

  assert.equal(byId.get(webAppPublishedWorkflow.workflow_id)?.settings.status, 'unpublished');
  assert.equal(byId.get(webAppPublishedWorkflow.workflow_id)?.settings.publicationStatus, 'published');
  assert.equal(byId.get(staleWebAppWorkflow.workflow_id)?.settings.status, 'published');
  assert.equal(byId.get(staleWebAppWorkflow.workflow_id)?.settings.publicationStatus, 'unpublished_changes');
});

test('managed workflow deletion is blocked by every active publication marker', async () => {
  const cases: Array<{ name: string; workflowRow: WorkflowRow; webAppRows?: unknown[] }> = [
    {
      name: 'published revision',
      workflowRow: createWorkflowRow({ published_revision_id: 'published-revision' }),
    },
    {
      name: 'published version',
      workflowRow: createWorkflowRow({ published_version_id: 'published-version' }),
    },
    {
      name: 'published endpoint name',
      workflowRow: createWorkflowRow({ published_endpoint_name: 'published-endpoint' }),
    },
    {
      name: 'published web app',
      workflowRow: createWorkflowRow(),
      webAppRows: [{ app_id: 'published-web-app' }],
    },
  ];

  for (const { name, workflowRow, webAppRows } of cases) {
    await assert.rejects(
      () => createCatalogForDeleteGuard(workflowRow, webAppRows).deleteWorkflowProjectItem(workflowRow.relative_path),
      /Unpublish the workflow endpoint and web apps before deleting the project/,
      name,
    );
  }
});

test('managed workflow tree backfills legacy revision stats when metadata is missing', async () => {
  const workflowRow = createWorkflowRow({
    workflow_id: 'workflow-managed-legacy-stats',
    current_draft_revision_id: 'revision-managed-legacy-stats',
  });
  const revisionRow = createRevisionRow(workflowRow.workflow_id, workflowRow.current_draft_revision_id);
  revisionRow.stats_graph_count = null;
  revisionRow.stats_total_node_count = null;
  revisionRow.stats_web_app_count = null;
  const updateQueries: Array<{ sql: string; params: unknown[] }> = [];
  const projectContents = [
    'version: 4',
    'data:',
    '  metadata:',
    '    id: "legacy-stats-project"',
    '    title: "Legacy Stats"',
    '    description: ""',
    '    mainGraphId: "legacy-graph"',
    '  graphs:',
    '    "legacy-graph":',
    '      metadata:',
    '        id: "legacy-graph"',
    '        name: "Main Graph"',
    '        description: ""',
    '      nodes:',
    '        \'[node-1]:text "Node 1"\':',
    '          visualData: 0/0/null/null//',
    '          data:',
    '            text: hello',
    '  plugins: []',
    '  references: []',
    '  uiGraphs:',
    '    "ui-graph-a":',
    '      id: "ui-graph-a"',
    '      name: "Legacy App"',
    '      components: []',
    '',
  ].join('\n');

  const catalog = createManagedWorkflowCatalogService({
    context: {
      pool: {} as never,
      initialize: async () => {},
      withTransaction: async () => {
        throw new Error('Unexpected transaction');
      },
      db: {
        queryOne: async () => null,
        queryRows: async (_client: unknown, sql: string, params: unknown[] = []) => {
          if (/UPDATE workflow_revisions/.test(sql)) {
            updateQueries.push({ sql, params });
          }
          return [];
        },
        isUniqueViolation: () => false,
        withManagedDbRetry: async <T,>(_scope: string, run: () => Promise<T>) => run(),
        getManagedDbConnectionConfig: () => ({}),
        getManagedDbPoolConfig: () => ({}),
      },
      queries: {
        listFolderRows: async () => [],
        listWorkflowRows: async () => [workflowRow],
        getWorkflowByRelativePath: async () => null,
        getWorkflowById: async () => null,
        getRevision: async (_client: unknown, revisionId: string | null | undefined) =>
          revisionId === revisionRow.revision_id ? revisionRow : null,
        getCurrentDraftWorkflowRevision: async () => null,
        ensureFolderChain: async () => {},
        assertFolderExists: async () => {},
        resolveExecutionPointerFromDatabase: async () => null,
      },
      revisions: {
        readRevisionProjectContents: async () => projectContents,
        readRevisionContents: async () => ({
          contents: projectContents,
          datasetsContents: null,
        }),
        deleteBlobKeysBestEffort: async () => {},
      },
      endpointSync: {
        syncWorkflowEndpointRows: async () => {},
      },
      mappers: managedMappers,
      blobStore: {
        getText: async () => {
          throw new Error('Unexpected blob store access');
        },
      },
      executionCache: {} as never,
      executionInvalidationController: {
        queueWorkflowInvalidation: async () => {},
        queueGlobalInvalidation: async () => {},
      },
      dispose: async () => {},
    } as never,
    saveHostedProject: async () => {
      throw new Error('Unexpected saveHostedProject call');
    },
  });

  const tree = await catalog.getTree();

  assert.equal(tree.projects[0]?.stats?.graphCount, 1);
  assert.equal(tree.projects[0]?.stats?.totalNodeCount, 1);
  assert.equal(tree.projects[0]?.stats?.webAppCount, 1);
  assert.equal(updateQueries.length, 1);
  assert.match(updateQueries[0]!.sql, /UPDATE workflow_revisions/);
  assert.deepEqual(updateQueries[0]!.params, [revisionRow.revision_id, 1, 1, 1]);
});

test('managed workflow tree falls back to zero stats when the draft revision is missing', async () => {
  const workflowRow = createWorkflowRow({
    workflow_id: 'workflow-managed-stats-fallback',
    current_draft_revision_id: 'revision-managed-stats-fallback',
  });

  const catalog = createManagedWorkflowCatalogService({
    context: {
      pool: {} as never,
      initialize: async () => {},
      withTransaction: async () => {
        throw new Error('Unexpected transaction');
      },
      db: {
        queryOne: async () => null,
        queryRows: async () => [],
        isUniqueViolation: () => false,
        withManagedDbRetry: async <T,>(_scope: string, run: () => Promise<T>) => run(),
        getManagedDbConnectionConfig: () => ({}),
        getManagedDbPoolConfig: () => ({}),
      },
      queries: {
        listFolderRows: async () => [],
        listWorkflowRows: async () => [workflowRow],
        getWorkflowByRelativePath: async () => null,
        getWorkflowById: async () => null,
        getRevision: async () => null,
        getCurrentDraftWorkflowRevision: async () => null,
        ensureFolderChain: async () => {},
        assertFolderExists: async () => {},
        resolveExecutionPointerFromDatabase: async () => null,
      },
      revisions: {
        readRevisionProjectContents: async () => {
          throw new Error('blob read failed');
        },
        readRevisionContents: async () => {
          throw new Error('Unexpected full revision read');
        },
        deleteBlobKeysBestEffort: async () => {},
      },
      endpointSync: {
        syncWorkflowEndpointRows: async () => {},
      },
      mappers: managedMappers,
      blobStore: {
        getText: async () => {
          throw new Error('Unexpected blob store access');
        },
      },
      executionCache: {} as never,
      executionInvalidationController: {
        queueWorkflowInvalidation: async () => {},
        queueGlobalInvalidation: async () => {},
      },
      dispose: async () => {},
    } as never,
    saveHostedProject: async () => {
      throw new Error('Unexpected saveHostedProject call');
    },
  });

  const tree = await catalog.getTree();

  assert.equal(tree.projects.length, 1);
  assert.deepEqual(tree.projects[0]?.stats, {
    graphCount: 0,
    totalNodeCount: 0,
    webAppCount: 0,
  });
});

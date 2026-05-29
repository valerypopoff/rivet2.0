import assert from 'node:assert/strict';
import test from 'node:test';

import { createManagedWorkflowCatalogService } from '../routes/workflows/managed/catalog.js';
import * as managedMappers from '../routes/workflows/managed/mappers.js';
import type { RevisionRow, WorkflowRow } from '../routes/workflows/managed/types.js';

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
    created_at: '2026-04-08T12:00:00.000Z',
  };
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
});

test('managed workflow tree backfills legacy revision stats when metadata is missing', async () => {
  const workflowRow = createWorkflowRow({
    workflow_id: 'workflow-managed-legacy-stats',
    current_draft_revision_id: 'revision-managed-legacy-stats',
  });
  const revisionRow = createRevisionRow(workflowRow.workflow_id, workflowRow.current_draft_revision_id);
  revisionRow.stats_graph_count = null;
  revisionRow.stats_total_node_count = null;
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
          updateQueries.push({ sql, params });
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
  assert.equal(updateQueries.length, 1);
  assert.match(updateQueries[0]!.sql, /UPDATE workflow_revisions/);
  assert.deepEqual(updateQueries[0]!.params, [revisionRow.revision_id, 1, 1]);
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
  });
});

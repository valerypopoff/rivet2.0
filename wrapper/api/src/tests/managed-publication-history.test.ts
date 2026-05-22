import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';

import { resolveManagedHostedProjectSaveTarget } from '../routes/workflows/managed/backend.js';
import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import type { ManagedWorkflowDbClient } from '../routes/workflows/managed/db.js';
import * as managedMappers from '../routes/workflows/managed/mappers.js';
import { createManagedWorkflowPublicationService } from '../routes/workflows/managed/publication.js';
import type {
  PublishedVersionRow,
  RevisionRow,
  TransactionHooks,
  WorkflowRow,
} from '../routes/workflows/managed/types.js';

type QueryRecord = {
  sql: string;
  params: unknown[];
};

type EndpointSyncCall = {
  workflowId: string;
  draftEndpointName: string;
  publishedEndpointName: string;
};

const now = '2026-05-21T10:00:00.000Z';

function createWorkflow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    workflow_id: 'workflow-a',
    name: 'Main',
    file_name: 'Main.rivet-project',
    relative_path: 'Main.rivet-project',
    folder_relative_path: '',
    updated_at: now,
    current_draft_revision_id: 'draft-revision',
    published_revision_id: null,
    published_version_id: null,
    endpoint_name: 'draft-endpoint',
    published_endpoint_name: '',
    last_published_at: null,
    ...overrides,
  };
}

function createRevision(overrides: Partial<RevisionRow> = {}): RevisionRow {
  return {
    revision_id: 'draft-revision',
    workflow_id: 'workflow-a',
    project_blob_key: 'project-blob',
    dataset_blob_key: null,
    created_at: now,
    ...overrides,
  };
}

function createPublishedVersion(overrides: Partial<PublishedVersionRow> = {}): PublishedVersionRow {
  return {
    version_id: 'version-a',
    workflow_id: 'workflow-a',
    revision_id: 'revision-a',
    endpoint_name: 'published-endpoint',
    published_at: now,
    is_starred: false,
    ...overrides,
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function createPublicationHarness(options: {
  workflow?: WorkflowRow;
  workflowAfterMutation?: WorkflowRow;
  revisions?: RevisionRow[];
  publishedVersions?: PublishedVersionRow[];
} = {}) {
  const workflow = options.workflow ?? createWorkflow();
  const workflowAfterMutation = options.workflowAfterMutation ?? workflow;
  const revisions = new Map((options.revisions ?? [createRevision()]).map((revision) => [revision.revision_id, revision]));
  const publishedVersions = new Map(
    (options.publishedVersions ?? []).map((version) => [version.version_id, version]),
  );

  const clientQueries: QueryRecord[] = [];
  const queryOneCalls: QueryRecord[] = [];
  const endpointSyncCalls: EndpointSyncCall[] = [];
  const invalidationRequests: string[] = [];
  const invalidationCommits: string[] = [];
  const workflowLookups: Array<{ relativePath: string; forUpdate: boolean }> = [];
  const commitTasks: Array<() => Promise<void>> = [];
  let latestInsertedPublishedVersionId: string | null = null;

  const client = {
    async query(sql: string, params: unknown[] = []) {
      clientQueries.push({ sql, params });
      if (normalizeSql(sql).startsWith('INSERT INTO workflow_published_versions')) {
        latestInsertedPublishedVersionId = String(params[0]);
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const hooks: TransactionHooks = {
    onCommit(task) {
      commitTasks.push(task);
    },
    onRollback() {},
  };

  async function queryOne<T>(
    _client: ManagedWorkflowDbClient,
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    queryOneCalls.push({ sql, params });
    const normalized = normalizeSql(sql);

    if (normalized.startsWith('SELECT version_id') && normalized.includes('FROM workflow_published_versions')) {
      return (publishedVersions.get(String(params[1])) ?? null) as T | null;
    }

    if (normalized.startsWith('UPDATE workflow_published_versions')) {
      const version = publishedVersions.get(String(params[1]));
      return version ? { ...version, is_starred: params[2] === true } as T : null;
    }

    if (normalized.startsWith('INSERT INTO workflow_published_versions')) {
      latestInsertedPublishedVersionId = String(params[0]);
      return createPublishedVersion({
        version_id: String(params[0]),
        workflow_id: String(params[1]),
        revision_id: String(params[2]),
        endpoint_name: String(params[3]),
        is_starred: params[5] === true,
      }) as T;
    }

    return null;
  }

  const context = {
    pool: {} as Pool,
    initialize: async () => {},
    withTransaction: async <T>(run: (transactionClient: PoolClient, transactionHooks: TransactionHooks) => Promise<T>) => {
      const result = await run(client, hooks);
      for (const task of commitTasks) {
        await task();
      }
      return result;
    },
    db: {
      queryRows: async () => [],
      queryOne,
    },
    queries: {
      getWorkflowByRelativePath: async (
        _client: ManagedWorkflowDbClient,
        relativePath: string,
        lookupOptions: { forUpdate?: boolean } = {},
      ) => {
        workflowLookups.push({
          relativePath,
          forUpdate: lookupOptions.forUpdate === true,
        });
        if (workflowLookups.length === 1) {
          return workflow;
        }

        return latestInsertedPublishedVersionId
          ? {
            ...workflowAfterMutation,
            published_version_id: latestInsertedPublishedVersionId,
          }
          : workflowAfterMutation;
      },
      getRevision: async (_client: ManagedWorkflowDbClient, revisionId: string | null | undefined) => {
        return revisionId ? revisions.get(revisionId) ?? null : null;
      },
    },
    revisions: {
      readRevisionContents: async (revision: RevisionRow) => ({
        contents: `project:${revision.revision_id}`,
        datasetsContents: revision.dataset_blob_key ? `dataset:${revision.revision_id}` : null,
      }),
      readRevisionProjectContents: async (revision: RevisionRow) => `project:${revision.revision_id}`,
    },
    endpointSync: {
      syncWorkflowEndpointRows: async (
        _client: PoolClient,
        syncedWorkflow: WorkflowRow,
        settings: { draftEndpointName: string; publishedEndpointName: string },
      ) => {
        endpointSyncCalls.push({
          workflowId: syncedWorkflow.workflow_id,
          draftEndpointName: settings.draftEndpointName,
          publishedEndpointName: settings.publishedEndpointName,
        });
      },
    },
    mappers: managedMappers,
    executionInvalidationController: {
      queueWorkflowInvalidation: async (
        _client: ManagedWorkflowDbClient,
        transactionHooks: TransactionHooks,
        workflowId: string,
      ) => {
        invalidationRequests.push(workflowId);
        transactionHooks.onCommit(async () => {
          invalidationCommits.push(workflowId);
        });
      },
    },
  } as unknown as ManagedWorkflowContext;

  return {
    service: createManagedWorkflowPublicationService({ context }),
    clientQueries,
    queryOneCalls,
    endpointSyncCalls,
    invalidationRequests,
    invalidationCommits,
  };
}

test('managed publication backfills legacy current versions before new publishes', async () => {
  const legacyPublishedAt = '2026-05-20T08:30:00.000Z';
  const workflow = createWorkflow({
    current_draft_revision_id: 'draft-revision',
    published_revision_id: 'legacy-published-revision',
    published_version_id: null,
    endpoint_name: 'old-draft',
    published_endpoint_name: 'old-published',
    last_published_at: legacyPublishedAt,
  });
  const workflowAfterMutation = createWorkflow({
    current_draft_revision_id: 'draft-revision',
    published_revision_id: 'draft-revision',
    published_version_id: 'new-version',
    endpoint_name: 'new-endpoint',
    published_endpoint_name: 'new-endpoint',
    last_published_at: now,
  });
  const { service, clientQueries, queryOneCalls, endpointSyncCalls, invalidationRequests, invalidationCommits } =
    createPublicationHarness({
      workflow,
      workflowAfterMutation,
      revisions: [
        createRevision({ revision_id: 'draft-revision' }),
        createRevision({ revision_id: 'legacy-published-revision' }),
      ],
    });

  const project = await service.publishWorkflowProjectItem('Main.rivet-project', {
    endpointName: 'new-endpoint',
  });

  const publishedVersionInserts = [...clientQueries, ...queryOneCalls].filter((query) =>
    normalizeSql(query.sql).startsWith('INSERT INTO workflow_published_versions'));
  assert.equal(publishedVersionInserts.length, 2);
  assert.deepEqual(publishedVersionInserts[0]?.params, [
    'legacy-published-revision',
    'workflow-a',
    'legacy-published-revision',
    'old-published',
    legacyPublishedAt,
  ]);
  assert.equal(publishedVersionInserts[1]?.params[1], 'workflow-a');
  assert.equal(publishedVersionInserts[1]?.params[2], 'draft-revision');
  assert.equal(publishedVersionInserts[1]?.params[3], 'new-endpoint');
  assert.deepEqual(endpointSyncCalls, [{
    workflowId: 'workflow-a',
    draftEndpointName: 'new-endpoint',
    publishedEndpointName: 'new-endpoint',
  }]);
  assert.deepEqual(invalidationRequests, ['workflow-a']);
  assert.deepEqual(invalidationCommits, ['workflow-a']);
  assert.equal(project.settings.status, 'published');
});

test('managed published version restore republishes a stored revision as a new current history entry', async () => {
  const selectedVersion = createPublishedVersion({
    version_id: 'old-version',
    revision_id: 'old-revision',
    endpoint_name: 'restore-endpoint',
  });
  const { service, clientQueries, endpointSyncCalls, invalidationRequests, invalidationCommits } = createPublicationHarness({
    workflow: createWorkflow({
      current_draft_revision_id: 'current-revision',
      published_revision_id: 'current-revision',
      published_version_id: 'current-version',
      endpoint_name: 'current-endpoint',
      published_endpoint_name: 'current-endpoint',
    }),
    workflowAfterMutation: createWorkflow({
      current_draft_revision_id: 'old-revision',
      published_revision_id: 'old-revision',
      published_version_id: 'restored-version',
      endpoint_name: 'restore-endpoint',
      published_endpoint_name: 'restore-endpoint',
      last_published_at: now,
    }),
    revisions: [
      createRevision({ revision_id: 'current-revision' }),
      createRevision({ revision_id: 'old-revision' }),
    ],
    publishedVersions: [selectedVersion],
  });

  const result = await service.restoreWorkflowPublishedVersion('Main.rivet-project', 'old-version');

  assert.notEqual(result.version.id, 'old-version');
  assert.equal(result.version.projectId, 'workflow-a');
  assert.equal(result.version.endpointName, 'restore-endpoint');
  assert.equal(result.version.isCurrent, true);
  assert.equal(result.project.settings.status, 'published');
  assert.deepEqual(endpointSyncCalls, [{
    workflowId: 'workflow-a',
    draftEndpointName: 'restore-endpoint',
    publishedEndpointName: 'restore-endpoint',
  }]);

  const workflowUpdate = clientQueries.find((query) =>
    normalizeSql(query.sql).startsWith('UPDATE workflows SET current_draft_revision_id = $2'));
  assert.ok(workflowUpdate);
  assert.deepEqual(workflowUpdate.params, [
    'workflow-a',
    'old-revision',
    result.version.id,
    'restore-endpoint',
  ]);
  assert.deepEqual(invalidationRequests, ['workflow-a']);
  assert.deepEqual(invalidationCommits, ['workflow-a']);
});

test('managed published version restore supports legacy current versions without history rows', async () => {
  const legacyPublishedAt = '2026-05-20T10:45:00.000Z';
  const { service, clientQueries, queryOneCalls, endpointSyncCalls, invalidationRequests, invalidationCommits } =
    createPublicationHarness({
      workflow: createWorkflow({
        current_draft_revision_id: 'draft-revision',
        published_revision_id: 'legacy-published-revision',
        published_version_id: null,
        endpoint_name: 'draft-endpoint',
        published_endpoint_name: 'legacy-endpoint',
        last_published_at: legacyPublishedAt,
      }),
      workflowAfterMutation: createWorkflow({
        current_draft_revision_id: 'legacy-published-revision',
        published_revision_id: 'legacy-published-revision',
        endpoint_name: 'legacy-endpoint',
        published_endpoint_name: 'legacy-endpoint',
        last_published_at: now,
      }),
      revisions: [
        createRevision({ revision_id: 'draft-revision' }),
        createRevision({ revision_id: 'legacy-published-revision' }),
      ],
    });

  const result = await service.restoreWorkflowPublishedVersion('Main.rivet-project', 'legacy-published-revision');

  assert.notEqual(result.version.id, 'legacy-published-revision');
  assert.equal(result.version.endpointName, 'legacy-endpoint');
  assert.equal(result.version.isCurrent, true);
  assert.equal(result.project.settings.status, 'published');

  const publishedVersionInserts = [...clientQueries, ...queryOneCalls].filter((query) =>
    normalizeSql(query.sql).startsWith('INSERT INTO workflow_published_versions'));
  assert.equal(publishedVersionInserts.length, 2);
  assert.deepEqual(publishedVersionInserts[0]?.params, [
    'legacy-published-revision',
    'workflow-a',
    'legacy-published-revision',
    'legacy-endpoint',
    legacyPublishedAt,
  ]);
  assert.equal(publishedVersionInserts[1]?.params[1], 'workflow-a');
  assert.equal(publishedVersionInserts[1]?.params[2], 'legacy-published-revision');
  assert.equal(publishedVersionInserts[1]?.params[3], 'legacy-endpoint');
  assert.deepEqual(endpointSyncCalls, [{
    workflowId: 'workflow-a',
    draftEndpointName: 'legacy-endpoint',
    publishedEndpointName: 'legacy-endpoint',
  }]);
  assert.deepEqual(invalidationRequests, ['workflow-a']);
  assert.deepEqual(invalidationCommits, ['workflow-a']);
});

test('managed published version stars update durable history rows', async () => {
  const { service, queryOneCalls } = createPublicationHarness({
    workflow: createWorkflow({
      published_revision_id: 'published-revision',
      published_version_id: 'version-a',
    }),
    publishedVersions: [
      createPublishedVersion({
        version_id: 'version-a',
        revision_id: 'published-revision',
        is_starred: false,
      }),
    ],
  });

  const version = await service.setWorkflowPublishedVersionStar('Main.rivet-project', 'version-a', true);

  assert.equal(version.id, 'version-a');
  assert.equal(version.isCurrent, true);
  assert.equal(version.isStarred, true);

  const updateCall = queryOneCalls.find((query) =>
    normalizeSql(query.sql).startsWith('UPDATE workflow_published_versions'));
  assert.ok(updateCall);
  assert.deepEqual(updateCall.params, ['workflow-a', 'version-a', true]);
});

test('managed legacy current version stars are persisted by creating a history row', async () => {
  const legacyPublishedAt = '2026-05-20T09:15:00.000Z';
  const { service, queryOneCalls } = createPublicationHarness({
    workflow: createWorkflow({
      published_revision_id: 'legacy-published-revision',
      published_version_id: null,
      published_endpoint_name: 'legacy-endpoint',
      last_published_at: legacyPublishedAt,
    }),
    revisions: [
      createRevision({ revision_id: 'legacy-published-revision' }),
    ],
  });

  const version = await service.setWorkflowPublishedVersionStar('Main.rivet-project', 'legacy-published-revision', true);

  assert.equal(version.id, 'legacy-published-revision');
  assert.equal(version.isCurrent, true);
  assert.equal(version.isStarred, true);

  const insertCall = queryOneCalls.find((query) =>
    normalizeSql(query.sql).startsWith('INSERT INTO workflow_published_versions'));
  assert.ok(insertCall);
  assert.deepEqual(insertCall.params, [
    'legacy-published-revision',
    'workflow-a',
    'legacy-published-revision',
    'legacy-endpoint',
    legacyPublishedAt,
    true,
  ]);
});

test('managed save target selection preserves published state and creates revisions only for real draft changes', () => {
  const cases: Array<{
    name: string;
    options: Parameters<typeof resolveManagedHostedProjectSaveTarget>[0];
    expected: ReturnType<typeof resolveManagedHostedProjectSaveTarget>;
  }> = [
    {
      name: 'published no-op save',
      options: {
        nextContents: { contents: 'project: unchanged', datasetsContents: null },
        currentDraftContents: { contents: 'project: unchanged', datasetsContents: null },
        publishedContents: { contents: 'project: unchanged', datasetsContents: null },
        draftEndpointName: 'published-endpoint',
        publishedEndpointName: 'published-endpoint',
      },
      expected: 'published-revision',
    },
    {
      name: 'unchanged unpublished draft',
      options: {
        nextContents: { contents: 'project: draft-change', datasetsContents: null },
        currentDraftContents: { contents: 'project: draft-change', datasetsContents: null },
        publishedContents: { contents: 'project: published', datasetsContents: null },
        draftEndpointName: 'published-endpoint',
        publishedEndpointName: 'published-endpoint',
      },
      expected: 'current-draft',
    },
    {
      name: 'reverted published contents',
      options: {
        nextContents: { contents: 'project: published', datasetsContents: 'dataset: published' },
        currentDraftContents: { contents: 'project: draft-change', datasetsContents: 'dataset: draft-change' },
        publishedContents: { contents: 'project: published', datasetsContents: 'dataset: published' },
        draftEndpointName: 'published-endpoint',
        publishedEndpointName: 'published-endpoint',
      },
      expected: 'published-revision',
    },
    {
      name: 'real published-project change',
      options: {
        nextContents: { contents: 'project: new-change', datasetsContents: null },
        currentDraftContents: { contents: 'project: published', datasetsContents: null },
        publishedContents: { contents: 'project: published', datasetsContents: null },
        draftEndpointName: 'published-endpoint',
        publishedEndpointName: 'published-endpoint',
      },
      expected: 'create-revision',
    },
  ];

  for (const testCase of cases) {
    assert.equal(
      resolveManagedHostedProjectSaveTarget(testCase.options),
      testCase.expected,
      testCase.name,
    );
  }
});

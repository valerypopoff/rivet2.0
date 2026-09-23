import assert from 'node:assert/strict';
import test from 'node:test';
import { loadProjectFromString, serializeProject } from '@valerypopoff/rivet2-node';
import type { Pool, PoolClient } from 'pg';

import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import type { ManagedWorkflowDbClient } from '../routes/workflows/managed/db.js';
import * as managedMappers from '../routes/workflows/managed/mappers.js';
import { createManagedWorkflowPublicationService } from '../routes/workflows/managed/publication.js';
import { resolveManagedHostedProjectSaveTarget } from '../routes/workflows/managed/save-target.js';
import { publicationCommandPublishesDraft } from '../routes/workflows/publication-command.js';
import type {
  PublishedVersionRow,
  RevisionRow,
  TransactionHooks,
  WebAppPublicationRow,
  WorkflowRow,
} from '../routes/workflows/managed/types.js';
import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import { createWebAppProjectWithUiGraphs } from './helpers/workflow-web-app-fixtures.js';

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

test('publication command policy classifies every active mutation and rejects unknown kinds', () => {
  for (const kind of ['publish-endpoint', 'publish-web-apps', 'restore-version'] as const) {
    assert.equal(publicationCommandPublishesDraft(kind), true);
  }
  for (const kind of ['unpublish-endpoint', 'set-endpoint-access', 'set-web-app-access', 'unpublish-web-app'] as const) {
    assert.equal(publicationCommandPublishesDraft(kind), false);
  }
  assert.throws(() => publicationCommandPublishesDraft('unknown' as never), /Unsupported publication command/);
});

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
    publication_version: '0',
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
    stats_graph_count: 1,
    stats_total_node_count: 0,
    stats_web_app_count: 0,
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
    comment: '',
    ...overrides,
  };
}

function createWebAppPublicationRow(overrides: Partial<WebAppPublicationRow> = {}): WebAppPublicationRow {
  return {
    app_id: 'app-a',
    workflow_id: 'workflow-a',
    revision_id: 'draft-revision',
    ui_graph_id: 'ui-current',
    slug: 'current-app',
    slug_lookup_name: 'current-app',
    published_at: now,
    ...overrides,
  };
}

function createManagedWebAppProjectContents(uiGraphs: Array<[string, string]>): string {
  const project = createWebAppProjectWithUiGraphs(
    { loadProjectFromString },
    createBlankProjectFile('Main'),
    uiGraphs,
  );
  const serializedProject = serializeProject(project);
  if (typeof serializedProject !== 'string') {
    throw new TypeError('Expected serialized project to be a string');
  }

  return serializedProject;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function createPublicationHarness(options: {
  workflow?: WorkflowRow;
  workflowAfterMutation?: WorkflowRow;
  revisions?: RevisionRow[];
  publishedVersions?: PublishedVersionRow[];
  webAppRows?: WebAppPublicationRow[];
  revisionContents?: Record<string, string>;
} = {}) {
  const workflow = options.workflow ?? createWorkflow();
  const workflowAfterMutation = options.workflowAfterMutation ?? workflow;
  const revisions = new Map((options.revisions ?? [createRevision()]).map((revision) => [revision.revision_id, revision]));
  const publishedVersions = new Map(
    (options.publishedVersions ?? []).map((version) => [version.version_id, version]),
  );
  const webAppRows = options.webAppRows ?? [];
  const revisionContents = options.revisionContents ?? {};

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
      if (normalizeSql(sql).startsWith('UPDATE workflows SET publication_version = publication_version + 1')) {
        workflow.publication_version = (BigInt(workflow.publication_version ?? '0') + 1n).toString();
        return { rows: [{ publication_version: workflow.publication_version }] };
      }
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
      if (!version) {
        return null;
      }

      return {
        ...version,
        ...(normalized.includes('SET is_starred') ? { is_starred: params[2] === true } : {}),
        ...(normalized.includes('SET comment') ? { comment: String(params[2]) } : {}),
      } as T;
    }

    if (normalized.startsWith('INSERT INTO workflow_published_versions')) {
      const explicitIsStarredInsert = normalized.includes('(version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred)');
      const explicitCommentInsert = normalized.includes('(version_id, workflow_id, revision_id, endpoint_name, published_at, comment)');
      latestInsertedPublishedVersionId = String(params[0]);
      return createPublishedVersion({
        version_id: String(params[0]),
        workflow_id: String(params[1]),
        revision_id: String(params[2]),
        endpoint_name: String(params[3]),
        is_starred: explicitIsStarredInsert && params[5] === true,
        comment: explicitCommentInsert ? String(params[5] ?? '') : '',
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
      queryRows: async <T>(_client: ManagedWorkflowDbClient, sql: string) => {
        const normalized = normalizeSql(sql);
        if (normalized.includes('FROM workflow_web_apps')) {
          return webAppRows as T[];
        }

        return [];
      },
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
        contents: revisionContents[revision.revision_id] ?? createManagedWebAppProjectContents([]),
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
    reviewedPreconditions: {
      expectedProjectId: workflow.workflow_id,
      expectedPublicationVersion: workflow.publication_version ?? '0',
      expectedDraftRevisionId: workflow.current_draft_revision_id,
    },
    clientQueries,
    queryOneCalls,
    endpointSyncCalls,
    invalidationRequests,
    invalidationCommits,
    workflowLookups,
  };
}

test('managed endpoint access updates publication policy without creating a revision', async () => {
  const unpublished = createPublicationHarness();
  await assert.rejects(
    unpublished.service.updateWorkflowEndpointAccess('Main.rivet-project', 'internal', unpublished.reviewedPreconditions),
    /Publish the workflow before changing endpoint access/,
  );

  const harness = createPublicationHarness({
    workflow: createWorkflow({ published_revision_id: 'draft-revision' }),
    workflowAfterMutation: createWorkflow({ published_revision_id: 'draft-revision', endpoint_access: 'internal' }),
  });
  const { expectedDraftRevisionId: _draftRevisionId, ...publicationPreconditions } = harness.reviewedPreconditions;
  const updated = await harness.service.updateWorkflowEndpointAccess('Main.rivet-project', 'internal', publicationPreconditions);
  assert.equal(updated.settings.endpointAccess, 'internal');
  assert.ok(harness.clientQueries.some(({ sql, params }) =>
    normalizeSql(sql).startsWith('UPDATE workflows SET endpoint_access') && params[1] === 'internal'));
  assert.deepEqual(harness.invalidationCommits, ['workflow-a']);
  assert.ok(harness.clientQueries.every(({ sql }) => !normalizeSql(sql).includes('INSERT INTO workflow_published_versions')));
});

test('managed publication methods reject omitted reviewed state before mutation', async () => {
  const harness = createPublicationHarness();
  await assert.rejects(
    harness.service.publishWorkflowProjectItem('Main.rivet-project', { endpointName: 'unchecked-endpoint' }, undefined as never),
    { status: 400 },
  );
  await assert.rejects(
    harness.service.unpublishWorkflowProjectItem('Main.rivet-project', undefined as never),
    { status: 400 },
  );
  assert.deepEqual(harness.clientQueries, []);
  assert.deepEqual(harness.invalidationRequests, []);
});

test('managed web app publication list exposes revision-based statuses', async () => {
  const draftContents = createManagedWebAppProjectContents([
    ['ui-current', 'Current Web App'],
    ['ui-changed', 'Changed Web App'],
    ['ui-unpublished', 'Draft Only Web App'],
  ]);
  const { service } = createPublicationHarness({
    workflow: createWorkflow({
      current_draft_revision_id: 'draft-revision',
    }),
    revisions: [
      createRevision({ revision_id: 'draft-revision' }),
      createRevision({ revision_id: 'published-revision' }),
    ],
    revisionContents: {
      'draft-revision': draftContents,
    },
    webAppRows: [
      createWebAppPublicationRow({
        app_id: 'app-current',
        revision_id: 'draft-revision',
        ui_graph_id: 'ui-current',
        slug: 'current-app',
      }),
      createWebAppPublicationRow({
        app_id: 'app-changed',
        revision_id: 'published-revision',
        ui_graph_id: 'ui-changed',
        slug: 'changed-app',
      }),
      createWebAppPublicationRow({
        app_id: 'app-removed',
        revision_id: 'published-revision',
        ui_graph_id: 'ui-removed',
        slug: 'removed-app',
      }),
    ],
  });

  const response = await service.listWorkflowProjectWebApps('Main.rivet-project');

  assert.equal(response.hasMainGraph, true);
  assert.equal(response.project.projectMetadataId, response.projectId);
  assert.equal(response.project.revisionId, response.draftRevisionId);
  assert.equal(response.project.settings.publicationVersion, response.publicationVersion);
  assert.deepEqual(
    response.webApps.map((webApp) => [
      webApp.uiGraphId,
      webApp.name,
      webApp.publishedSlug,
      webApp.status,
      webApp.isMissingFromProject,
    ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    [
      ['ui-changed', 'Changed Web App', 'changed-app', 'unpublished_changes', false],
      ['ui-current', 'Current Web App', 'current-app', 'published', false],
      ['ui-removed', 'removed-app', 'removed-app', 'unpublished_changes', true],
      ['ui-unpublished', 'Draft Only Web App', null, 'unpublished', false],
    ],
  );
});

test('managed endpoint publish rejects a revision whose selected Main Graph no longer exists', async () => {
  const contentsWithoutMainGraph = createBlankProjectFile('Main').replace(
    /^[ \t]*mainGraphId:.*\r?\n/m,
    '    mainGraphId: "missing-main-graph"\n',
  );
  const { service, clientQueries, endpointSyncCalls, invalidationRequests, reviewedPreconditions } = createPublicationHarness({
    revisionContents: {
      'draft-revision': contentsWithoutMainGraph,
    },
  });

  await assert.rejects(
    service.publishWorkflowProjectItem('Main.rivet-project', { endpointName: 'missing-main-graph' }, reviewedPreconditions),
    /Choose a Main Graph before publishing this endpoint/,
  );

  assert.deepEqual(endpointSyncCalls, []);
  assert.deepEqual(invalidationRequests, []);
  assert.equal(
    clientQueries.some((query) => normalizeSql(query.sql).startsWith('INSERT INTO workflow_published_versions')),
    false,
  );
});

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
  const { service, clientQueries, queryOneCalls, endpointSyncCalls, invalidationRequests, invalidationCommits, reviewedPreconditions } =
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
  }, reviewedPreconditions);

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

test('managed publishing rejects a stale revision under the row lock without mutations', async () => {
  const { service, clientQueries, endpointSyncCalls, invalidationRequests, workflowLookups } = createPublicationHarness();
  await assert.rejects(service.publishWorkflowProjectItem('Main.rivet-project', {
    endpointName: 'new-endpoint',
  }, { expectedProjectId: 'workflow-a', expectedPublicationVersion: '0', expectedDraftRevisionId: 'older-revision' }), {
    status: 409,
    message: 'Publishing failed because the project changed. Review the latest saved version before trying again.',
  });
  assert.deepEqual(clientQueries, []);
  assert.deepEqual(endpointSyncCalls, []);
  assert.deepEqual(invalidationRequests, []);
  assert.equal(workflowLookups[0]?.forUpdate, true);
});

test('managed web-app publishing rejects stale draft, publication, and project identity under the row lock', async () => {
  const harness = createPublicationHarness({
    workflow: createWorkflow({ publication_version: '3' }),
    revisionContents: { 'draft-revision': createManagedWebAppProjectContents([['ui-current', 'Current Web App']]) },
  });
  const publish = (preconditions: { expectedProjectId: string; expectedDraftRevisionId: string; expectedPublicationVersion: string }) =>
    harness.service.publishWorkflowProjectWebApps('Main.rivet-project', [{ uiGraphId: 'ui-current', slug: 'current-app' }], preconditions);
  const expected = { expectedProjectId: 'workflow-a', expectedDraftRevisionId: 'draft-revision', expectedPublicationVersion: '3' };

  await assert.rejects(publish({ ...expected, expectedDraftRevisionId: 'old-revision' }), { status: 409, code: 'publication_draft_changed' });
  await assert.rejects(publish({ ...expected, expectedPublicationVersion: '2' }), { status: 409, code: 'publication_state_changed' });
  await assert.rejects(publish({ ...expected, expectedProjectId: 'other-project' }), { status: 409, code: 'publication_project_changed' });
  assert.deepEqual(harness.clientQueries, []);
  assert.deepEqual(harness.invalidationRequests, []);
  assert.ok(harness.workflowLookups.every(({ forUpdate }) => forUpdate));

  const published = await publish(expected);
  assert.equal(published.settings.publicationVersion, '4');
  assert.deepEqual(harness.invalidationRequests, ['workflow-a']);
  await assert.rejects(publish(expected), { status: 409, code: 'publication_state_changed' });
  assert.deepEqual(harness.invalidationRequests, ['workflow-a']);
});

test('managed published version restore republishes a stored revision as a new current history entry', async () => {
  const selectedVersion = createPublishedVersion({
    version_id: 'old-version',
    revision_id: 'old-revision',
    endpoint_name: 'restore-endpoint',
  });
  const { service, clientQueries, endpointSyncCalls, invalidationRequests, invalidationCommits, reviewedPreconditions } = createPublicationHarness({
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

  const result = await service.restoreWorkflowPublishedVersion('Main.rivet-project', 'old-version', reviewedPreconditions);

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
  const { service, clientQueries, queryOneCalls, endpointSyncCalls, invalidationRequests, invalidationCommits, reviewedPreconditions } =
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

  const result = await service.restoreWorkflowPublishedVersion('Main.rivet-project', 'legacy-published-revision', reviewedPreconditions);

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

test('managed published version comments update durable history rows', async () => {
  const { service, queryOneCalls } = createPublicationHarness({
    workflow: createWorkflow({
      published_revision_id: 'published-revision',
      published_version_id: 'version-a',
    }),
    publishedVersions: [
      createPublishedVersion({
        version_id: 'version-a',
        revision_id: 'published-revision',
        comment: '',
      }),
    ],
  });

  const version = await service.setWorkflowPublishedVersionComment(
    'Main.rivet-project',
    'version-a',
    '  release candidate  ',
  );

  assert.equal(version.id, 'version-a');
  assert.equal(version.isCurrent, true);
  assert.equal(version.comment, 'release candidate');

  const updateCall = queryOneCalls.find((query) =>
    normalizeSql(query.sql).startsWith('UPDATE workflow_published_versions') &&
    normalizeSql(query.sql).includes('SET comment'));
  assert.ok(updateCall);
  assert.deepEqual(updateCall.params, ['workflow-a', 'version-a', 'release candidate']);
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

test('managed legacy current version comments are persisted by creating a history row', async () => {
  const legacyPublishedAt = '2026-05-20T09:45:00.000Z';
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

  const version = await service.setWorkflowPublishedVersionComment(
    'Main.rivet-project',
    'legacy-published-revision',
    'legacy winner',
  );

  assert.equal(version.id, 'legacy-published-revision');
  assert.equal(version.isCurrent, true);
  assert.equal(version.comment, 'legacy winner');

  const insertCall = queryOneCalls.find((query) =>
    normalizeSql(query.sql).startsWith('INSERT INTO workflow_published_versions') &&
    normalizeSql(query.sql).includes('comment'));
  assert.ok(insertCall);
  assert.deepEqual(insertCall.params, [
    'legacy-published-revision',
    'workflow-a',
    'legacy-published-revision',
    'legacy-endpoint',
    legacyPublishedAt,
    'legacy winner',
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

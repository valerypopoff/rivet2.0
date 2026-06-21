import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadProjectAndAttachedDataFromString, serializeProject } from '@valerypopoff/rivet2-node';

import { normalizeHostedProjectTitle } from '../routes/workflows/hosted-project-contents.js';
import { createManagedWorkflowRevisionService } from '../routes/workflows/managed/revisions.js';
import { createManagedWorkflowCatalogService } from '../routes/workflows/managed/catalog.js';
import * as managedMappers from '../routes/workflows/managed/mappers.js';
import type { RevisionRow, TransactionHooks, WorkflowRow } from '../routes/workflows/managed/types.js';
import { getManagedWorkflowProjectVirtualPath } from '../routes/workflows/virtual-paths.js';
import { createWorkflowTestRoots, resetWorkflowTestRoots } from './helpers/workflow-fixtures.js';

const {
  tempRoot,
  workflowsRoot,
  recordingsRoot,
  appDataRoot,
} = await createWorkflowTestRoots('rivet-hosted-project-title-');

process.env.RIVET_STORAGE_MODE = 'filesystem';
process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = recordingsRoot;
process.env.RIVET_APP_DATA_ROOT = appDataRoot;

const workflowStorageBackend = await import('../routes/workflows/storage-backend.js');
const workflowFs = await import('../routes/workflows/fs-helpers.js');

function rewriteProjectMetadata(contents: string, metadata: { title: string; description: string }): string {
  const [project, attachedData] = loadProjectAndAttachedDataFromString(contents);
  project.metadata.title = metadata.title;
  project.metadata.description = metadata.description;
  const serialized = serializeProject(project, attachedData);
  if (typeof serialized !== 'string') {
    throw new Error('Project serialization did not return a string');
  }
  return serialized;
}

function createWorkflowRow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    workflow_id: randomUUID(),
    name: 'Managed Tree Name',
    file_name: 'Managed Tree Name.rivet-project',
    relative_path: 'Managed Tree Name.rivet-project',
    folder_relative_path: '',
    updated_at: '2026-05-05T00:00:00.000Z',
    current_draft_revision_id: 'revision-current',
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
    project_blob_key: `blob/${revisionId}`,
    dataset_blob_key: null,
    stats_graph_count: 1,
    stats_total_node_count: 0,
    created_at: '2026-05-05T00:00:00.000Z',
  };
}

test.beforeEach(async () => {
  await resetWorkflowTestRoots({ workflowsRoot, recordingsRoot, appDataRoot });
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('hosted project title normalization rejects invalid project contents as a bad request', (t) => {
  const loggedWarnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    loggedWarnings.push(args);
  });

  assert.throws(
    () => normalizeHostedProjectTitle('not a rivet project', 'Tree Name', 'Could not save project'),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 400);
      assert.equal((error as Error).message, 'Could not save project');
      return true;
    },
  );
  assert.equal(loggedWarnings.length, 1);
  assert.match(String(loggedWarnings[0]?.[0]), /Failed to deserialize project/);
});

test('filesystem saveHostedProject rewrites the YAML title to the file tree name', async () => {
  const suffix = randomUUID();
  const renamedName = `Renamed Tree Name ${suffix}`;
  const projectPath = path.join(workflowsRoot, `${renamedName}.rivet-project`);
  const cleanupPaths = new Set<string>();

  function trackProjectPath(projectPath: string) {
    cleanupPaths.add(projectPath);
    const sidecars = workflowFs.getProjectSidecarPaths(projectPath);
    cleanupPaths.add(sidecars.dataset);
    cleanupPaths.add(sidecars.settings);
    cleanupPaths.add(sidecars.stats);
  }

  try {
    trackProjectPath(projectPath);
    await fs.writeFile(projectPath, workflowFs.createBlankProjectFile(renamedName), 'utf8');
    const loaded = await workflowStorageBackend.loadHostedProject(projectPath);

    await workflowStorageBackend.saveHostedProject({
      projectPath,
      contents: rewriteProjectMetadata(loaded.contents, {
        title: 'Editor Settings Name',
        description: 'description from editor save',
      }),
      datasetsContents: loaded.datasetsContents,
    });

    const saved = await fs.readFile(projectPath, 'utf8');
    const [savedProject] = loadProjectAndAttachedDataFromString(saved);
    assert.equal(savedProject.metadata.title, renamedName);
    assert.equal(savedProject.metadata.description, 'description from editor save');
  } finally {
    await Promise.all([...cleanupPaths].map((projectPath) => fs.rm(projectPath, { force: true }).catch(() => {})));
  }
});

test('managed saveHostedProject stores revisions with the YAML title matching the tree name', async () => {
  const workflow = createWorkflowRow();
  const currentRevision = createRevisionRow(workflow.workflow_id, workflow.current_draft_revision_id);
  const currentContents = workflowFs.createBlankProjectFile(workflow.name);
  const editedContents = rewriteProjectMetadata(currentContents, {
    title: 'Editor Settings Name',
    description: 'managed description from editor save',
  });
  let savedRevisionContents = '';

  const revisionService = createManagedWorkflowRevisionService({
    context: {
      pool: {} as never,
      initialize: async () => {},
      withTransaction: async (run: (client: unknown, hooks: TransactionHooks) => Promise<unknown>) => run(
        {
          query: async () => ({ rows: [] }),
        },
        {
          onCommit: () => {},
          onRollback: () => {},
        },
      ),
      queries: {
        ensureFolderChain: async () => {},
        getWorkflowByRelativePath: async () => workflow,
        getWorkflowById: async () => null,
        getRevision: async (_client: unknown, revisionId: string | null | undefined) =>
          revisionId === currentRevision.revision_id ? currentRevision : null,
      },
      revisions: {
        readRevisionContents: async () => ({
          contents: currentContents,
          datasetsContents: null,
        }),
        createRevision: async (workflowId: string, contents: string): Promise<RevisionRow> => {
          savedRevisionContents = contents;
          return createRevisionRow(workflowId, 'revision-saved');
        },
        scheduleRevisionBlobCleanup: () => {},
        insertRevision: async () => {},
      },
      endpointSync: {
        syncWorkflowEndpointRows: async () => {},
      },
      mappers: managedMappers,
      executionInvalidationController: {
        queueWorkflowInvalidation: async () => {},
      },
    } as never,
  });

  await revisionService.saveHostedProject({
    projectPath: getManagedWorkflowProjectVirtualPath(workflow.relative_path),
    contents: editedContents,
    datasetsContents: null,
    expectedRevisionId: workflow.current_draft_revision_id,
  });

  const [savedProject] = loadProjectAndAttachedDataFromString(savedRevisionContents);
  assert.equal(savedProject.metadata.title, workflow.name);
  assert.equal(savedProject.metadata.description, 'managed description from editor save');
});

test('managed project rename stores a new draft revision with the YAML title matching the tree name', async () => {
  let workflow = createWorkflowRow({
    name: 'Managed Old Name',
    file_name: 'Managed Old Name.rivet-project',
    relative_path: 'Managed Old Name.rivet-project',
  });
  const currentRevision = createRevisionRow(workflow.workflow_id, workflow.current_draft_revision_id);
  const revisions = new Map<string, RevisionRow>([
    [currentRevision.revision_id, currentRevision],
  ]);
  const currentContents = rewriteProjectMetadata(workflowFs.createBlankProjectFile(workflow.name), {
    title: 'Editor YAML Name',
    description: 'managed rename keeps project data',
  });
  let createdRevisionCount = 0;
  let savedRevisionContents = '';
  let savedRevisionDataset: string | null = null;
  let invalidatedWorkflowId: string | null = null;

  const catalogService = createManagedWorkflowCatalogService({
    context: {
      pool: {} as never,
      initialize: async () => {},
      withTransaction: async (run: (client: unknown, hooks: TransactionHooks) => Promise<unknown>) => run(
        {
          query: async (_sql: string, params: unknown[]) => {
            const [
              workflowId,
              name,
              fileName,
              relativePath,
              folderRelativePath,
              currentDraftRevisionId,
            ] = params as [string, string, string, string, string, string];
            workflow = {
              ...workflow,
              workflow_id: workflowId,
              name,
              file_name: fileName,
              relative_path: relativePath,
              folder_relative_path: folderRelativePath,
              current_draft_revision_id: currentDraftRevisionId,
            };
            return { rows: [] };
          },
        },
        {
          onCommit: () => {},
          onRollback: () => {},
        },
      ),
      queries: {
        getWorkflowByRelativePath: async (_client: unknown, relativePath: string) =>
          relativePath === workflow.relative_path ? workflow : null,
        getRevision: async (_client: unknown, revisionId: string | null | undefined) =>
          revisionId ? revisions.get(revisionId) ?? null : null,
        assertFolderExists: async () => {},
      },
      revisions: {
        readRevisionContents: async (revision: RevisionRow) => {
          assert.equal(revision.revision_id, currentRevision.revision_id);
          return {
            contents: currentContents,
            datasetsContents: '{"rows":[]}',
          };
        },
        createRevision: async (workflowId: string, contents: string, datasetsContents: string | null): Promise<RevisionRow> => {
          createdRevisionCount += 1;
          savedRevisionContents = contents;
          savedRevisionDataset = datasetsContents;
          const revision = createRevisionRow(workflowId, 'revision-renamed');
          revisions.set(revision.revision_id, revision);
          return revision;
        },
        insertRevision: async () => {},
        scheduleRevisionBlobCleanup: () => {},
      },
      mappers: managedMappers,
      executionInvalidationController: {
        queueWorkflowInvalidation: async (_client: unknown, _hooks: TransactionHooks, workflowId: string) => {
          invalidatedWorkflowId = workflowId;
        },
        queueGlobalInvalidation: async () => {},
      },
      db: {
        isUniqueViolation: () => false,
      },
    } as never,
    saveHostedProject: async () => {
      throw new Error('rename should update the managed draft revision directly');
    },
  });

  const renamed = await catalogService.renameWorkflowProjectItem(workflow.relative_path, 'Managed Renamed Name');

  const [savedProject] = loadProjectAndAttachedDataFromString(savedRevisionContents);
  assert.equal(renamed.project.name, 'Managed Renamed Name');
  assert.equal(renamed.project.relativePath, 'Managed Renamed Name.rivet-project');
  assert.equal(savedProject.metadata.title, 'Managed Renamed Name');
  assert.equal(savedProject.metadata.description, 'managed rename keeps project data');
  assert.equal(createdRevisionCount, 1);
  assert.equal(savedRevisionDataset, '{"rows":[]}');
  assert.equal(invalidatedWorkflowId, workflow.workflow_id);

  const moved = await catalogService.moveWorkflowProject(renamed.project.relativePath, 'Folder');

  assert.equal(moved.project.relativePath, 'Folder/Managed Renamed Name.rivet-project');
  assert.equal(createdRevisionCount, 1);
});

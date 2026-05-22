import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { loadProjectAndAttachedDataFromString, serializeProject } from '@valerypopoff/rivet2-node';

import { normalizeHostedProjectTitle } from '../routes/workflows/hosted-project-contents.js';
import { createManagedWorkflowRevisionService } from '../routes/workflows/managed/revisions.js';
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

const workflowMutations = await import('../routes/workflows/workflow-mutations.js');
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
  const created = await workflowMutations.createWorkflowProjectItem('', 'Original Tree Name');
  const renamed = await workflowMutations.renameWorkflowProjectItem(created.relativePath, 'Renamed Tree Name');
  const loaded = await workflowStorageBackend.loadHostedProject(renamed.project.absolutePath);

  await workflowStorageBackend.saveHostedProject({
    projectPath: renamed.project.absolutePath,
    contents: rewriteProjectMetadata(loaded.contents, {
      title: 'Editor Settings Name',
      description: 'description from editor save',
    }),
    datasetsContents: loaded.datasetsContents,
  });

  const saved = await fs.readFile(renamed.project.absolutePath, 'utf8');
  const [savedProject] = loadProjectAndAttachedDataFromString(saved);
  assert.equal(savedProject.metadata.title, 'Renamed Tree Name');
  assert.equal(savedProject.metadata.description, 'description from editor save');
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

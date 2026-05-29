import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getWorkflowStatus,
  mapFolderRowToFolderItem,
  mapWorkflowRowToProjectItem,
  splitCurrentDraftRevisionRow,
  toIsoString,
} from '../routes/workflows/managed/mappers.js';
import type { CurrentDraftRevisionRow, FolderRow, WorkflowRow } from '../routes/workflows/managed/types.js';

function createWorkflowRow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    workflow_id: 'workflow-a',
    name: 'Main',
    file_name: 'Main.rivet-project',
    relative_path: 'Main.rivet-project',
    folder_relative_path: '',
    updated_at: '2026-04-07T10:00:00.000Z',
    current_draft_revision_id: 'revision-a',
    published_revision_id: 'revision-a',
    published_version_id: 'version-a',
    endpoint_name: 'Hello-World',
    published_endpoint_name: 'hello-world',
    last_published_at: '2026-04-07T09:00:00.000Z',
    ...overrides,
  };
}

test('getWorkflowStatus keeps published when revision ids and normalized endpoint names match', () => {
  assert.equal(getWorkflowStatus(createWorkflowRow()), 'published');
});

test('getWorkflowStatus returns unpublished_changes when endpoint normalization differs after publish', () => {
  assert.equal(
    getWorkflowStatus(createWorkflowRow({
      endpoint_name: 'hello-world-v2',
    })),
    'unpublished_changes',
  );
});

test('getWorkflowStatus returns unpublished without a published revision', () => {
  assert.equal(
    getWorkflowStatus(createWorkflowRow({
      published_revision_id: null,
      published_version_id: null,
      published_endpoint_name: '',
      last_published_at: null,
    })),
    'unpublished',
  );
});

test('mapWorkflowRowToProjectItem preserves managed virtual paths and ISO timestamps', () => {
  const item = mapWorkflowRowToProjectItem(createWorkflowRow());

  assert.equal(item.absolutePath, '/managed/workflows/Main.rivet-project');
  assert.equal(item.settings.status, 'published');
  assert.equal(item.settings.lastPublishedAt, '2026-04-07T09:00:00.000Z');
  assert.equal(item.updatedAt, '2026-04-07T10:00:00.000Z');
});

test('mapFolderRowToFolderItem preserves managed folder virtual paths', () => {
  const row: FolderRow = {
    relative_path: 'Folder/Subfolder',
    name: 'Subfolder',
    parent_relative_path: 'Folder',
    updated_at: new Date('2026-04-07T08:00:00.000Z'),
  };

  const item = mapFolderRowToFolderItem(row);

  assert.equal(item.absolutePath, '/managed/workflows/Folder/Subfolder');
  assert.equal(item.updatedAt, '2026-04-07T08:00:00.000Z');
  assert.deepEqual(item.folders, []);
  assert.deepEqual(item.projects, []);
});

test('splitCurrentDraftRevisionRow separates workflow and revision fields without reordering', () => {
  const row: CurrentDraftRevisionRow = {
    workflow_id: 'workflow-a',
    name: 'Main',
    file_name: 'Main.rivet-project',
    relative_path: 'Main.rivet-project',
    folder_relative_path: '',
    updated_at: '2026-04-07T10:00:00.000Z',
    current_draft_revision_id: 'revision-a',
    published_revision_id: 'revision-b',
    published_version_id: 'version-b',
    endpoint_name: 'hello-world',
    published_endpoint_name: 'hello-world',
    last_published_at: '2026-04-07T09:00:00.000Z',
    revision_id: 'revision-a',
    revision_workflow_id: 'workflow-a',
    project_blob_key: 'project-blob',
    dataset_blob_key: 'dataset-blob',
    stats_graph_count: 3,
    stats_total_node_count: 42,
    revision_created_at: '2026-04-07T10:00:00.000Z',
  };

  const split = splitCurrentDraftRevisionRow(row);

  assert.equal(split.workflow.workflow_id, 'workflow-a');
  assert.equal(split.workflow.current_draft_revision_id, 'revision-a');
  assert.equal(split.revision.revision_id, 'revision-a');
  assert.equal(split.revision.project_blob_key, 'project-blob');
  assert.equal(split.revision.stats_graph_count, 3);
  assert.equal(split.revision.stats_total_node_count, 42);
});

test('toIsoString returns null for missing values and preserves Date inputs', () => {
  assert.equal(toIsoString(null), null);
  assert.equal(toIsoString(undefined), null);
  assert.equal(toIsoString(new Date('2026-04-07T12:00:00.000Z')), '2026-04-07T12:00:00.000Z');
});

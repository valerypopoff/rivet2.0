import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptConflictSnapshot } from '../dashboard/useHostedProjectConflictNotices';
import {
  isDashboardToEditorCommand,
  isEditorToDashboardEvent,
  type HostedProjectConflictSnapshot,
} from '../../studio-server-shared/editor-bridge';

const pending: HostedProjectConflictSnapshot = {
  editorInstanceId: 'editor-1',
  sequence: 2,
  recheckSequence: 1,
  contentChanges: [
    {
      projectId: 'project',
      path: '/workflows/Project.rivet-project',
      title: 'Project',
      revisionId: 'theirs',
      changeId: 'change-1',
    },
  ],
};

test('only newer snapshots from the current iframe replace the conflict presentation', () => {
  assert.equal(acceptConflictSnapshot('editor-1', null, pending), pending);
  const clear = { ...pending, sequence: 3, contentChanges: [] };
  assert.equal(acceptConflictSnapshot('editor-1', pending, clear), clear);
  assert.equal(acceptConflictSnapshot('editor-1', clear, pending), clear);
  assert.equal(
    acceptConflictSnapshot('editor-1', clear, { ...pending, editorInstanceId: 'old-editor', sequence: 99 }),
    clear,
  );
  assert.equal(acceptConflictSnapshot(null, null, pending), null);
});

test('bridge rejects absent or malformed freshness contexts and ambiguous reconciliation acknowledgements', () => {
  const context = {
    editorInstanceId: 'editor',
    observationSequence: 1,
    projects: [{ projectId: 'project', generation: 1 }],
  };
  const command = { type: 'reconcile-workflow-project-bindings', bindings: [], context };
  assert.equal(isDashboardToEditorCommand(command), true);
  for (const invalid of [
    undefined,
    null,
    { ...context, observationSequence: -1 },
    { ...context, projects: [context.projects[0], context.projects[0]] },
  ]) {
    assert.equal(isDashboardToEditorCommand({ ...command, context: invalid }), false);
  }
  assert.equal(
    isEditorToDashboardEvent({ type: 'workflow-project-bindings-reconciled', changes: [], contentChanges: [] }),
    false,
  );
  assert.equal(
    isEditorToDashboardEvent({ type: 'workflow-project-bindings-reconciled', changes: [], status: 'retry' }),
    true,
  );
  assert.equal(isEditorToDashboardEvent({ type: 'workflow-project-conflicts', snapshot: pending }), true);
  assert.equal(
    isEditorToDashboardEvent({ type: 'workflow-project-conflicts', snapshot: { ...pending, sequence: NaN } }),
    false,
  );
});

test('resolution commands must identify the exact displayed conflict', () => {
  const command = {
    type: 'resolve-workflow-project-content-change',
    ...pending.contentChanges[0],
    resolution: 'keep-local',
  };
  assert.equal(isDashboardToEditorCommand(command), true);
  assert.equal(isDashboardToEditorCommand({ ...command, changeId: undefined }), false);
});

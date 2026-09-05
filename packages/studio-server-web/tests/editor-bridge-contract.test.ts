import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { isDashboardToEditorCommand, isEditorToDashboardEvent } from '../../studio-server-shared/editor-bridge';

const workflowRecordingBridgeSource = readFileSync(
  new URL('../dashboard/useWorkflowRecordingBridge.ts', import.meta.url),
  'utf8',
);

test('recording activation preserves the selected executor and the exact replay-tab path', () => {
  assert.doesNotMatch(workflowRecordingBridgeSource, /selectBrowserExecutor/);
  assert.match(workflowRecordingBridgeSource, /activateLoadedRecording\(\{ \.\.\.loadedRecording, projectId, projectPath \}\);/);
  assert.match(workflowRecordingBridgeSource, /activateWorkflowRecording\(cachedRecording, currentProjectId, projectPath\)/);
  assert.match(workflowRecordingBridgeSource, /clearLoadedRecordingForPath\(projectPath\);/);
});

test('replacing a tab clears playback by its path, never just by a reused project ID', () => {
  const editorCommandBridgeSource = readFileSync(
    new URL('../dashboard/useEditorCommandBridge.ts', import.meta.url),
    'utf8',
  );

  assert.match(editorCommandBridgeSource, /clearLoadedRecordingForPath: \(projectPath\) =>/);
  assert.match(editorCommandBridgeSource, /clearLoadedRecordingForPathState/);
  assert.match(editorCommandBridgeSource, /clearLoadedRecordingForPath\(projectPath\);/);
  assert.doesNotMatch(editorCommandBridgeSource, /loadedRecordingState/);
});

test('project path moves rebind a manually loaded recording to its owner tab', () => {
  const lifecycleCommandsSource = readFileSync(
    new URL('../dashboard/editorProjectLifecycleCommands.ts', import.meta.url),
    'utf8',
  );

  assert.match(lifecycleCommandsSource, /const workspaceMoves = getHostedProjectPathMoveInputs\(moves\);/);
  assert.match(lifecycleCommandsSource, /context\.rebindLoadedRecordingPath\(move\.from, move\.to\);/);
});

test('recording opens give a new replay tab the active local executor mode', () => {
  const detachedProjectCommandsSource = readFileSync(
    new URL('../dashboard/editorDetachedProjectCommands.ts', import.meta.url),
    'utf8',
  );
  const openWorkflowProjectSource = readFileSync(
    new URL('../dashboard/useOpenWorkflowProject.ts', import.meta.url),
    'utf8',
  );

  assert.match(detachedProjectCommandsSource, /createLocalProjectExecutorMode\(context\.getSelectedExecutor\(\)\)/);
  assert.match(openWorkflowProjectSource, /executorMode: options\.executorMode/);
});

test('open project bridge command accepts optional title and preview flags', () => {
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-project',
      path: '/workflows/example.rivet-project',
      replaceCurrent: false,
      title: 'Example',
      preview: true,
      requestId: 'open-1',
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-project',
      path: '/workflows/example.rivet-project',
      replaceCurrent: false,
      title: 12,
    }),
    false,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-project',
      path: '/workflows/example.rivet-project',
      replaceCurrent: false,
      preview: 'true',
    }),
    false,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-project',
      path: '/workflows/example.rivet-project',
      replaceCurrent: false,
      requestId: 12,
    }),
    false,
  );
});

test('save-project bridge command accepts only the optional shortcut source', () => {
  assert.equal(isDashboardToEditorCommand({ type: 'save-project' }), true);
  assert.equal(isDashboardToEditorCommand({ type: 'save-project', source: 'shortcut' }), true);
  assert.equal(isDashboardToEditorCommand({ type: 'save-project', source: 'button' }), false);
});

test('project-tree rename request event is accepted only by its exact bridge type', () => {
  assert.equal(
    isEditorToDashboardEvent({
      type: 'request-active-workflow-project-rename',
    }),
    true,
  );
  assert.equal(
    isEditorToDashboardEvent({
      type: 'request-active-workflow-project-rename-now',
    }),
    false,
  );
});
test('project opened event accepts optional request ownership', () => {
  assert.equal(
    isEditorToDashboardEvent({
      type: 'project-opened',
      path: '/workflows/example.rivet-project',
      requestId: 'open-1',
    }),
    true,
  );
  assert.equal(
    isEditorToDashboardEvent({
      type: 'project-opened',
      path: '/workflows/example.rivet-project',
      requestId: 12,
    }),
    false,
  );
});

test('project compare bridge command validates required path fields', () => {
  assert.equal(
    isDashboardToEditorCommand({
      type: 'compare-open-project-with',
      path: '/workflows/reference.rivet-project',
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'compare-open-project-with',
      path: '/workflows/reference.rivet-project',
      referencePath: 'reference.rivet-project',
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'compare-open-project-with',
      path: '/workflows/reference.rivet-project',
      referencePath: 'reference.rivet-project',
      labels: {
        referenceLabel: 'Reference project',
        currentLabel: 'Open project',
      },
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'compare-open-project-with',
      referencePath: 'reference.rivet-project',
    }),
    false,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'compare-open-project-with',
      path: '/workflows/reference.rivet-project',
      referencePath: 1,
    }),
    false,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'compare-open-project-with',
      path: '/workflows/reference.rivet-project',
      labels: {
        referenceLabel: 1,
      },
    }),
    false,
  );
});

test('project compare failure event validates path and error payloads', () => {
  assert.equal(
    isEditorToDashboardEvent({
      type: 'project-compare-failed',
      path: '/workflows/reference.rivet-project',
      error: 'Failed to load project',
    }),
    true,
  );
  assert.equal(
    isEditorToDashboardEvent({
      type: 'project-compare-failed',
      path: '/workflows/reference.rivet-project',
    }),
    false,
  );
});

test('active project unsaved changes event validates path and dirty payload', () => {
  assert.equal(
    isEditorToDashboardEvent({
      type: 'active-project-unsaved-changes-changed',
      path: '/workflows/example.rivet-project',
      hasUnsavedChanges: true,
    }),
    true,
  );
  assert.equal(
    isEditorToDashboardEvent({
      type: 'active-project-unsaved-changes-changed',
      path: '/workflows/example.rivet-project',
    }),
    false,
  );
});

test('project saved event carries only a boolean retained-dirty-state signal', () => {
  assert.equal(
    isEditorToDashboardEvent({
      type: 'project-saved',
      path: '/workflows/example.rivet-project',
      hasNewerUnsavedChanges: true,
    }),
    true,
  );
  assert.equal(
    isEditorToDashboardEvent({
      type: 'project-saved',
      path: '/workflows/example.rivet-project',
    }),
    true,
  );
  assert.equal(
    isEditorToDashboardEvent({
      type: 'project-saved',
      path: '/workflows/example.rivet-project',
      hasNewerUnsavedChanges: 'true',
    }),
    false,
  );
});

test('remote project binding reconciliation validates immutable IDs and the acknowledgement payload', () => {
  assert.equal(
    isDashboardToEditorCommand({
      type: 'reconcile-workflow-project-bindings',
      bindings: [
        {
          projectId: 'project-1',
          path: '/managed/workflows/Moved/Project.rivet-project',
          title: 'Project',
          revisionId: 'revision-2',
        },
      ],
      requestId: 'reconcile-1',
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'reconcile-workflow-project-bindings',
      bindings: [
        {
          projectId: 'project-1',
          path: '/managed/workflows/Moved/Project.rivet-project',
          title: 12,
        },
      ],
    }),
    false,
  );
  assert.equal(
    isEditorToDashboardEvent({
      type: 'workflow-project-bindings-reconciled',
      changes: [
        {
          projectId: 'project-1',
          fromPath: '/managed/workflows/Project.rivet-project',
          toPath: '/managed/workflows/Moved/Project.rivet-project',
          fromTitle: 'Project',
          toTitle: 'Project',
        },
      ],
      contentChanges: [
        {
          projectId: 'project-1',
          path: '/managed/workflows/Moved/Project.rivet-project',
          title: 'Project',
          revisionId: 'revision-2',
        },
      ],
      requestId: 'reconcile-1',
    }),
    true,
  );
  assert.equal(
    isEditorToDashboardEvent({
      type: 'workflow-project-bindings-reconciled',
      changes: [{ projectId: 'project-1' }],
      contentChanges: [],
    }),
    false,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'resolve-workflow-project-content-change',
      projectId: 'project-1',
      path: '/managed/workflows/Project.rivet-project',
      revisionId: 'revision-2',
      resolution: 'keep-local',
      requestId: 'content-change-1',
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'resolve-workflow-project-content-change',
      projectId: 'project-1',
      path: '/managed/workflows/Project.rivet-project',
      revisionId: 'revision-2',
      resolution: 'overwrite',
    }),
    false,
  );
  assert.equal(
    isEditorToDashboardEvent({
      type: 'workflow-project-content-change-resolved',
      projectId: 'project-1',
      revisionId: 'revision-2',
      resolution: 'reload',
      resolved: true,
      requestId: 'content-change-1',
    }),
    true,
  );
  assert.equal(
    isEditorToDashboardEvent({
      type: 'workflow-project-content-change-resolved',
      projectId: 'project-1',
      revisionId: 'revision-2',
      resolution: 'reload',
      resolved: 'true',
    }),
    false,
  );
});

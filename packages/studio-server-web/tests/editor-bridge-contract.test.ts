import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import { ExecutionRecorder, type ProjectId } from '@valerypopoff/rivet2-core';
import { createStore, Provider } from 'jotai';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { isDashboardToEditorCommand, isEditorToDashboardEvent } from '../../studio-server-shared/editor-bridge';
import { getWorkflowRecordingVirtualProjectPath } from '../../studio-server-shared/workflow-recording-types';
import {
  clearLoadedRecordingForPathState,
  loadedRecordingState,
  rebindLoadedRecordingPathState,
} from '../../app/src/state/execution.js';
import { selectedExecutorState } from '../../app/src/state/settings.js';
import type { EditorCommandBridgeContext } from '../dashboard/editorCommandBridgeContext';
import { useWorkflowRecordingBridge } from '../dashboard/useWorkflowRecordingBridge';

// Recording commands use an already deserialized recording. Their sibling
// project commands import a browser worker, which must never run in this test.
const deserializeUrl = new URL('../overrides/utils/deserializeProject.ts', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === deserializeUrl
      ? {
          url: 'data:text/javascript,export const deserializeProjectAsync = () => { throw new Error("Unexpected project deserialization"); }; export const deserializeHostedProjectPayloadAsync = deserializeProjectAsync;',
          shortCircuit: true,
        }
      : resolved;
  },
});
const [{ handleOpenRecordingCommand, handleOpenPublishedPreviewCommand }, { handleWorkflowPathsMovedCommand }] =
  await Promise.all([
    import('../dashboard/editorDetachedProjectCommands'),
    import('../dashboard/editorProjectLifecycleCommands'),
  ]).finally(() => hooks.deregister());

function createRecordingHarness(t: TestContext, initialPath: string) {
  const store = createStore();
  store.set(selectedExecutorState, 'nodejs');
  let recording!: ReturnType<typeof useWorkflowRecordingBridge>;
  function Harness() {
    recording = useWorkflowRecordingBridge({ loadedProjectPath: null, openedProjectPaths: [] });
    return null;
  }
  renderToStaticMarkup(createElement(Provider, { store }, createElement(Harness)));

  const messages: unknown[] = [];
  for (const [key, value] of Object.entries({
    window: {
      location: { origin: 'https://editor.test' },
      frameElement: null,
      parent: { postMessage: (message: unknown) => messages.push(message) },
    },
    HTMLIFrameElement: class {},
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() =>
      original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key),
    );
  }

  const projectId = 'project-1' as ProjectId;
  const openCalls: Array<{ path: string; options: unknown }> = [];
  const context = {
    recording,
    getSelectedExecutor: () => store.get(selectedExecutorState),
    getLoadedProject: () => ({ loaded: true, path: initialPath }),
    getOpenProject: () => async (path: string, options: unknown) => {
      openCalls.push({ path, options });
      return { opened: true, projectId };
    },
    getProjects: () => ({ openedProjects: {}, openedProjectsSortedIds: [] }),
    getWorkspace: () => ({ moveProjectPaths: () => {} }),
    openedProjectPathAliases: new Map(),
    preview: { previewProjectRef: { current: null }, clearPreviewProjectByPath: () => {} },
    clearLoadedRecordingForPath: (path: string | null | undefined) => store.set(clearLoadedRecordingForPathState, path),
    rebindLoadedRecordingPath: (fromPath: string, toPath: string) =>
      store.set(rebindLoadedRecordingPathState, { fromPath, toPath }),
  } as unknown as EditorCommandBridgeContext;
  return { context, store, projectId, openCalls, messages };
}

test('recording activation preserves the selected executor and the exact replay-tab path', (t) => {
  const { context, store, projectId } = createRecordingHarness(t, '/workflows/project.rivet-project');
  const loaded = { path: 'run.rivet-recording', recorder: new ExecutionRecorder() };
  const projectPath = getWorkflowRecordingVirtualProjectPath('recording-1');

  context.recording.activateWorkflowRecording(loaded, projectId, projectPath);

  assert.deepEqual(store.get(loadedRecordingState), { ...loaded, projectId, projectPath });
  assert.equal(store.get(selectedExecutorState), 'nodejs');
});

test('replacing a tab clears playback by its path, never just by a reused project ID', async (t) => {
  const originalPath = '/workflows/project.rivet-project';
  const { context, store, projectId } = createRecordingHarness(t, originalPath);
  const loaded = { path: 'run.rivet-recording', recorder: new ExecutionRecorder() };
  const replayPath = getWorkflowRecordingVirtualProjectPath('recording-1');
  context.recording.activateWorkflowRecording(loaded, projectId, replayPath);
  const command = {
    type: 'open-published-version-preview',
    relativePath: 'project.rivet-project',
    versionId: 'v1',
    replaceCurrent: true,
  } as const;

  await handleOpenPublishedPreviewCommand(context, command);
  assert.equal(store.get(loadedRecordingState)?.projectPath, replayPath);

  context.recording.activateWorkflowRecording(loaded, projectId, originalPath);
  await handleOpenPublishedPreviewCommand(context, command);
  assert.equal(store.get(loadedRecordingState), null);
  assert.equal(store.get(selectedExecutorState), 'nodejs');
});

test('project path moves rebind a manually loaded recording to its owner tab', async (t) => {
  const fromPath = '/workflows/project.rivet-project';
  const toPath = '/workflows/moved/project.rivet-project';
  const { context, store, projectId, messages } = createRecordingHarness(t, fromPath);
  context.recording.activateWorkflowRecording(
    { path: 'run.rivet-recording', recorder: new ExecutionRecorder() },
    projectId,
    fromPath,
  );

  await handleWorkflowPathsMovedCommand(context, {
    type: 'workflow-paths-moved',
    moves: [{ fromAbsolutePath: fromPath, toAbsolutePath: toPath }],
    requestId: 'move-1',
  });

  assert.equal(store.get(loadedRecordingState)?.projectPath, toPath);
  assert.equal(store.get(loadedRecordingState)?.projectId, projectId);
  assert.deepEqual(messages, [{ type: 'workflow-paths-moved-applied', requestId: 'move-1' }]);
});

test('recording opens give a new replay tab the active local executor mode', async (t) => {
  const { context, store, projectId, openCalls } = createRecordingHarness(t, '/workflows/project.rivet-project');
  t.mock.method(globalThis, 'fetch', async () => new Response(new ExecutionRecorder().serialize()));

  await handleOpenRecordingCommand(context, { type: 'open-recording', recordingId: 'recording-1' });

  const replayPath = getWorkflowRecordingVirtualProjectPath('recording-1');
  assert.deepEqual(openCalls, [
    {
      path: replayPath,
      options: {
        executorMode: { type: 'local', executor: 'nodejs' },
        replaceCurrent: false,
        preferredGraphId: undefined,
      },
    },
  ]);
  assert.equal(store.get(selectedExecutorState), 'nodejs');
  assert.equal(store.get(loadedRecordingState)?.projectPath, replayPath);
  assert.equal(store.get(loadedRecordingState)?.projectId, projectId);
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

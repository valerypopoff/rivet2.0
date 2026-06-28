import assert from 'node:assert/strict';
import test from 'node:test';

import * as editorBridgeModule from '../../../shared/editor-bridge.js';

const editorBridge = (editorBridgeModule as typeof editorBridgeModule & { default?: typeof editorBridgeModule }).default ?? editorBridgeModule;
const { isDashboardToEditorCommand, isEditorToDashboardEvent } = editorBridge;

test('editor bridge accepts valid dashboard commands', () => {
  assert.equal(isDashboardToEditorCommand({ type: 'save-project' }), true);
  assert.equal(
    isDashboardToEditorCommand({
      type: 'trigger-editor-find-shortcut',
      modifier: 'ctrl',
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'trigger-editor-find-shortcut',
      modifier: 'meta',
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'trigger-editor-duplicate-shortcut',
      modifier: 'ctrl',
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'trigger-editor-duplicate-shortcut',
      modifier: 'meta',
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-project',
      path: '/tmp/example.rivet-project',
      replaceCurrent: false,
      preview: true,
      reloadFromDisk: true,
      requestId: 'open-1',
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-recording',
      recordingId: 'run-id',
      replaceCurrent: false,
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-published-version-preview',
      relativePath: 'folder/example.rivet-project',
      versionId: 'published-version-id',
      replaceCurrent: false,
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'refresh-open-project-from-disk',
      path: '/tmp/example.rivet-project',
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'workflow-paths-moved',
      moves: [{ fromAbsolutePath: '/a', toAbsolutePath: '/b' }],
      requestId: 'move-1',
    }),
    true,
  );
});

test('editor bridge rejects malformed messages', () => {
  assert.equal(isDashboardToEditorCommand({ type: 'open-project', path: '/tmp/example.rivet-project' }), false);
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-project',
      path: '/tmp/example.rivet-project',
      replaceCurrent: false,
      preview: 'yes',
    }),
    false,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-project',
      path: '/tmp/example.rivet-project',
      replaceCurrent: false,
      reloadFromDisk: 'yes',
    }),
    false,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-project',
      path: '/tmp/example.rivet-project',
      replaceCurrent: false,
      requestId: 123,
    }),
    false,
  );
  assert.equal(isDashboardToEditorCommand({ type: 'open-recording', recordingId: 123 }), false);
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-published-version-preview',
      relativePath: 'folder/example.rivet-project',
      versionId: 'published-version-id',
    }),
    false,
  );
  assert.equal(isDashboardToEditorCommand({ type: 'refresh-open-project-from-disk' }), false);
  assert.equal(isDashboardToEditorCommand({ type: 'refresh-open-project-from-disk', path: 123 }), false);
  assert.equal(isDashboardToEditorCommand({ type: 'trigger-editor-find-shortcut' }), false);
  assert.equal(
    isDashboardToEditorCommand({
      type: 'trigger-editor-find-shortcut',
      modifier: 'alt',
    }),
    false,
  );
  assert.equal(isDashboardToEditorCommand({ type: 'trigger-editor-duplicate-shortcut' }), false);
  assert.equal(
    isDashboardToEditorCommand({
      type: 'trigger-editor-duplicate-shortcut',
      modifier: 'alt',
    }),
    false,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'workflow-paths-moved',
      moves: [{ fromAbsolutePath: '/a', toAbsolutePath: '/b' }],
      requestId: 123,
    }),
    false,
  );
  assert.equal(isEditorToDashboardEvent({ type: 'project-saved' }), false);
  assert.equal(isEditorToDashboardEvent({ type: 'unknown' }), false);
});

test('editor bridge accepts valid editor events', () => {
  assert.equal(isEditorToDashboardEvent({ type: 'editor-ready' }), true);
  assert.equal(isEditorToDashboardEvent({ type: 'project-opened', path: '/tmp/example.rivet-project' }), true);
  assert.equal(
    isEditorToDashboardEvent({
      type: 'project-opened',
      path: '/tmp/example.rivet-project',
      requestId: 'open-1',
    }),
    true,
  );
  assert.equal(isEditorToDashboardEvent({ type: 'project-opened', path: '/tmp/example.rivet-project', requestId: 123 }), false);
  assert.equal(
    isEditorToDashboardEvent({
      type: 'project-saved',
      path: '/tmp/example.rivet-project',
    }),
    true,
  );
  assert.equal(
    isEditorToDashboardEvent({
      type: 'active-project-unsaved-changes-changed',
      path: '/tmp/example.rivet-project',
      hasUnsavedChanges: true,
    }),
    true,
  );
  assert.equal(isEditorToDashboardEvent({ type: 'open-project-count-changed', count: 2 }), true);
  assert.equal(isEditorToDashboardEvent({ type: 'workflow-paths-moved-applied', requestId: 'move-1' }), true);
  assert.equal(isEditorToDashboardEvent({ type: 'workflow-paths-moved-applied', requestId: 123 }), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEditorDuplicateShortcutEvent,
  isEditorFindShortcutEvent,
  isPlainF2ShortcutEvent,
  isSaveShortcutEvent,
  shouldSkipHostedShortcutProjectSave,
} from '../dashboard/editorBridgeFocus';

function keyboardEventLike(options: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    code: '',
    ctrlKey: false,
    key: '',
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...options,
  } as KeyboardEvent;
}

test('save shortcut detection only accepts plain Ctrl/Cmd+S', () => {
  assert.equal(isSaveShortcutEvent(keyboardEventLike({ code: 'KeyS', ctrlKey: true, key: 's' })), true);
  assert.equal(isSaveShortcutEvent(keyboardEventLike({ code: 'KeyS', key: 's', metaKey: true })), true);
  assert.equal(isSaveShortcutEvent(keyboardEventLike({ code: 'KeyS', ctrlKey: true, key: 's', shiftKey: true })), false);
  assert.equal(isSaveShortcutEvent(keyboardEventLike({ code: 'KeyI', ctrlKey: true, key: 'i', shiftKey: true })), false);
});

test('shortcut-originated project saves are suppressed only in Evaluations', () => {
  assert.equal(shouldSkipHostedShortcutProjectSave('shortcut', 'evaluations'), true);
  assert.equal(shouldSkipHostedShortcutProjectSave('shortcut', undefined), false);
  assert.equal(shouldSkipHostedShortcutProjectSave(undefined, 'evaluations'), false);
});

test('find shortcut detection accepts physical KeyF and rejects unrelated browser shortcuts', () => {
  assert.equal(isEditorFindShortcutEvent(keyboardEventLike({ code: 'KeyF', ctrlKey: true, key: 'f' })), true);
  assert.equal(isEditorFindShortcutEvent(keyboardEventLike({ code: 'KeyF', ctrlKey: true, key: 'x' })), true);
  assert.equal(isEditorFindShortcutEvent(keyboardEventLike({ code: 'KeyF', key: 'f', metaKey: true })), true);
  assert.equal(isEditorFindShortcutEvent(keyboardEventLike({ code: 'KeyP', ctrlKey: true, key: 'p' })), false);
  assert.equal(isEditorFindShortcutEvent(keyboardEventLike({ altKey: true, code: 'KeyF', ctrlKey: true, key: 'f' })), false);
  assert.equal(isEditorFindShortcutEvent(keyboardEventLike({ code: 'KeyF', ctrlKey: true, key: 'f', shiftKey: true })), false);
});

test('duplicate shortcut detection accepts physical KeyD and rejects browser-adjacent shortcuts', () => {
  assert.equal(isEditorDuplicateShortcutEvent(keyboardEventLike({ code: 'KeyD', ctrlKey: true, key: 'd' })), true);
  assert.equal(isEditorDuplicateShortcutEvent(keyboardEventLike({ code: 'KeyD', ctrlKey: true, key: 'x' })), true);
  assert.equal(isEditorDuplicateShortcutEvent(keyboardEventLike({ code: 'KeyD', key: 'd', metaKey: true })), true);
  assert.equal(isEditorDuplicateShortcutEvent(keyboardEventLike({ code: 'KeyF', ctrlKey: true, key: 'f' })), false);
  assert.equal(isEditorDuplicateShortcutEvent(keyboardEventLike({ altKey: true, code: 'KeyD', ctrlKey: true, key: 'd' })), false);
  assert.equal(isEditorDuplicateShortcutEvent(keyboardEventLike({ code: 'KeyD', ctrlKey: true, key: 'd', shiftKey: true })), false);
});
test('project-tree rename only accepts one plain F2 keydown', () => {
  assert.equal(isPlainF2ShortcutEvent(keyboardEventLike({ key: 'F2' })), true);
  assert.equal(isPlainF2ShortcutEvent(keyboardEventLike({ ctrlKey: true, key: 'F2' })), false);
  assert.equal(isPlainF2ShortcutEvent(keyboardEventLike({ key: 'F2', repeat: true })), false);
  assert.equal(isPlainF2ShortcutEvent(keyboardEventLike({ key: 'F2', shiftKey: true })), false);
});

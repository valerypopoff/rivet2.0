import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeToOtherHostedSurface } from '../dashboard/useHostedSurfaceDismiss';

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
  assert.equal(
    isSaveShortcutEvent(keyboardEventLike({ code: 'KeyS', ctrlKey: true, key: 's', shiftKey: true })),
    false,
  );
  assert.equal(
    isSaveShortcutEvent(keyboardEventLike({ code: 'KeyI', ctrlKey: true, key: 'i', shiftKey: true })),
    false,
  );
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
  assert.equal(
    isEditorFindShortcutEvent(keyboardEventLike({ altKey: true, code: 'KeyF', ctrlKey: true, key: 'f' })),
    false,
  );
  assert.equal(
    isEditorFindShortcutEvent(keyboardEventLike({ code: 'KeyF', ctrlKey: true, key: 'f', shiftKey: true })),
    false,
  );
});

test('duplicate shortcut detection accepts physical KeyD and rejects browser-adjacent shortcuts', () => {
  assert.equal(isEditorDuplicateShortcutEvent(keyboardEventLike({ code: 'KeyD', ctrlKey: true, key: 'd' })), true);
  assert.equal(isEditorDuplicateShortcutEvent(keyboardEventLike({ code: 'KeyD', ctrlKey: true, key: 'x' })), true);
  assert.equal(isEditorDuplicateShortcutEvent(keyboardEventLike({ code: 'KeyD', key: 'd', metaKey: true })), true);
  assert.equal(isEditorDuplicateShortcutEvent(keyboardEventLike({ code: 'KeyF', ctrlKey: true, key: 'f' })), false);
  assert.equal(
    isEditorDuplicateShortcutEvent(keyboardEventLike({ altKey: true, code: 'KeyD', ctrlKey: true, key: 'd' })),
    false,
  );
  assert.equal(
    isEditorDuplicateShortcutEvent(keyboardEventLike({ code: 'KeyD', ctrlKey: true, key: 'd', shiftKey: true })),
    false,
  );
});
test('project-tree rename only accepts one plain F2 keydown', () => {
  assert.equal(isPlainF2ShortcutEvent(keyboardEventLike({ key: 'F2' })), true);
  assert.equal(isPlainF2ShortcutEvent(keyboardEventLike({ ctrlKey: true, key: 'F2' })), false);
  assert.equal(isPlainF2ShortcutEvent(keyboardEventLike({ key: 'F2', repeat: true })), false);
  assert.equal(isPlainF2ShortcutEvent(keyboardEventLike({ key: 'F2', shiftKey: true })), false);
});

function surfaceDocument() {
  return Object.assign(new EventTarget(), {
    defaultView: null as unknown,
    querySelector: () => null as unknown,
  });
}

test('cross-surface dismissal listens only to the opposite document without canceling input', () => {
  const dashboard = surfaceDocument();
  const editor = surfaceDocument();
  const view = Object.assign(new EventTarget(), {
    parent: {},
    frameElement: { matches: () => true, ownerDocument: dashboard },
  });
  editor.defaultView = view;
  let dismissed = 0;
  const stop = subscribeToOtherHostedSurface(editor as unknown as Document, () => dismissed++);
  editor.dispatchEvent(new Event('pointerdown'));
  editor.dispatchEvent(new Event('click'));
  for (const type of ['focus', 'blur', 'keydown']) dashboard.dispatchEvent(new Event(type));
  assert.equal(dismissed, 0, 'focus changes and editor-local input are not outside interactions');
  for (const type of ['pointerdown', 'click', 'contextmenu']) {
    const event = new Event(type, { cancelable: true });
    dashboard.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(dismissed, 3);
  stop();
  dashboard.dispatchEvent(new Event('pointerdown'));
  dashboard.dispatchEvent(new Event('click'));
  assert.equal(dismissed, 3, 'closed/unmounted menus have no retained listener');
});

test('editor document lifecycle releases parent listeners and restores only live subscriptions', () => {
  const dashboard = surfaceDocument();
  const editor = surfaceDocument();
  const view = Object.assign(new EventTarget(), {
    parent: {},
    frameElement: { matches: () => true, ownerDocument: dashboard },
  });
  editor.defaultView = view;
  let dismissed = 0;
  const stop = subscribeToOtherHostedSurface(editor as unknown as Document, () => dismissed++);
  dashboard.dispatchEvent(new Event('click'));
  assert.equal(dismissed, 1);
  view.dispatchEvent(new Event('pagehide'));
  dashboard.dispatchEvent(new Event('click'));
  assert.equal(dismissed, 1, 'hidden/navigated-away documents release their parent listeners');
  view.dispatchEvent(new Event('pageshow'));
  dashboard.dispatchEvent(new Event('click'));
  assert.equal(dismissed, 2, 'a restored document resumes its existing open menu subscription');
  stop();
  view.dispatchEvent(new Event('pagehide'));
  view.dispatchEvent(new Event('pageshow'));
  dashboard.dispatchEvent(new Event('click'));
  assert.equal(dismissed, 2, 'disposed menus never reattach on pageshow');
});

test('dashboard dismissal rebinds after editor reload and releases old documents', () => {
  const dashboard = surfaceDocument();
  const firstEditor = surfaceDocument();
  const nextEditor = surfaceDocument();
  const frame = Object.assign(new EventTarget(), { contentDocument: firstEditor });
  dashboard.querySelector = () => frame;
  let dismissed = 0;
  const stop = subscribeToOtherHostedSurface(dashboard as unknown as Document, () => dismissed++);
  firstEditor.dispatchEvent(new Event('pointerdown'));
  assert.equal(dismissed, 1);
  frame.contentDocument = nextEditor;
  frame.dispatchEvent(new Event('load'));
  firstEditor.dispatchEvent(new Event('pointerdown'));
  assert.equal(dismissed, 1);
  nextEditor.dispatchEvent(new Event('contextmenu'));
  assert.equal(dismissed, 2);
  Object.defineProperty(frame, 'contentDocument', {
    get() {
      throw new Error('cross origin after navigation');
    },
  });
  frame.dispatchEvent(new Event('load'));
  nextEditor.dispatchEvent(new Event('pointerdown'));
  assert.equal(dismissed, 2, 'navigation to an inaccessible document releases the previous listener');
  stop();
  frame.dispatchEvent(new Event('load'));
  nextEditor.dispatchEvent(new Event('pointerdown'));
  assert.equal(dismissed, 2);
});

test('unavailable and unrelated frames do not acquire cross-surface listeners', () => {
  const parent = surfaceDocument();
  const owner = surfaceDocument();
  let dismissed = 0;
  for (const frameElement of [null, { matches: () => false, ownerDocument: parent }]) {
    owner.defaultView = { parent: {}, frameElement };
    const stop = subscribeToOtherHostedSurface(owner as unknown as Document, () => dismissed++);
    parent.dispatchEvent(new Event('pointerdown'));
    stop();
  }
  owner.defaultView = {
    parent: {},
    get frameElement() {
      throw new Error('cross origin');
    },
  };
  const stop = subscribeToOtherHostedSurface(owner as unknown as Document, () => dismissed++);
  parent.dispatchEvent(new Event('pointerdown'));
  stop();
  assert.equal(dismissed, 0);
});

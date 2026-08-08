import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blurCanvasNavigationShortcutFocus,
  getCanvasNavigationShortcut,
  GRAPH_HISTORY_NEXT_TOOLTIP,
  GRAPH_HISTORY_PREVIOUS_TOOLTIP,
  GRAPH_TREE_TOGGLE_SHORTCUT_LABEL,
  MAIN_GRAPH_SHORTCUT_LABEL,
} from './canvasNavigationShortcuts.js';

const BASE_EVENT = {
  altKey: false,
  code: '',
  ctrlKey: false,
  key: '',
  metaKey: false,
  shiftKey: false,
};

test('canvas navigation shortcuts resolve graph history keys', () => {
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, key: 'PageUp' }), 'previousGraph');
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, code: 'PageUp', key: '' }), 'previousGraph');
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, key: 'PageDown' }), 'nextGraph');
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, code: 'PageDown', key: '' }), 'nextGraph');
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, key: 'Home' }), 'openMainGraph');
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, code: 'Home', key: '' }), 'openMainGraph');
});

test('canvas navigation shortcuts ignore modified page navigation keys', () => {
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, ctrlKey: true, key: 'PageUp' }), undefined);
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, shiftKey: true, key: 'PageDown' }), undefined);
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, metaKey: true, key: 'Home' }), undefined);
});

test('canvas navigation shortcuts resolve graph tree toggle keys', () => {
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, ctrlKey: true, key: 'q' }), 'toggleGraphTree');
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, metaKey: true, key: 'Q' }), 'toggleGraphTree');
  assert.equal(getCanvasNavigationShortcut({ ...BASE_EVENT, ctrlKey: true, code: 'KeyQ', key: '' }), 'toggleGraphTree');
  assert.equal(
    getCanvasNavigationShortcut({ ...BASE_EVENT, ctrlKey: true, code: 'KeyQ', key: '\u0439' }),
    'toggleGraphTree',
  );
});

test('canvas navigation shortcut tooltip labels expose the requested keys', () => {
  assert.equal(GRAPH_HISTORY_PREVIOUS_TOOLTIP, 'Go to previous graph (PgUp)');
  assert.equal(GRAPH_HISTORY_NEXT_TOOLTIP, 'Go to next graph (PgDwn)');
  assert.equal(MAIN_GRAPH_SHORTCUT_LABEL, 'Home');
  assert.equal(GRAPH_TREE_TOGGLE_SHORTCUT_LABEL, 'Ctrl+Q / Cmd+Q');
});

test('canvas navigation shortcuts can clear active browser focus after firing', () => {
  let blurCount = 0;

  blurCanvasNavigationShortcutFocus({
    blur: () => {
      blurCount += 1;
    },
  });
  blurCanvasNavigationShortcutFocus(undefined);

  assert.equal(blurCount, 1);
});

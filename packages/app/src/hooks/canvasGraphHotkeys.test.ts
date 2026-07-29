import assert from 'node:assert/strict';
import test from 'node:test';
import { getCanvasGraphHotkey } from './canvasGraphHotkeys.js';

const RUSSIAN_LAYOUT_EVENT = {
  altKey: false,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
};

test('canvas graph commands use physical letter codes with a non-Latin keyboard layout', () => {
  assert.equal(getCanvasGraphHotkey({ ...RUSSIAN_LAYOUT_EVENT, code: 'KeyF', key: '\u0430' }), 'search');
  assert.equal(getCanvasGraphHotkey({ ...RUSSIAN_LAYOUT_EVENT, code: 'KeyZ', key: '\u044f' }), 'undo');
  assert.equal(getCanvasGraphHotkey({ ...RUSSIAN_LAYOUT_EVENT, code: 'KeyP', key: '\u0437' }), 'goTo');
  assert.equal(getCanvasGraphHotkey({ ...RUSSIAN_LAYOUT_EVENT, code: 'KeyA', key: '\u0444' }), 'selectAll');
  assert.equal(getCanvasGraphHotkey({ ...RUSSIAN_LAYOUT_EVENT, code: 'KeyI', key: '\u0448' }), 'openAiGraphCreator');
});

test('canvas graph commands retain their modifier and shift semantics', () => {
  assert.equal(
    getCanvasGraphHotkey({ ...RUSSIAN_LAYOUT_EVENT, code: 'KeyZ', key: '\u042f', shiftKey: true }),
    'redoWithShift',
  );
  assert.equal(getCanvasGraphHotkey({ ...RUSSIAN_LAYOUT_EVENT, altKey: true, code: 'KeyF', key: '\u0430' }), undefined);
  assert.equal(
    getCanvasGraphHotkey({
      altKey: false,
      code: 'KeyE',
      ctrlKey: false,
      key: '\u0443',
      metaKey: false,
      shiftKey: false,
    }),
    'editHoveredNode',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { getNodeClipboardShortcut } from './useCopyNodesHotkeys.js';

test('node clipboard shortcuts use physical letter codes for non-Latin layouts', () => {
  assert.equal(
    getNodeClipboardShortcut({
      altKey: false,
      code: 'KeyV',
      ctrlKey: true,
      key: '\u043c',
      metaKey: false,
      shiftKey: false,
    }),
    'paste',
  );
});

test('node clipboard shortcuts do not consume AltGr-style key presses', () => {
  assert.equal(
    getNodeClipboardShortcut({
      altKey: true,
      code: 'KeyC',
      ctrlKey: true,
      key: '\u0441',
      metaKey: false,
      shiftKey: false,
    }),
    undefined,
  );
});

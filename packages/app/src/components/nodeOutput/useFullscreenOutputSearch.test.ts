import assert from 'node:assert/strict';
import test from 'node:test';
import { isFullscreenOutputSearchShortcut } from './useFullscreenOutputSearch.js';

test('fullscreen output search uses the physical F key for non-Latin layouts', () => {
  assert.equal(
    isFullscreenOutputSearchShortcut({
      altKey: false,
      code: 'KeyF',
      ctrlKey: true,
      key: '\u0430',
      metaKey: false,
      shiftKey: false,
    }),
    true,
  );
});

test('fullscreen output search rejects AltGr-style and shifted shortcuts', () => {
  assert.equal(
    isFullscreenOutputSearchShortcut({
      altKey: true,
      code: 'KeyF',
      ctrlKey: true,
      key: '\u0430',
      metaKey: false,
      shiftKey: false,
    }),
    false,
  );
  assert.equal(
    isFullscreenOutputSearchShortcut({
      altKey: false,
      code: 'KeyF',
      ctrlKey: true,
      key: '\u0410',
      metaKey: false,
      shiftKey: true,
    }),
    false,
  );
});

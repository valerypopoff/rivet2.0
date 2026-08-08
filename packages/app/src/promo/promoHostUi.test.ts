import assert from 'node:assert/strict';
import test from 'node:test';
import { PROMO_HOST_UI } from './promoHostUi.js';

test('GitHub Pages demo exposes only its intentionally limited editor surface', () => {
  assert.deepEqual(PROMO_HOST_UI.fileMenu.visibleItems, ['new_project', 'open_project', 'save_project', 'settings']);
  assert.deepEqual(PROMO_HOST_UI.capabilities, {
    aiAssist: false,
    aiGraphBuilder: false,
    recordings: false,
    trivetInputCopy: false,
  });
});

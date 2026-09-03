import assert from 'node:assert/strict';
import test from 'node:test';
import { getFullscreenOutputKeyboardScrollTarget, isFullscreenOutputScrollKey } from './fullscreenOutputKeyboardNavigation.js';

test('PgDn and PgUp align full output scrolling to adjacent response items', () => {
  const sharedOptions = {
    itemTopOffsets: [0, 160, 340],
    maxScrollTop: 500,
    stickyHeaderHeight: 40,
  };

  assert.equal(getFullscreenOutputKeyboardScrollTarget({ ...sharedOptions, key: 'PageDown', currentScrollTop: 0 }), 120);
  assert.equal(getFullscreenOutputKeyboardScrollTarget({ ...sharedOptions, key: 'PageDown', currentScrollTop: 120 }), 300);
  assert.equal(getFullscreenOutputKeyboardScrollTarget({ ...sharedOptions, key: 'PageUp', currentScrollTop: 300 }), 120);
});

test('PgUp and PgDn stop at semantic-item boundaries instead of pixel-scrolling or jumping to an edge', () => {
  const sharedOptions = {
    itemTopOffsets: [160, 340, Number.NaN, 340],
    maxScrollTop: 500,
    stickyHeaderHeight: 40,
  };

  assert.equal(getFullscreenOutputKeyboardScrollTarget({ ...sharedOptions, key: 'PageUp', currentScrollTop: 0 }), 0);
  assert.equal(getFullscreenOutputKeyboardScrollTarget({ ...sharedOptions, key: 'PageDown', currentScrollTop: 300 }), 300);
  assert.equal(
    getFullscreenOutputKeyboardScrollTarget({ ...sharedOptions, itemTopOffsets: [], key: 'PageDown', currentScrollTop: 280 }),
    280,
  );
});

test('Home and End reach content boundaries', () => {
  const sharedOptions = { itemTopOffsets: [160], maxScrollTop: 500, stickyHeaderHeight: 40 };
  assert.equal(getFullscreenOutputKeyboardScrollTarget({ ...sharedOptions, key: 'Home', currentScrollTop: 280 }), 0);
  assert.equal(getFullscreenOutputKeyboardScrollTarget({ ...sharedOptions, key: 'End', currentScrollTop: 280 }), 500);
  assert.equal(isFullscreenOutputScrollKey('PageDown'), true);
  assert.equal(isFullscreenOutputScrollKey('ArrowDown'), false);
});

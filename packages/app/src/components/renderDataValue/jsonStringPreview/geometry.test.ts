import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateJsonStringPreviewPopoverPosition,
  getLeftResizePopoverWidth,
  getVisibleJsonStringEditModalSize,
  getVisibleJsonStringPreviewPopoverMaxHeight,
  getVisibleJsonStringPreviewPopoverWidth,
} from './geometry.js';

test('popover placement clamps one explicit viewport coordinate system', () => {
  assert.deepEqual(
    calculateJsonStringPreviewPopoverPosition({ bottom: 760, left: 990 }, 420, { height: 800, width: 1000 }),
    { left: 568, top: 697 },
  );
  assert.equal(getVisibleJsonStringPreviewPopoverWidth(420, 700, 1000), 288);
  assert.equal(getVisibleJsonStringPreviewPopoverMaxHeight(720, 697, 800), 48);
});

test('left-corner resizing preserves the right edge within viewport bounds', () => {
  assert.equal(getLeftResizePopoverWidth(500, 620), 500);
  assert.equal(getLeftResizePopoverWidth(800, 620), 608);
});

test('saved edit modal dimensions are clamped to the current viewport', () => {
  assert.deepEqual(getVisibleJsonStringEditModalSize({ height: 1000, width: 1400 }, { height: 900, width: 1200 }), {
    height: 876,
    width: 1176,
  });
  assert.deepEqual(getVisibleJsonStringEditModalSize({ height: 1, width: 1 }, { height: 900, width: 1200 }), {
    height: 520,
    width: 560,
  });
});

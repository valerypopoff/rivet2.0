import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS,
  areRunActivityColumnWidthsEqual,
  clampRunActivityColumnWidth,
  getRunActivityColumnWidthBounds,
  normalizeRunActivityColumnWidths,
} from './runActivityColumnWidths.js';

test('normalizes malformed persisted Run Activity column widths to bounded defaults', () => {
  assert.deepEqual(normalizeRunActivityColumnWidths(undefined), DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS);
  assert.deepEqual(normalizeRunActivityColumnWidths({ nodeName: 'wide', graphName: -10, nodeType: Infinity }), {
    nodeName: DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS.nodeName,
    graphName: getRunActivityColumnWidthBounds('graphName').minWidth,
    nodeType: DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS.nodeType,
  });
});

test('clamps persisted and interactive widths to the declared per-column bounds', () => {
  const node = getRunActivityColumnWidthBounds('nodeName');
  assert.equal(clampRunActivityColumnWidth('nodeName', node.minWidth - 1), node.minWidth);
  assert.equal(clampRunActivityColumnWidth('nodeName', node.maxWidth + 1), node.maxWidth);
  assert.equal(clampRunActivityColumnWidth('nodeName', 211.8), 212);
});

test('recognizes only the complete persisted preference shape as normalized', () => {
  assert.equal(
    areRunActivityColumnWidthsEqual(DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS, DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS),
    true,
  );
  assert.equal(
    areRunActivityColumnWidthsEqual(
      { ...DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS, legacyWidth: 200 },
      DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS,
    ),
    false,
  );
});

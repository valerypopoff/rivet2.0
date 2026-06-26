import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { shouldShowMultiNodeAlignmentToolbar } from './MultiNodeAlignmentToolbar.js';

test('shouldShowMultiNodeAlignmentToolbar only shows for editable multi-selection sessions', () => {
  assert.equal(
    shouldShowMultiNodeAlignmentToolbar({
      selectedNodeCount: 1,
      isReadOnlyGraph: false,
    }),
    false,
  );

  assert.equal(
    shouldShowMultiNodeAlignmentToolbar({
      selectedNodeCount: 2,
      isReadOnlyGraph: true,
    }),
    false,
  );

  assert.equal(
    shouldShowMultiNodeAlignmentToolbar({
      selectedNodeCount: 2,
      isReadOnlyGraph: false,
    }),
    true,
  );
});

test('MultiNodeAlignmentToolbar keeps vertical align row above horizontal align row', () => {
  const source = readFileSync(new URL('./MultiNodeAlignmentToolbar.tsx', import.meta.url), 'utf8');
  const topIndex = source.indexOf('label="Align top"');
  const leftIndex = source.indexOf('label="Align left"');
  const equalWidthIndex = source.indexOf('label="Make equal width"');
  const distributeIndex = source.indexOf('label="Distribute horizontally"');

  assert.ok(topIndex >= 0);
  assert.ok(leftIndex > topIndex);
  assert.ok(equalWidthIndex > leftIndex);
  assert.ok(distributeIndex > equalWidthIndex);
});

test('MultiNodeAlignmentToolbar supports controlled non-graph canvases', () => {
  const source = readFileSync(new URL('./MultiNodeAlignmentToolbar.tsx', import.meta.url), 'utf8');

  assert.match(source, /nodes\?: ChartNode\[\]/);
  assert.match(source, /onNodesChanged\?: \(nodes: ChartNode\[\]\) => void/);
  assert.match(source, /const controlledCanvas = Boolean\(nodes && onNodesChanged\)/);
  assert.match(source, /applyLocalNodeUpdates/);
  assert.match(source, /isReadOnlyGraph: controlledCanvas \? false : isReadOnlyGraph/);
});

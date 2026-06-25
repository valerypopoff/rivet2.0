import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, NodeId } from '@valerypopoff/rivet2-core';
import {
  applyResizeBoundsToNode,
  applyResizeChangesToNodes,
  calculateNodeResizeGroupChanges,
  computeBoxNodeResizeBounds,
  computeHorizontalNodeResizeBounds,
  haveHorizontalNodeResizeBoundsChanged,
  MIN_NODE_WIDTH,
  type NodeResizeBounds,
  type NodeResizeChange,
} from './nodeResize.js';

function asNodeId(id: string): NodeId {
  return id as NodeId;
}

function textNode(id: NodeId): ChartNode {
  return {
    id,
    type: 'text',
    title: id,
    data: {},
    visualData: {
      x: 100,
      y: 200,
      width: 300,
    },
  };
}

function commentNode(id: NodeId): ChartNode {
  return {
    ...textNode(id),
    type: 'comment',
    data: {
      height: 180,
    },
  };
}

function resizeChange(node: ChartNode, nextBounds: NodeResizeBounds): NodeResizeChange {
  return { nodeId: node.id, nextBounds, previousNode: node };
}

test('computeHorizontalNodeResizeBounds expands from the right edge without moving x', () => {
  const resized = computeHorizontalNodeResizeBounds({
    direction: 'right',
    initialWidth: 300,
    initialX: 120,
    deltaX: 40,
  });

  assert.deepEqual(resized, {
    x: 120,
    width: 340,
  });
});

test('computeHorizontalNodeResizeBounds shrinks from the left edge and preserves the right edge', () => {
  const resized = computeHorizontalNodeResizeBounds({
    direction: 'left',
    initialWidth: 300,
    initialX: 120,
    deltaX: 40,
  });

  assert.deepEqual(resized, {
    x: 160,
    width: 260,
  });
});

test('computeHorizontalNodeResizeBounds clamps left-edge resize at the minimum width', () => {
  const resized = computeHorizontalNodeResizeBounds({
    direction: 'left',
    initialWidth: 300,
    initialX: 120,
    deltaX: 260,
  });

  assert.deepEqual(resized, {
    x: 120 + (300 - MIN_NODE_WIDTH),
    width: MIN_NODE_WIDTH,
  });
});

test('computeHorizontalNodeResizeBounds accepts a node-specific minimum width', () => {
  const resized = computeHorizontalNodeResizeBounds({
    direction: 'right',
    initialWidth: 300,
    initialX: 120,
    deltaX: -120,
    minWidth: 240,
  });

  assert.deepEqual(resized, {
    x: 120,
    width: 240,
  });
});

test('computeHorizontalNodeResizeBounds preserves the right edge for subpixel left-edge resizes', () => {
  const resized = computeHorizontalNodeResizeBounds({
    direction: 'left',
    initialWidth: 300.5,
    initialX: 120.25,
    deltaX: 10.25,
  });

  assert.equal(resized.x + resized.width, 420.75);
  assert.equal(resized.width, 290.25);
});

test('haveHorizontalNodeResizeBoundsChanged only reports real x or width changes', () => {
  assert.equal(
    haveHorizontalNodeResizeBoundsChanged(
      { x: 120, width: 300 },
      { x: 120, width: 300 },
    ),
    false,
  );

  assert.equal(
    haveHorizontalNodeResizeBoundsChanged(
      { x: 120, width: 300 },
      { x: 120, width: 301 },
    ),
    true,
  );
});

test('computeBoxNodeResizeBounds resizes comments from the bottom-right corner', () => {
  const resized = computeBoxNodeResizeBounds({
    direction: 'bottom-right',
    initialHeight: 200,
    initialWidth: 300,
    initialX: 120,
    initialY: 80,
    deltaX: 40,
    deltaY: 25,
  });

  assert.deepEqual(resized, {
    x: 120,
    y: 80,
    width: 340,
    height: 225,
  });
});

test('computeBoxNodeResizeBounds preserves the opposite corner when resizing from top-left', () => {
  const resized = computeBoxNodeResizeBounds({
    direction: 'top-left',
    initialHeight: 200,
    initialWidth: 300,
    initialX: 120,
    initialY: 80,
    deltaX: 40,
    deltaY: 25,
  });

  assert.deepEqual(resized, {
    x: 160,
    y: 105,
    width: 260,
    height: 175,
  });
});

test('calculateNodeResizeGroupChanges applies right-edge width deltas to the group', () => {
  const changes = calculateNodeResizeGroupChanges({
    sourceNodeId: 'node-a',
    sourceNextBounds: { x: 100, width: 360 },
    snapshots: [
      { nodeId: 'node-a', x: 100, width: 300, minWidth: 160 },
      { nodeId: 'node-b', x: 500, width: 240, minWidth: 160 },
    ],
  });

  assert.deepEqual(changes, [
    { nodeId: 'node-a', nextBounds: { x: 100, y: undefined, width: 360, height: undefined } },
    { nodeId: 'node-b', nextBounds: { x: 500, width: 300 } },
  ]);
});

test('calculateNodeResizeGroupChanges preserves each right edge for left-edge group resize', () => {
  const changes = calculateNodeResizeGroupChanges({
    sourceNodeId: 'node-a',
    sourceNextBounds: { x: 140, width: 260 },
    snapshots: [
      { nodeId: 'node-a', x: 100, width: 300, minWidth: 160 },
      { nodeId: 'node-b', x: 500, width: 240, minWidth: 160 },
    ],
  });

  assert.deepEqual(changes, [
    { nodeId: 'node-a', nextBounds: { x: 140, y: undefined, width: 260, height: undefined } },
    { nodeId: 'node-b', nextBounds: { x: 540, width: 200 } },
  ]);
});

test('calculateNodeResizeGroupChanges clamps nodes that cannot shrink by the full delta', () => {
  const changes = calculateNodeResizeGroupChanges({
    sourceNodeId: 'node-a',
    sourceNextBounds: { x: 100, width: 180 },
    snapshots: [
      { nodeId: 'node-a', x: 100, width: 300, minWidth: 160 },
      { nodeId: 'node-b', x: 500, width: 240, minWidth: 200 },
    ],
  });

  assert.deepEqual(changes, [
    { nodeId: 'node-a', nextBounds: { x: 100, y: undefined, width: 180, height: undefined } },
    { nodeId: 'node-b', nextBounds: { x: 500, width: 200 } },
  ]);
});

test('calculateNodeResizeGroupChanges keeps source-only y and height changes', () => {
  const changes = calculateNodeResizeGroupChanges({
    sourceNodeId: 'node-a',
    sourceNextBounds: { x: 80, y: 60, width: 320, height: 180 },
    snapshots: [
      { nodeId: 'node-a', x: 100, y: 50, width: 300, height: 150, minWidth: 160 },
      { nodeId: 'node-b', x: 500, width: 240, minWidth: 160 },
    ],
  });

  assert.deepEqual(changes, [
    { nodeId: 'node-a', nextBounds: { x: 80, y: 60, width: 320, height: 180 } },
    { nodeId: 'node-b', nextBounds: { x: 480, width: 260 } },
  ]);
});

test('calculateNodeResizeGroupChanges returns no changes when the source snapshot is absent', () => {
  const changes = calculateNodeResizeGroupChanges({
    sourceNodeId: 'node-a',
    sourceNextBounds: { x: 100, width: 360 },
    snapshots: [{ nodeId: 'node-b', x: 500, width: 240, minWidth: 160 }],
  });

  assert.deepEqual(changes, []);
});

test('applyResizeBoundsToNode updates normal node position and width without losing visual data', () => {
  const node = {
    ...textNode(asNodeId('node')),
    visualData: {
      x: 100,
      y: 200,
      width: 300,
      zIndex: 7,
    },
  };

  const resized = applyResizeBoundsToNode(node, { x: 140, width: 360 });

  assert.deepEqual(resized.visualData, {
    x: 140,
    y: 200,
    width: 360,
    zIndex: 7,
  });
  assert.notEqual(resized, node);
});

test('applyResizeBoundsToNode updates comment height only when a height is provided', () => {
  const node = commentNode(asNodeId('comment'));

  const widthOnly = applyResizeBoundsToNode(node, { x: 120, width: 320 });
  const withHeight = applyResizeBoundsToNode(node, { x: 120, y: 210, width: 320, height: 260 });

  assert.deepEqual(widthOnly.data, { height: 180 });
  assert.deepEqual(withHeight.visualData, { x: 120, y: 210, width: 320 });
  assert.deepEqual(withHeight.data, { height: 260 });
});

test('applyResizeChangesToNodes updates node lists and can require every changed node to exist', () => {
  const normalNode = textNode(asNodeId('normal'));
  const noteNode = commentNode(asNodeId('comment'));
  const missingNode = textNode(asNodeId('missing'));
  const nextNodes = applyResizeChangesToNodes([normalNode, noteNode], [
    resizeChange(normalNode, { x: 120, width: 340 }),
    resizeChange(noteNode, { x: 140, y: 220, width: 360, height: 210 }),
  ]);

  assert.deepEqual(nextNodes[0]!.visualData, { x: 120, y: 200, width: 340 });
  assert.deepEqual(nextNodes[1]!.visualData, { x: 140, y: 220, width: 360 });
  assert.deepEqual(nextNodes[1]!.data, { height: 210 });
  assert.throws(
    () =>
      applyResizeChangesToNodes(
        [normalNode],
        [resizeChange(missingNode, { x: 120, width: 340 })],
        { requireAllChanges: true },
      ),
    /Node with id missing not found/,
  );
});

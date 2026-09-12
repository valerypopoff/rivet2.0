import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProjectConnectionComparisonKey,
  type ChartNode,
  type CommentNode,
  type NodeConnection,
  type NodeId,
} from '@valerypopoff/rivet2-core';
import {
  constrainDragDeltaToAxisLock,
  createDragDuplicatePreviewNodes,
  isNodeFullyInsideCommentBounds,
  getDraggingConnectionSourceNodeIds,
  getDraggingPreviewNodes,
  resolveCommentEnclosureDraggedConnectionBendKeys,
  resolveCommentEnclosureDraggedNodeIds,
  resolveDragAxisLock,
  resolveDraggedNodeIds,
  resolveDraggedSourceNodes,
  resolveDragModeFromAlt,
  shouldDisableCommentEnclosureDragOnKeyUp,
  shouldDisableStraightLineDragOnKeyUp,
  shouldEnableCommentEnclosureDragOnKeyDown,
  shouldEnableStraightLineDragOnKeyDown,
  shouldUseDuplicateDragModeOnKeyDown,
  shouldUseMoveDragModeOnKeyUp,
} from './nodeDragInteraction.js';

function createTextNode(id: string, x: number, y: number, width = 120): ChartNode {
  return {
    id: id as NodeId,
    type: 'text',
    title: id,
    visualData: { x, y, width },
    data: {},
  } as ChartNode;
}

function createCommentNode(id: string, x: number, y: number, width: number, height: number): CommentNode {
  return {
    id: id as NodeId,
    type: 'comment',
    title: id,
    visualData: { x, y, width },
    data: { height, text: '' },
  } as CommentNode;
}

function createConnection(id: string, bendPoint?: { x: number; y: number }): NodeConnection {
  return {
    inputId: 'input',
    inputNodeId: `input-${id}` as NodeId,
    outputId: 'output',
    outputNodeId: `output-${id}` as NodeId,
    bendPoint,
  } as NodeConnection;
}

test('resolveDraggedNodeIds keeps the dragged node in the drag cohort and preserves unique selection ids', () => {
  assert.deepEqual(
    resolveDraggedNodeIds(['node-a' as NodeId, 'node-b' as NodeId], 'node-b' as NodeId),
    ['node-a', 'node-b'],
  );
  assert.deepEqual(resolveDraggedNodeIds([], 'node-c' as NodeId), ['node-c']);
});

test('resolveDraggedSourceNodes filters stale selected ids and keeps the drag session aligned to real source nodes', () => {
  const nodeA = {
    id: 'node-a' as NodeId,
    type: 'text',
    title: 'A',
    visualData: { x: 10, y: 20 },
    data: {},
  } as ChartNode;
  const nodeB = {
    id: 'node-b' as NodeId,
    type: 'text',
    title: 'B',
    visualData: { x: 30, y: 40 },
    data: {},
  } as ChartNode;

  const { sourceNodeIds, sourceNodes } = resolveDraggedSourceNodes(
    ['node-a' as NodeId, 'missing-node' as NodeId, 'node-b' as NodeId],
    {
      [nodeA.id]: nodeA,
      [nodeB.id]: nodeB,
    } as Record<NodeId, ChartNode | undefined>,
  );

  assert.deepEqual(sourceNodeIds, [nodeA.id, nodeB.id]);
  assert.deepEqual(sourceNodes, [nodeA, nodeB]);
});

test('resolveCommentEnclosureDraggedNodeIds adds nodes fully enclosed by dragged comments', () => {
  const comment = createCommentNode('comment', 100, 100, 500, 400);
  const inside = createTextNode('inside', 150, 160, 120);
  const touchingOutsideRight = createTextNode('outside-right', 520, 160, 120);
  const touchingOutsideBottom = createTextNode('outside-bottom', 150, 360, 120);
  const outside = createTextNode('outside', 700, 160, 120);

  const nodeIds = resolveCommentEnclosureDraggedNodeIds({
    draggedNodeIds: [comment.id],
    includeEnclosedNodes: true,
    nodes: [comment, outside, inside, touchingOutsideRight, touchingOutsideBottom],
  });

  assert.deepEqual(nodeIds, [comment.id, inside.id]);
});

test('resolveCommentEnclosureDraggedNodeIds preserves the drag cohort when the modifier is inactive or no comment is dragged', () => {
  const comment = createCommentNode('comment', 100, 100, 500, 400);
  const dragged = createTextNode('dragged', 150, 160, 120);
  const inside = createTextNode('inside', 180, 190, 120);

  assert.deepEqual(
    resolveCommentEnclosureDraggedNodeIds({
      draggedNodeIds: [comment.id],
      includeEnclosedNodes: false,
      nodes: [comment, inside],
    }),
    [comment.id],
  );

  assert.deepEqual(
    resolveCommentEnclosureDraggedNodeIds({
      draggedNodeIds: [dragged.id],
      includeEnclosedNodes: true,
      nodes: [comment, dragged, inside],
    }),
    [dragged.id],
  );
});

test('resolveCommentEnclosureDraggedConnectionBendKeys includes only authored bends inside a Ctrl/Cmd-dragged comment', () => {
  const comment = createCommentNode('comment', 100, 100, 500, 400);
  const nestedComment = createCommentNode('nested-comment', 250, 200, 200, 150);
  const inside = createConnection('inside', { x: 150, y: 150 });
  const nested = createConnection('nested', { x: 300, y: 250 });
  const boundary = createConnection('boundary', { x: 600, y: 500 });
  const outside = createConnection('outside', { x: 601, y: 500 });
  const unbent = createConnection('unbent');

  assert.deepEqual(
    resolveCommentEnclosureDraggedConnectionBendKeys({
      connections: [inside, nested, boundary, outside, unbent],
      draggedNodeIds: [comment.id, nestedComment.id],
      includeEnclosedNodes: true,
      nodes: [comment, nestedComment],
    }),
    [
      getProjectConnectionComparisonKey(inside),
      getProjectConnectionComparisonKey(nested),
      getProjectConnectionComparisonKey(boundary),
    ],
  );
});

test('resolveCommentEnclosureDraggedConnectionBendKeys does not move bends without the modifier or a dragged comment', () => {
  const comment = createCommentNode('comment', 100, 100, 500, 400);
  const node = createTextNode('node', 150, 150);
  const inside = createConnection('inside', { x: 150, y: 150 });

  assert.deepEqual(
    resolveCommentEnclosureDraggedConnectionBendKeys({
      connections: [inside],
      draggedNodeIds: [comment.id],
      includeEnclosedNodes: false,
      nodes: [comment],
    }),
    [],
  );
  assert.deepEqual(
    resolveCommentEnclosureDraggedConnectionBendKeys({
      connections: [inside],
      draggedNodeIds: [node.id],
      includeEnclosedNodes: true,
      nodes: [comment, node],
    }),
    [],
  );
});

test('isNodeFullyInsideCommentBounds uses comment height and full node bounds', () => {
  const comment = createCommentNode('comment', 100, 100, 500, 400);

  assert.equal(isNodeFullyInsideCommentBounds(createTextNode('inside', 150, 160, 120), comment), true);
  assert.equal(isNodeFullyInsideCommentBounds(createTextNode('over-left', 90, 160, 120), comment), false);
  assert.equal(isNodeFullyInsideCommentBounds(createTextNode('over-bottom', 150, 360, 120), comment), false);
});

test('resolveDragModeFromAlt maps modifier state to move vs duplicate drag mode', () => {
  assert.equal(resolveDragModeFromAlt(true), 'duplicate');
  assert.equal(resolveDragModeFromAlt(false), 'move');
});

test('resolveDragAxisLock picks and preserves a straight-line axis only while shift is held', () => {
  assert.equal(
    resolveDragAxisLock({
      axisLock: undefined,
      shiftKey: true,
      delta: { x: 20, y: 5 },
    }),
    'x',
  );
  assert.equal(
    resolveDragAxisLock({
      axisLock: undefined,
      shiftKey: true,
      delta: { x: 4, y: -9 },
    }),
    'y',
  );
  assert.equal(
    resolveDragAxisLock({
      axisLock: 'x',
      shiftKey: true,
      delta: { x: 1, y: 100 },
    }),
    'x',
  );
  assert.equal(
    resolveDragAxisLock({
      axisLock: 'y',
      shiftKey: false,
      delta: { x: 1, y: 100 },
    }),
    undefined,
  );
});

test('constrainDragDeltaToAxisLock zeros the unlocked axis and preserves free dragging otherwise', () => {
  assert.deepEqual(constrainDragDeltaToAxisLock({ x: 12, y: 7 }, 'x'), { x: 12, y: 0 });
  assert.deepEqual(constrainDragDeltaToAxisLock({ x: 12, y: 7 }, 'y'), { x: 0, y: 7 });
  assert.deepEqual(constrainDragDeltaToAxisLock({ x: 12, y: 7 }, undefined), { x: 12, y: 7 });
});

test('drag mode keyboard helpers switch into duplicate on keydown and back to move on keyup', () => {
  assert.equal(shouldUseDuplicateDragModeOnKeyDown({ key: 'Alt', altKey: false }), true);
  assert.equal(shouldUseDuplicateDragModeOnKeyDown({ key: 'x', altKey: true }), true);
  assert.equal(shouldUseDuplicateDragModeOnKeyDown({ key: 'x', altKey: false }), false);

  assert.equal(shouldUseMoveDragModeOnKeyUp({ key: 'Alt', altKey: false }), true);
  assert.equal(shouldUseMoveDragModeOnKeyUp({ key: 'x', altKey: false }), true);
  assert.equal(shouldUseMoveDragModeOnKeyUp({ key: 'x', altKey: true }), false);
});

test('shift drag keyboard helpers enable and disable straight-line locking from either modifier state or key transitions', () => {
  assert.equal(shouldEnableStraightLineDragOnKeyDown({ key: 'Shift', shiftKey: false }), true);
  assert.equal(shouldEnableStraightLineDragOnKeyDown({ key: 'x', shiftKey: true }), true);
  assert.equal(shouldEnableStraightLineDragOnKeyDown({ key: 'x', shiftKey: false }), false);

  assert.equal(shouldDisableStraightLineDragOnKeyUp({ key: 'Shift', shiftKey: false }), true);
  assert.equal(shouldDisableStraightLineDragOnKeyUp({ key: 'x', shiftKey: false }), true);
  assert.equal(shouldDisableStraightLineDragOnKeyUp({ key: 'x', shiftKey: true }), false);
});

test('comment enclosure drag keyboard helpers follow Ctrl/Cmd modifier state', () => {
  assert.equal(shouldEnableCommentEnclosureDragOnKeyDown({ key: 'Control', ctrlKey: false, metaKey: false }), true);
  assert.equal(shouldEnableCommentEnclosureDragOnKeyDown({ key: 'x', ctrlKey: true, metaKey: false }), true);
  assert.equal(shouldEnableCommentEnclosureDragOnKeyDown({ key: 'x', ctrlKey: false, metaKey: true }), true);
  assert.equal(shouldEnableCommentEnclosureDragOnKeyDown({ key: 'x', ctrlKey: false, metaKey: false }), false);

  assert.equal(shouldDisableCommentEnclosureDragOnKeyUp({ key: 'Control', ctrlKey: false, metaKey: false }), true);
  assert.equal(shouldDisableCommentEnclosureDragOnKeyUp({ key: 'x', ctrlKey: false, metaKey: false }), true);
  assert.equal(shouldDisableCommentEnclosureDragOnKeyUp({ key: 'x', ctrlKey: true, metaKey: false }), false);
  assert.equal(shouldDisableCommentEnclosureDragOnKeyUp({ key: 'x', ctrlKey: false, metaKey: true }), false);
});

test('createDragDuplicatePreviewNodes creates fresh ids without mutating source node positions', () => {
  const sourceNodes = [
    {
      id: 'node-a' as NodeId,
      type: 'text',
      title: 'A',
      visualData: { x: 10, y: 20 },
      data: {},
    },
  ] as any;

  const previewNodes = createDragDuplicatePreviewNodes(sourceNodes);

  assert.equal(previewNodes.length, 1);
  assert.notEqual(previewNodes[0]!.id, sourceNodes[0]!.id);
  assert.equal(previewNodes[0]!.visualData.x, 10);
  assert.equal(previewNodes[0]!.visualData.y, 20);
  assert.equal(sourceNodes[0]!.id, 'node-a');
});

test('getDraggingPreviewNodes preserves stable duplicate previews across drag-mode toggles', () => {
  const sourceNodes = [
    {
      id: 'node-a' as NodeId,
      type: 'text',
      title: 'A',
      visualData: { x: 10, y: 20 },
      data: {},
    },
  ] as any;
  const previewNodes = createDragDuplicatePreviewNodes(sourceNodes);

  assert.equal(getDraggingPreviewNodes({ dragMode: 'move', sourceNodes, previewNodes }), sourceNodes);
  assert.equal(getDraggingPreviewNodes({ dragMode: 'duplicate', sourceNodes, previewNodes }), previewNodes);
  assert.equal(getDraggingPreviewNodes({ dragMode: 'duplicate', sourceNodes, previewNodes })[0]!.id, previewNodes[0]!.id);
});

test('getDraggingConnectionSourceNodeIds only exposes overlay wires while moving source nodes', () => {
  const sourceNodeIds = ['node-a' as NodeId, 'node-b' as NodeId];

  assert.deepEqual(getDraggingConnectionSourceNodeIds({ dragMode: 'move', sourceNodeIds }), sourceNodeIds);
  assert.deepEqual(getDraggingConnectionSourceNodeIds({ dragMode: 'duplicate', sourceNodeIds }), []);
});

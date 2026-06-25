import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, NodeId } from '@valerypopoff/rivet2-core';
import {
  createResizeNodeSnapshot,
  getChangedResizeEntries,
  getResizeChangesForGroup,
  getResizeNodeIds,
  parseFiniteStyleNumber,
} from './nodeCanvasResizeModel.js';

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

test('parseFiniteStyleNumber falls back for missing and non-finite values', () => {
  assert.equal(parseFiniteStyleNumber(undefined, 320), 320);
  assert.equal(parseFiniteStyleNumber('auto', 320), 320);
  assert.equal(parseFiniteStyleNumber('12.5px', 320), 12.5);
});

test('getResizeNodeIds returns the selected group only when the source is selected with peers', () => {
  const sourceNodeId = asNodeId('source');
  const peerNodeId = asNodeId('peer');

  assert.deepEqual([...getResizeNodeIds(sourceNodeId, [sourceNodeId, peerNodeId])], [sourceNodeId, peerNodeId]);
  assert.deepEqual([...getResizeNodeIds(sourceNodeId, [peerNodeId])], [sourceNodeId]);
  assert.deepEqual([...getResizeNodeIds(sourceNodeId, [sourceNodeId])], [sourceNodeId]);
});

test('createResizeNodeSnapshot keeps comment y and height but leaves normal nodes width-only', () => {
  const normalSnapshot = createResizeNodeSnapshot({
    height: undefined,
    minWidth: 160,
    node: textNode(asNodeId('normal')),
    width: 300,
  });
  const commentSnapshot = createResizeNodeSnapshot({
    height: 180,
    minWidth: 160,
    node: commentNode(asNodeId('comment')),
    width: 300,
  });

  assert.equal(normalSnapshot.y, undefined);
  assert.equal(normalSnapshot.height, undefined);
  assert.equal(commentSnapshot.y, 200);
  assert.equal(commentSnapshot.height, 180);
  assert.notEqual(normalSnapshot.previousNode, normalSnapshot);
});

test('getResizeChangesForGroup attaches previous nodes for undo', () => {
  const sourceNode = textNode(asNodeId('source'));
  const peerNode = { ...textNode(asNodeId('peer')), visualData: { x: 500, y: 200, width: 240 } };
  const changes = getResizeChangesForGroup({
    sourceNodeId: sourceNode.id,
    sourceNextBounds: { x: 100, width: 360 },
    snapshots: [
      { nodeId: sourceNode.id, x: 100, width: 300, minWidth: 160, previousNode: sourceNode },
      { nodeId: peerNode.id, x: 500, width: 240, minWidth: 160, previousNode: peerNode },
    ],
  });

  assert.deepEqual(
    changes.map((change) => ({
      nodeId: change.nodeId,
      nextBounds: change.nextBounds,
      previousNodeId: change.previousNode.id,
    })),
    [
      {
        nodeId: sourceNode.id,
        nextBounds: { x: 100, y: undefined, width: 360, height: undefined },
        previousNodeId: sourceNode.id,
      },
      {
        nodeId: peerNode.id,
        nextBounds: { x: 500, width: 300 },
        previousNodeId: peerNode.id,
      },
    ],
  );
});

test('getChangedResizeEntries ignores unchanged optional y and height bounds', () => {
  const node = textNode(asNodeId('node'));
  const snapshot = { nodeId: node.id, x: 100, width: 300, minWidth: 160, previousNode: node };

  assert.deepEqual(
    getChangedResizeEntries({
      snapshots: [snapshot],
      changes: [{ nodeId: node.id, nextBounds: { x: 100, width: 300 }, previousNode: node }],
    }),
    [],
  );
  assert.equal(
    getChangedResizeEntries({
      snapshots: [snapshot],
      changes: [{ nodeId: node.id, nextBounds: { x: 100, width: 301 }, previousNode: node }],
    }).length,
    1,
  );
});

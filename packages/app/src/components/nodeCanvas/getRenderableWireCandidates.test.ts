import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProjectConnectionComparisonKey,
  type NodeConnection,
  type NodeId,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { getRenderableWireCandidates } from './getRenderableWireCandidates.js';

const asNodeId = (value: string) => value as NodeId;
const asPortId = (value: string) => value as PortId;

const connectionVisible = {
  inputId: asPortId('in-a'),
  inputNodeId: asNodeId('node-a'),
  outputId: asPortId('out-b'),
  outputNodeId: asNodeId('node-b'),
} satisfies NodeConnection;

const connectionNear = {
  inputId: asPortId('in-c'),
  inputNodeId: asNodeId('node-c'),
  outputId: asPortId('out-d'),
  outputNodeId: asNodeId('node-d'),
} satisfies NodeConnection;

const connectionOffscreen = {
  inputId: asPortId('in-e'),
  inputNodeId: asNodeId('node-e'),
  outputId: asPortId('out-f'),
  outputNodeId: asNodeId('node-f'),
} satisfies NodeConnection;

const allConnections = [connectionVisible, connectionNear, connectionOffscreen];

test('getRenderableWireCandidates keeps connections with a visible endpoint', () => {
  const candidates = getRenderableWireCandidates({
    connections: allConnections,
    draggingNode: false,
    draggingWire: false,
    nearViewportNodeIdSet: new Set(),
    runningNodeIdSet: new Set(),
    visibleNodeIdSet: new Set([asNodeId('node-a')]),
  });

  assert.deepEqual(candidates, [connectionVisible]);
});

test('getRenderableWireCandidates keeps connections with a near-viewport endpoint', () => {
  const candidates = getRenderableWireCandidates({
    connections: allConnections,
    draggingNode: false,
    draggingWire: false,
    nearViewportNodeIdSet: new Set([asNodeId('node-d')]),
    runningNodeIdSet: new Set(),
    visibleNodeIdSet: new Set(),
  });

  assert.deepEqual(candidates, [connectionNear]);
});

test('getRenderableWireCandidates keeps highlighted node and port connections', () => {
  const highlightedByNode = getRenderableWireCandidates({
    connections: allConnections,
    draggingNode: false,
    draggingWire: false,
    highlightedNodes: [asNodeId('node-f')],
    nearViewportNodeIdSet: new Set(),
    runningNodeIdSet: new Set(),
    visibleNodeIdSet: new Set(),
  });
  const highlightedByPort = getRenderableWireCandidates({
    connections: allConnections,
    draggingNode: false,
    draggingWire: false,
    highlightedPort: {
      isInput: false,
      nodeId: asNodeId('node-f'),
      portId: asPortId('out-f'),
    },
    nearViewportNodeIdSet: new Set(),
    runningNodeIdSet: new Set(),
    visibleNodeIdSet: new Set(),
  });

  assert.deepEqual(highlightedByNode, [connectionOffscreen]);
  assert.deepEqual(highlightedByPort, [connectionOffscreen]);
});

test('getRenderableWireCandidates keeps connections for currently running nodes', () => {
  const candidates = getRenderableWireCandidates({
    connections: allConnections,
    draggingNode: false,
    draggingWire: false,
    nearViewportNodeIdSet: new Set(),
    runningNodeIdSet: new Set([asNodeId('node-f')]),
    visibleNodeIdSet: new Set(),
  });

  assert.deepEqual(candidates, [connectionOffscreen]);
});

test('getRenderableWireCandidates excludes fully offscreen non-highlighted connections', () => {
  const candidates = getRenderableWireCandidates({
    connections: allConnections,
    draggingNode: false,
    draggingWire: false,
    nearViewportNodeIdSet: new Set(),
    runningNodeIdSet: new Set(),
    visibleNodeIdSet: new Set(),
  });

  assert.deepEqual(candidates, []);
});

test('getRenderableWireCandidates keeps explicitly revealed Data Bus connections outside the viewport', () => {
  const candidates = getRenderableWireCandidates({
    connections: allConnections,
    draggingNode: false,
    draggingWire: false,
    forceRenderableConnectionKeySet: new Set([getProjectConnectionComparisonKey(connectionOffscreen)]),
    nearViewportNodeIdSet: new Set(),
    runningNodeIdSet: new Set(),
    visibleNodeIdSet: new Set(),
  });

  assert.deepEqual(candidates, [connectionOffscreen]);
});

test('getRenderableWireCandidates preserves connection identity and order', () => {
  const candidates = getRenderableWireCandidates({
    connections: allConnections,
    draggingNode: false,
    draggingWire: false,
    highlightedNodes: [asNodeId('node-a'), asNodeId('node-d')],
    nearViewportNodeIdSet: new Set(),
    runningNodeIdSet: new Set(),
    visibleNodeIdSet: new Set(),
  });

  assert.equal(candidates[0], connectionVisible);
  assert.equal(candidates[1], connectionNear);
});

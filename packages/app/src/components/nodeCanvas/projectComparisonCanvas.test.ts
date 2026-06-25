import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, GraphId, NodeId, PortId, ProjectGraphComparison } from '@valerypopoff/rivet2-core';
import {
  EMPTY_CANVAS_PROJECT_COMPARISON_RENDER_STATE,
  getCanvasNodeCompareKindsById,
  getCanvasProjectComparisonRenderState,
} from './projectComparisonCanvas.js';

function asGraphId(id: string): GraphId {
  return id as GraphId;
}

function asNodeId(id: string): NodeId {
  return id as NodeId;
}

function asPortId(id: string): PortId {
  return id as PortId;
}

function node(id: NodeId): ChartNode {
  return {
    id,
    data: {},
    title: id,
    type: 'text',
    visualData: {
      x: 0,
      y: 0,
    },
  };
}

function commentNode(id: NodeId): ChartNode {
  return {
    ...node(id),
    type: 'comment',
  };
}

test('getCanvasNodeCompareKindsById ignores existing nodes touched only by new connections', () => {
  const sourceNodeId = asNodeId('source-node');
  const targetNodeId = asNodeId('target-node');

  const graphComparison = {
    id: asGraphId('graph'),
    kind: 'changed',
    metadataChanged: false,
    nodes: {
      [sourceNodeId]: {
        id: sourceNodeId,
        kind: 'unchanged',
      },
      [targetNodeId]: {
        id: targetNodeId,
        kind: 'unchanged',
      },
    },
    connections: {
      '["source-node","output","target-node","input"]': {
        key: '["source-node","output","target-node","input"]',
        kind: 'added',
        after: {
          inputId: asPortId('input'),
          inputNodeId: targetNodeId,
          outputId: asPortId('output'),
          outputNodeId: sourceNodeId,
        },
      },
    },
    summary: {
      addedConnections: 1,
      addedNodes: 0,
      changedConnections: 0,
      changedNodes: 0,
      removedConnections: 0,
      removedNodes: 0,
    },
  } satisfies ProjectGraphComparison;

  assert.deepEqual(getCanvasNodeCompareKindsById(graphComparison), {});
});

test('getCanvasNodeCompareKindsById keeps actual node additions and changes', () => {
  const addedNodeId = asNodeId('added-node');
  const changedNodeId = asNodeId('changed-node');
  const addedCommentId = asNodeId('added-comment');
  const changedCommentId = asNodeId('changed-comment');

  const graphComparison = {
    id: asGraphId('graph'),
    kind: 'changed',
    metadataChanged: false,
    nodes: {
      [addedNodeId]: {
        id: addedNodeId,
        kind: 'added',
        after: node(addedNodeId),
      },
      [changedNodeId]: {
        id: changedNodeId,
        kind: 'changed',
        after: node(changedNodeId),
      },
      [addedCommentId]: {
        id: addedCommentId,
        kind: 'added',
        after: commentNode(addedCommentId),
      },
      [changedCommentId]: {
        id: changedCommentId,
        kind: 'changed',
        after: commentNode(changedCommentId),
      },
    },
    connections: {},
    summary: {
      addedConnections: 0,
      addedNodes: 2,
      changedConnections: 0,
      changedNodes: 2,
      removedConnections: 0,
      removedNodes: 0,
    },
  } satisfies ProjectGraphComparison;

  assert.deepEqual(getCanvasNodeCompareKindsById(graphComparison), {
    [addedNodeId]: 'added',
    [changedNodeId]: 'changed',
  });
});

test('getCanvasNodeCompareKindsById highlights added nodes even when added wires also touch them', () => {
  const addedConnectedNodeId = asNodeId('added-connected-node');
  const addedStandaloneNodeId = asNodeId('added-standalone-node');
  const existingNodeId = asNodeId('existing-node');

  const graphComparison = {
    id: asGraphId('graph'),
    kind: 'changed',
    metadataChanged: false,
    nodes: {
      [addedConnectedNodeId]: {
        id: addedConnectedNodeId,
        kind: 'added',
        after: node(addedConnectedNodeId),
      },
      [addedStandaloneNodeId]: {
        id: addedStandaloneNodeId,
        kind: 'added',
        after: node(addedStandaloneNodeId),
      },
      [existingNodeId]: {
        id: existingNodeId,
        kind: 'unchanged',
        after: node(existingNodeId),
      },
    },
    connections: {
      '["existing-node","output","added-connected-node","input"]': {
        key: '["existing-node","output","added-connected-node","input"]',
        kind: 'added',
        after: {
          inputId: asPortId('input'),
          inputNodeId: addedConnectedNodeId,
          outputId: asPortId('output'),
          outputNodeId: existingNodeId,
        },
      },
    },
    summary: {
      addedConnections: 1,
      addedNodes: 2,
      changedConnections: 0,
      changedNodes: 0,
      removedConnections: 0,
      removedNodes: 0,
    },
  } satisfies ProjectGraphComparison;

  assert.deepEqual(getCanvasNodeCompareKindsById(graphComparison), {
    [addedConnectedNodeId]: 'added',
    [addedStandaloneNodeId]: 'added',
  });
});

test('getCanvasProjectComparisonRenderState returns the shared empty state without a comparison', () => {
  assert.equal(getCanvasProjectComparisonRenderState(undefined), EMPTY_CANVAS_PROJECT_COMPARISON_RENDER_STATE);
});

test('getCanvasProjectComparisonRenderState derives node and connection overlay data', () => {
  const addedNodeId = asNodeId('added-node');
  const removedNodeId = asNodeId('removed-node');
  const changedConnectionKey = '["old-source","output","old-target","input"]';
  const addedConnectionKey = '["source","output","added-node","input"]';
  const removedConnectionKey = '["removed-source","output","removed-target","input"]';

  const graphComparison = {
    id: asGraphId('graph'),
    kind: 'changed',
    metadataChanged: false,
    nodes: {
      [addedNodeId]: {
        id: addedNodeId,
        kind: 'added',
        after: node(addedNodeId),
      },
      [removedNodeId]: {
        id: removedNodeId,
        kind: 'removed',
        before: node(removedNodeId),
      },
    },
    connections: {
      [addedConnectionKey]: {
        key: addedConnectionKey,
        kind: 'added',
        after: {
          inputId: asPortId('input'),
          inputNodeId: addedNodeId,
          outputId: asPortId('output'),
          outputNodeId: asNodeId('source'),
        },
      },
      [changedConnectionKey]: {
        key: changedConnectionKey,
        kind: 'changed',
        before: {
          inputId: asPortId('input'),
          inputNodeId: asNodeId('old-target'),
          outputId: asPortId('output'),
          outputNodeId: asNodeId('old-source'),
        },
        after: {
          inputId: asPortId('input'),
          inputNodeId: addedNodeId,
          outputId: asPortId('output'),
          outputNodeId: asNodeId('source'),
        },
      },
      [removedConnectionKey]: {
        key: removedConnectionKey,
        kind: 'removed',
        before: {
          inputId: asPortId('input'),
          inputNodeId: asNodeId('removed-target'),
          outputId: asPortId('output'),
          outputNodeId: asNodeId('removed-source'),
        },
      },
    },
    summary: {
      addedConnections: 1,
      addedNodes: 1,
      changedConnections: 1,
      changedNodes: 0,
      removedConnections: 1,
      removedNodes: 1,
    },
  } satisfies ProjectGraphComparison;

  const renderState = getCanvasProjectComparisonRenderState(graphComparison);

  assert.deepEqual(renderState.nodeCompareKindsById, { [addedNodeId]: 'added' });
  assert.deepEqual(renderState.compareRemovedNodes.map((node) => node.id), [removedNodeId]);
  assert.deepEqual(Object.keys(renderState.compareNodesById), [removedNodeId]);
  assert.deepEqual(renderState.connectionCompareKindsByKey, {
    [addedConnectionKey]: 'added',
    [changedConnectionKey]: 'changed',
  });
  assert.deepEqual(
    renderState.compareRemovedConnections.map(
      (connection) => `${connection.outputNodeId}:${connection.inputNodeId}`,
    ),
    ['old-source:old-target', 'removed-source:removed-target'],
  );
});

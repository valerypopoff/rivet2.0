import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, GraphId, NodeId, ProjectComparison, ProjectGraphComparison, ProjectId } from '@valerypopoff/rivet2-core';
import {
  formatProjectComparisonCounts,
  formatProjectComparisonCurrentGraphCounts,
  getGraphProjectComparisonCounts,
  getOverallProjectComparisonCounts,
  getProjectComparisonReferenceFileName,
} from './projectComparisonSummary.js';

function asGraphId(id: string): GraphId {
  return id as GraphId;
}

function asNodeId(id: string): NodeId {
  return id as NodeId;
}

function asProjectId(id: string): ProjectId {
  return id as ProjectId;
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

test('project comparison summary helpers format overall and current graph counts', () => {
  assert.equal(getProjectComparisonReferenceFileName('C:\\Projects\\before.rivet-project', 'Fallback'), 'before.rivet-project');
  assert.equal(getProjectComparisonReferenceFileName(undefined, 'Fallback'), 'Fallback');

  const changedNodeId = asNodeId('changed-node');
  const addedNodeId = asNodeId('added-node');
  const removedNodeId = asNodeId('removed-node');
  const connectionOnlyNodeId = asNodeId('connection-only-node');
  const addedCommentId = asNodeId('added-comment');
  const changedCommentId = asNodeId('changed-comment');
  const graphComparison = {
    id: asGraphId('graph'),
    kind: 'changed',
    metadataChanged: false,
    nodes: {
      [changedNodeId]: {
        id: changedNodeId,
        kind: 'changed',
        after: node(changedNodeId),
        before: node(changedNodeId),
      },
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
      [connectionOnlyNodeId]: {
        id: connectionOnlyNodeId,
        kind: 'unchanged',
        after: node(connectionOnlyNodeId),
        before: node(connectionOnlyNodeId),
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
        before: commentNode(changedCommentId),
      },
    },
    connections: {},
    summary: {
      addedConnections: 1,
      addedNodes: 2,
      changedConnections: 1,
      changedNodes: 2,
      removedConnections: 0,
      removedNodes: 1,
    },
  } satisfies ProjectGraphComparison;

  const comparison = {
    afterProjectId: asProjectId('after-project'),
    beforeProjectId: asProjectId('before-project'),
    graphs: {
      [graphComparison.id]: graphComparison,
    },
    metadataChanged: false,
    summary: {
      addedConnections: 1,
      addedGraphs: 0,
      addedNodePrefabs: 1,
      addedNodes: 2,
      changedConnections: 1,
      changedGraphs: 1,
      changedNodePrefabs: 1,
      changedNodes: 2,
      removedConnections: 0,
      removedGraphs: 0,
      removedNodePrefabs: 1,
      removedNodes: 1,
    },
  } satisfies ProjectComparison;

  assert.equal(
    formatProjectComparisonCounts(getOverallProjectComparisonCounts(comparison)),
    '1 graph, 2 nodes, 3 library nodes, 2 connection changes',
  );

  assert.equal(
    formatProjectComparisonCurrentGraphCounts(getGraphProjectComparisonCounts(graphComparison)),
    '2 nodes, 2 connection changes',
  );

  assert.equal(
    formatProjectComparisonCounts({
      connectionChanges: 0,
      graphs: 2,
      nodes: 0,
    }),
    '2 graphs',
  );

  assert.equal(
    formatProjectComparisonCurrentGraphCounts({
      connectionChanges: 0,
      graphs: 1,
      nodes: 3,
    }),
    '3 nodes',
  );

  assert.equal(
    formatProjectComparisonCounts({
      connectionChanges: 0,
      graphs: 0,
      nodes: 0,
    }),
    'No changes',
  );

  assert.equal(
    formatProjectComparisonCurrentGraphCounts({
      connectionChanges: 0,
      graphs: 1,
      nodes: 0,
    }),
    'No changes',
  );
});

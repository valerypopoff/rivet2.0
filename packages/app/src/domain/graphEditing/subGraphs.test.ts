import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, GraphId, NodeId } from '@valerypopoff/rivet2-core';
import { getRecursiveSubGraphWarning } from './subGraphs.js';

function subGraphNode(graphId: unknown, disabled = false): ChartNode {
  return {
    type: 'subGraph',
    id: 'subgraph-node' as NodeId,
    title: 'Subgraph',
    visualData: {
      x: 0,
      y: 0,
      width: 300,
    },
    data: {
      graphId,
    },
    disabled,
  } as ChartNode;
}

test('getRecursiveSubGraphWarning warns when an enabled Subgraph points to its containing graph', () => {
  assert.equal(
    getRecursiveSubGraphWarning(subGraphNode('graph-a'), 'graph-a' as GraphId),
    'This Subgraph points to the graph it is inside, creating direct recursion.',
  );
});

test('getRecursiveSubGraphWarning ignores Subgraphs that point at another graph', () => {
  assert.equal(getRecursiveSubGraphWarning(subGraphNode('graph-b'), 'graph-a' as GraphId), undefined);
});

test('getRecursiveSubGraphWarning ignores disabled, blank, and non-Subgraph nodes', () => {
  assert.equal(getRecursiveSubGraphWarning(subGraphNode('graph-a', true), 'graph-a' as GraphId), undefined);
  assert.equal(getRecursiveSubGraphWarning(subGraphNode(''), 'graph-a' as GraphId), undefined);
  assert.equal(getRecursiveSubGraphWarning(subGraphNode(undefined), 'graph-a' as GraphId), undefined);
  assert.equal(
    getRecursiveSubGraphWarning(
      {
        ...subGraphNode('graph-a'),
        type: 'text',
      } as ChartNode,
      'graph-a' as GraphId,
    ),
    undefined,
  );
});

test('getRecursiveSubGraphWarning ignores missing containing graph metadata', () => {
  assert.equal(getRecursiveSubGraphWarning(subGraphNode('graph-a'), undefined), undefined);
});

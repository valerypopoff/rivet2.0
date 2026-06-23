import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type GraphId, type NodeGraph } from '@valerypopoff/rivet2-core';
import { prepareCurrentGraphForSave, shouldPersistCurrentGraph } from './currentGraphSave.js';

function makeGraph(id: string, name: string, options: { nodeCount?: number; connectionCount?: number } = {}): NodeGraph {
  const { nodeCount = 0, connectionCount = 0 } = options;

  return {
    metadata: {
      id: id as GraphId,
      name,
      description: '',
    },
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      id: `${id}-node-${index + 1}`,
      type: 'text',
      title: `Node ${index + 1}`,
      data: {},
      visualData: { x: 0, y: 0 },
    })) as NodeGraph['nodes'],
    connections: Array.from({ length: connectionCount }, (_, index) => ({
      inputNodeId: `${id}-node-${index + 1}`,
      inputId: 'input',
      outputNodeId: `${id}-node-${index + 2}`,
      outputId: 'output',
    })) as NodeGraph['connections'],
  };
}

describe('currentGraphSave', () => {
  test('skips an empty placeholder graph that is not part of the project', () => {
    const placeholderGraph = makeGraph('placeholder', 'Untitled graph');

    assert.equal(shouldPersistCurrentGraph(placeholderGraph, []), false);
    assert.equal(prepareCurrentGraphForSave(placeholderGraph, []), undefined);
  });

  test('persists an existing graph even when it becomes empty', () => {
    const existingEmptyGraph = makeGraph('graph-1', 'Main Graph');
    const savedGraphs = [makeGraph('graph-1', 'Main Graph', { nodeCount: 2 })];

    assert.equal(shouldPersistCurrentGraph(existingEmptyGraph, savedGraphs), true);

    const prepared = prepareCurrentGraphForSave(existingEmptyGraph, savedGraphs);

    assert.ok(prepared);
    assert.equal(prepared.currentGraph.metadata?.id, 'graph-1');
    assert.equal(prepared.currentGraph.nodes.length, 0);
    assert.equal(prepared.savedGraphs.length, 1);
    assert.equal(prepared.savedGraphs[0]?.metadata?.id, 'graph-1');
    assert.equal(prepared.savedGraphs[0]?.nodes.length, 0);
  });

  test('replaces the existing saved graph with the current non-empty graph contents', () => {
    const originalGraph = makeGraph('graph-1', 'Main Graph', { nodeCount: 1 });
    const editedGraph = makeGraph('graph-1', 'Main Graph', { nodeCount: 2, connectionCount: 1 });

    const prepared = prepareCurrentGraphForSave(editedGraph, [originalGraph]);

    assert.ok(prepared);
    assert.equal(prepared.savedGraphs.length, 1);
    assert.equal(prepared.savedGraphs[0]?.nodes.length, 2);
    assert.equal(prepared.savedGraphs[0]?.connections.length, 1);
  });

  test('persists a non-empty graph even when it is not already in the saved graph list', () => {
    const unsavedGraph = makeGraph('graph-2', 'Draft Graph', { nodeCount: 1 });

    const prepared = prepareCurrentGraphForSave(unsavedGraph, []);

    assert.ok(prepared);
    assert.equal(prepared.savedGraphs.length, 1);
    assert.equal(prepared.savedGraphs[0]?.metadata?.id, 'graph-2');
  });
});

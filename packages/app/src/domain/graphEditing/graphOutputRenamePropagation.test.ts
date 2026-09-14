import assert from 'node:assert/strict';
import test from 'node:test';
import { type GraphId, type NodeConnection, type NodeId, type PortId } from '@valerypopoff/rivet2-core';
import {
  makeCallGraphNode,
  makeConnection as makeBaseConnection,
  makeGraph,
  makeGraphOutputNode as makeGraphOutput,
  makeGraphReferenceNode,
  makeProject,
  makeSubGraphNode,
  makeTextNode,
} from './testGraphBuilders.js';
import { propagateGraphPortRename } from './graphPortRenamePropagation.js';

const subGraphId = 'sub-graph' as GraphId;
const parentGraphId = 'parent-graph' as GraphId;

const propagateGraphOutputRename = (args: Omit<Parameters<typeof propagateGraphPortRename>[0], 'kind'>) =>
  propagateGraphPortRename({ kind: 'output', ...args });

function makeConnection(overrides: Partial<NodeConnection> = {}): NodeConnection {
  return makeBaseConnection({
    outputNodeId: 'subgraph' as NodeId,
    outputId: 'old' as PortId,
    inputNodeId: 'target' as NodeId,
    inputId: 'input' as PortId,
    ...overrides,
  });
}

test('propagateGraphOutputRename renames direct subgraph output connections', () => {
  const previousOutputNode = makeGraphOutput('output-node', 'old');
  const nextOutputNode = makeGraphOutput('output-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph');
  const targetNode = makeTextNode('target');
  const parentConnection = makeConnection();
  const parentGraph = makeGraph(parentGraphId, [subGraphNode, targetNode], [parentConnection]);

  const result = propagateGraphOutputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousOutputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextOutputNode],
    previousCurrentNodes: [previousOutputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots[parentGraphId]!.nextGraph.connections, [
    {
      ...parentConnection,
      outputId: 'new' as PortId,
    },
  ]);
  assert.deepEqual(result.projectGraphSnapshots[parentGraphId]!.previousGraph.connections, [parentConnection]);
});

test('propagateGraphOutputRename renames persisted subgraph output port order', () => {
  const previousOutputNode = makeGraphOutput('output-node', 'old');
  const nextOutputNode = makeGraphOutput('output-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId, {
    data: {
      outputPortOrder: ['b', 'old', 'a'],
    },
  });
  const parentGraph = makeGraph(parentGraphId, [subGraphNode]);

  const result = propagateGraphOutputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousOutputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextOutputNode],
    previousCurrentNodes: [previousOutputNode],
    project: makeProject([parentGraph]),
  });
  const nextSubGraphNode = result.projectGraphSnapshots[parentGraphId]!.nextGraph.nodes[0]!;

  assert.deepEqual((nextSubGraphNode.data as { outputPortOrder?: string[] }).outputPortOrder, ['b', 'new', 'a']);
});

test('propagateGraphOutputRename leaves unrelated subgraph output port order unchanged', () => {
  const previousOutputNode = makeGraphOutput('output-node', 'old');
  const nextOutputNode = makeGraphOutput('output-node', 'new');
  const unrelatedSubGraphNode = makeSubGraphNode('subgraph', 'other-graph', {
    data: {
      outputPortOrder: ['old', 'tail'],
    },
  });
  const parentGraph = makeGraph(parentGraphId, [unrelatedSubGraphNode]);

  const result = propagateGraphOutputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousOutputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextOutputNode],
    previousCurrentNodes: [previousOutputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots, {});
});

test('propagateGraphOutputRename preserves fan-out connections from the renamed output', () => {
  const previousOutputNode = makeGraphOutput('output-node', 'old');
  const nextOutputNode = makeGraphOutput('output-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph');
  const firstConnection = makeConnection({ inputNodeId: 'first-target' as NodeId, inputId: 'value' as PortId });
  const secondConnection = makeConnection({ inputNodeId: 'second-target' as NodeId, inputId: 'value' as PortId });
  const parentGraph = makeGraph(
    parentGraphId,
    [subGraphNode, makeTextNode('first-target'), makeTextNode('second-target')],
    [firstConnection, secondConnection],
  );

  const result = propagateGraphOutputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousOutputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextOutputNode],
    previousCurrentNodes: [previousOutputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots[parentGraphId]!.nextGraph.connections, [
    {
      ...firstConnection,
      outputId: 'new' as PortId,
    },
    {
      ...secondConnection,
      outputId: 'new' as PortId,
    },
  ]);
});

test('propagateGraphOutputRename drops exact duplicate connections created by the rewrite', () => {
  const previousOutputNode = makeGraphOutput('output-node', 'old');
  const nextOutputNode = makeGraphOutput('output-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph');
  const oldConnection = makeConnection();
  const newConnection = makeConnection({ outputId: 'new' as PortId });
  const parentGraph = makeGraph(parentGraphId, [subGraphNode, makeTextNode('target')], [oldConnection, newConnection]);

  const result = propagateGraphOutputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousOutputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextOutputNode],
    previousCurrentNodes: [previousOutputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots[parentGraphId]!.nextGraph.connections, [
    {
      ...oldConnection,
      outputId: 'new' as PortId,
    },
  ]);
});

test('propagateGraphOutputRename keeps the first connection when it precedes a rewrite collision', () => {
  const previousOutputNode = makeGraphOutput('output-node', 'old');
  const nextOutputNode = makeGraphOutput('output-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph');
  const newConnection = makeConnection({ outputId: 'new' as PortId, bendPoint: { x: 42, y: 17 } });
  const oldConnection = makeConnection({ bendPoint: { x: 10, y: 20 } });
  const parentGraph = makeGraph(parentGraphId, [subGraphNode, makeTextNode('target')], [newConnection, oldConnection]);

  const result = propagateGraphOutputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousOutputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextOutputNode],
    previousCurrentNodes: [previousOutputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots[parentGraphId]!.nextGraph.connections, [newConnection]);
});

test('propagateGraphOutputRename does not treat a missing graph output id as an empty-string rename', () => {
  const previousOutputNode = makeGraphOutput('output-node', 'old');
  delete (previousOutputNode.data as Record<string, unknown>).id;
  const nextOutputNode = makeGraphOutput('output-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph');
  const parentGraph = makeGraph(
    parentGraphId,
    [subGraphNode],
    [
      makeConnection({
        outputId: '' as PortId,
      }),
    ],
  );

  const result = propagateGraphOutputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousOutputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextOutputNode],
    previousCurrentNodes: [previousOutputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots, {});
});

test('propagateGraphOutputRename preserves unrelated exact duplicate connections', () => {
  const previousOutputNode = makeGraphOutput('output-node', 'old');
  const nextOutputNode = makeGraphOutput('output-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph');
  const oldConnection = makeConnection();
  const unrelatedDuplicateConnection = makeConnection({
    outputNodeId: 'other-source' as NodeId,
    outputId: 'output' as PortId,
    inputNodeId: 'other-target' as NodeId,
  });
  const parentGraph = makeGraph(
    parentGraphId,
    [subGraphNode, makeTextNode('target')],
    [unrelatedDuplicateConnection, oldConnection, unrelatedDuplicateConnection],
  );

  const result = propagateGraphOutputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousOutputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextOutputNode],
    previousCurrentNodes: [previousOutputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots[parentGraphId]!.nextGraph.connections, [
    unrelatedDuplicateConnection,
    {
      ...oldConnection,
      outputId: 'new' as PortId,
    },
    unrelatedDuplicateConnection,
  ]);
});

test('propagateGraphOutputRename does not rewrite while another old graph output remains', () => {
  const previousOutputNode = makeGraphOutput('output-node', 'old');
  const nextOutputNode = makeGraphOutput('output-node', 'new');
  const remainingOldOutputNode = makeGraphOutput('remaining-output-node', 'old');
  const subGraphNode = makeSubGraphNode('subgraph');
  const parentGraph = makeGraph(parentGraphId, [subGraphNode], [makeConnection()]);

  const result = propagateGraphOutputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousOutputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextOutputNode, remainingOldOutputNode],
    previousCurrentNodes: [previousOutputNode, remainingOldOutputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots, {});
});

test('propagateGraphOutputRename updates recursive current-graph subgraph callers', () => {
  const previousOutputNode = makeGraphOutput('output-node', 'old');
  const nextOutputNode = makeGraphOutput('output-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const targetNode = makeTextNode('target');
  const connection = makeConnection({
    outputNodeId: subGraphNode.id,
    inputNodeId: targetNode.id,
  });

  const result = propagateGraphOutputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousOutputNode.id,
    nextCurrentConnections: [connection],
    nextCurrentNodes: [nextOutputNode, subGraphNode, targetNode],
    previousCurrentNodes: [previousOutputNode, subGraphNode, targetNode],
    project: makeProject([]),
  });

  assert.deepEqual(result.nextCurrentConnections, [
    {
      ...connection,
      outputId: 'new' as PortId,
    },
  ]);
  assert.deepEqual(result.projectGraphSnapshots, {});
});

test('propagateGraphOutputRename leaves graph reference and call graph paths unchanged', () => {
  const previousOutputNode = makeGraphOutput('output-node', 'old');
  const nextOutputNode = makeGraphOutput('output-node', 'new');
  const graphReferenceNode = makeGraphReferenceNode('graph-reference');
  const callGraphNode = makeCallGraphNode('call-graph');
  const graphConnection = makeConnection({
    outputNodeId: graphReferenceNode.id,
    outputId: 'graph' as PortId,
    inputNodeId: callGraphNode.id,
    inputId: 'graph' as PortId,
  });
  const parentGraph = makeGraph(parentGraphId, [graphReferenceNode, callGraphNode], [graphConnection]);

  const result = propagateGraphOutputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousOutputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextOutputNode],
    previousCurrentNodes: [previousOutputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots, {});
});

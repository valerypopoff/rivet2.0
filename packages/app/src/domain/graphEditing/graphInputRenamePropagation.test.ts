import assert from 'node:assert/strict';
import test from 'node:test';
import { type GraphId, type NodeConnection, type NodeId, type PortId } from '@valerypopoff/rivet2-core';
import {
  makeCallGraphNode,
  makeConnection as makeBaseConnection,
  makeGraph,
  makeGraphInputNode as makeGraphInput,
  makeGraphReferenceNode,
  makeProject,
  makeSubGraphNode,
  makeTextNode,
} from './testGraphBuilders.js';
import { propagateGraphPortRename } from './graphPortRenamePropagation.js';

const subGraphId = 'sub-graph' as GraphId;
const parentGraphId = 'parent-graph' as GraphId;

const propagateGraphInputRename = (args: Omit<Parameters<typeof propagateGraphPortRename>[0], 'kind'>) =>
  propagateGraphPortRename({ kind: 'input', ...args });

function makeConnection(overrides: Partial<NodeConnection> = {}): NodeConnection {
  return makeBaseConnection({
    inputNodeId: 'subgraph' as NodeId,
    inputId: 'old' as PortId,
    ...overrides,
  });
}

test('propagateGraphInputRename renames direct subgraph input connections', () => {
  const previousInputNode = makeGraphInput('input-node', 'old');
  const nextInputNode = makeGraphInput('input-node', 'new');
  const sourceNode = makeTextNode('source');
  const subGraphNode = makeSubGraphNode('subgraph');
  const parentConnection = makeConnection();
  const parentGraph = makeGraph(parentGraphId, [sourceNode, subGraphNode], [parentConnection]);

  const result = propagateGraphInputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousInputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInputNode],
    previousCurrentNodes: [previousInputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots[parentGraphId]!.nextGraph.connections, [
    {
      ...parentConnection,
      inputId: 'new' as PortId,
    },
  ]);
  assert.deepEqual(result.projectGraphSnapshots[parentGraphId]!.previousGraph.connections, [parentConnection]);
});

test('propagateGraphInputRename renames subgraph inputData defaults', () => {
  const previousInputNode = makeGraphInput('input-node', 'old');
  const nextInputNode = makeGraphInput('input-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph');
  subGraphNode.data = {
    ...(subGraphNode.data as Record<string, unknown>),
    inputData: {
      old: { type: 'string', value: 'kept' },
    },
  };
  const parentGraph = makeGraph(parentGraphId, [subGraphNode]);

  const result = propagateGraphInputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousInputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInputNode],
    previousCurrentNodes: [previousInputNode],
    project: makeProject([parentGraph]),
  });
  const nextSubGraphNode = result.projectGraphSnapshots[parentGraphId]!.nextGraph.nodes[0]!;

  assert.deepEqual((nextSubGraphNode.data as { inputData?: Record<string, unknown> }).inputData, {
    new: { type: 'string', value: 'kept' },
  });
});

test('propagateGraphInputRename renames persisted subgraph input port order', () => {
  const previousInputNode = makeGraphInput('input-node', 'old');
  const nextInputNode = makeGraphInput('input-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId, {
    data: {
      inputPortOrder: ['b', 'old', 'a'],
    },
  });
  const parentGraph = makeGraph(parentGraphId, [subGraphNode]);

  const result = propagateGraphInputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousInputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInputNode],
    previousCurrentNodes: [previousInputNode],
    project: makeProject([parentGraph]),
  });
  const nextSubGraphNode = result.projectGraphSnapshots[parentGraphId]!.nextGraph.nodes[0]!;

  assert.deepEqual((nextSubGraphNode.data as { inputPortOrder?: string[] }).inputPortOrder, ['b', 'new', 'a']);
});

test('propagateGraphInputRename deduplicates persisted subgraph input order collisions', () => {
  const previousInputNode = makeGraphInput('input-node', 'old');
  const nextInputNode = makeGraphInput('input-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId, {
    data: {
      inputPortOrder: ['new', 'old', 'tail'],
    },
  });
  const parentGraph = makeGraph(parentGraphId, [subGraphNode]);

  const result = propagateGraphInputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousInputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInputNode],
    previousCurrentNodes: [previousInputNode],
    project: makeProject([parentGraph]),
  });
  const nextSubGraphNode = result.projectGraphSnapshots[parentGraphId]!.nextGraph.nodes[0]!;

  assert.deepEqual((nextSubGraphNode.data as { inputPortOrder?: string[] }).inputPortOrder, ['new', 'tail']);
});

test('propagateGraphInputRename keeps existing new-name inputData default on collision', () => {
  const previousInputNode = makeGraphInput('input-node', 'old');
  const nextInputNode = makeGraphInput('input-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph');
  subGraphNode.data = {
    ...(subGraphNode.data as Record<string, unknown>),
    inputData: {
      old: { type: 'string', value: 'discarded' },
      new: { type: 'string', value: 'kept' },
    },
  };
  const parentGraph = makeGraph(parentGraphId, [subGraphNode]);

  const result = propagateGraphInputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousInputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInputNode],
    previousCurrentNodes: [previousInputNode],
    project: makeProject([parentGraph]),
  });
  const nextSubGraphNode = result.projectGraphSnapshots[parentGraphId]!.nextGraph.nodes[0]!;

  assert.deepEqual((nextSubGraphNode.data as { inputData?: Record<string, unknown> }).inputData, {
    new: { type: 'string', value: 'kept' },
  });
});

test('propagateGraphInputRename does not rewrite while another old graph input remains', () => {
  const previousInputNode = makeGraphInput('input-node', 'old');
  const nextInputNode = makeGraphInput('input-node', 'new');
  const remainingOldInputNode = makeGraphInput('remaining-input-node', 'old');
  const subGraphNode = makeSubGraphNode('subgraph');
  const parentGraph = makeGraph(parentGraphId, [subGraphNode], [makeConnection()]);

  const result = propagateGraphInputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousInputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInputNode, remainingOldInputNode],
    previousCurrentNodes: [previousInputNode, remainingOldInputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots, {});
});

test('propagateGraphInputRename does not treat a missing graph input id as an empty-string rename', () => {
  const previousInputNode = makeGraphInput('input-node', 'old');
  delete (previousInputNode.data as Record<string, unknown>).id;
  const nextInputNode = makeGraphInput('input-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph');
  const parentGraph = makeGraph(
    parentGraphId,
    [subGraphNode],
    [
      makeConnection({
        inputId: '' as PortId,
      }),
    ],
  );

  const result = propagateGraphInputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousInputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInputNode],
    previousCurrentNodes: [previousInputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots, {});
});

test('propagateGraphInputRename keeps existing new-name connection on collision', () => {
  const previousInputNode = makeGraphInput('input-node', 'old');
  const nextInputNode = makeGraphInput('input-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph');
  const oldConnection = makeConnection({
    outputNodeId: 'old-source' as NodeId,
    inputId: 'old' as PortId,
  });
  const newConnection = makeConnection({
    outputNodeId: 'new-source' as NodeId,
    inputId: 'new' as PortId,
  });
  const parentGraph = makeGraph(parentGraphId, [subGraphNode], [oldConnection, newConnection]);

  const result = propagateGraphInputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousInputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInputNode],
    previousCurrentNodes: [previousInputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots[parentGraphId]!.nextGraph.connections, [newConnection]);
});

test('propagateGraphInputRename moves only one malformed duplicate old-name connection', () => {
  const previousInputNode = makeGraphInput('input-node', 'old');
  const nextInputNode = makeGraphInput('input-node', 'new');
  const subGraphNode = makeSubGraphNode('subgraph');
  const firstOldConnection = makeConnection({ outputNodeId: 'first-source' as NodeId });
  const secondOldConnection = makeConnection({ outputNodeId: 'second-source' as NodeId });
  const parentGraph = makeGraph(parentGraphId, [subGraphNode], [firstOldConnection, secondOldConnection]);

  const result = propagateGraphInputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousInputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInputNode],
    previousCurrentNodes: [previousInputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots[parentGraphId]!.nextGraph.connections, [
    {
      ...firstOldConnection,
      inputId: 'new' as PortId,
    },
  ]);
});

test('propagateGraphInputRename updates recursive current-graph subgraph callers', () => {
  const previousInputNode = makeGraphInput('input-node', 'old');
  const nextInputNode = makeGraphInput('input-node', 'new');
  const sourceNode = makeTextNode('source');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const connection = makeConnection({
    outputNodeId: sourceNode.id,
    inputNodeId: subGraphNode.id,
  });

  const result = propagateGraphInputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousInputNode.id,
    nextCurrentConnections: [connection],
    nextCurrentNodes: [nextInputNode, sourceNode, subGraphNode],
    previousCurrentNodes: [previousInputNode, sourceNode, subGraphNode],
    project: makeProject([]),
  });

  assert.deepEqual(result.nextCurrentConnections, [
    {
      ...connection,
      inputId: 'new' as PortId,
    },
  ]);
  assert.deepEqual(result.projectGraphSnapshots, {});
});

test('propagateGraphInputRename leaves graph reference and call graph inputs unchanged', () => {
  const previousInputNode = makeGraphInput('input-node', 'old');
  const nextInputNode = makeGraphInput('input-node', 'new');
  const graphReferenceNode = makeGraphReferenceNode('graph-reference');
  const callGraphNode = makeCallGraphNode('call-graph');
  const inputsSourceNode = makeTextNode('inputs-source');
  const graphConnection = makeConnection({
    outputNodeId: graphReferenceNode.id,
    outputId: 'graph' as PortId,
    inputNodeId: callGraphNode.id,
    inputId: 'graph' as PortId,
  });
  const inputsConnection = makeConnection({
    outputNodeId: inputsSourceNode.id,
    outputId: 'output' as PortId,
    inputNodeId: callGraphNode.id,
    inputId: 'inputs' as PortId,
  });
  const parentGraph = makeGraph(
    parentGraphId,
    [graphReferenceNode, inputsSourceNode, callGraphNode],
    [graphConnection, inputsConnection],
  );

  const result = propagateGraphInputRename({
    currentGraphId: subGraphId,
    editedNodeId: previousInputNode.id,
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInputNode],
    previousCurrentNodes: [previousInputNode],
    project: makeProject([parentGraph]),
  });

  assert.deepEqual(result.projectGraphSnapshots, {});
});

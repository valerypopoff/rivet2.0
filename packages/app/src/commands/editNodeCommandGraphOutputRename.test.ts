import assert from 'node:assert/strict';
import test from 'node:test';
import { type ChartNode, type PortId } from '@valerypopoff/rivet2-core';
import {
  makeConnection,
  makeGraph,
  makeGraphOutputNode,
  makeProject,
  makeSubGraphNode,
  makeTextNode,
} from '../domain/graphEditing/testGraphBuilders.js';
import { buildEditNodeAppliedData } from './editNodeCommand.js';
import { makeCommandState, parentGraphId, registry, subGraphId } from './editNodeCommandTestUtils.js';

test('editNode applied data snapshots external subgraph caller rewrites on graph output rename', () => {
  const graphOutputNode = makeGraphOutputNode('output-node', 'old');
  const nextGraphOutputNode = {
    ...graphOutputNode,
    data: {
      ...(graphOutputNode.data as Record<string, unknown>),
      id: 'new',
    },
  } as ChartNode;
  const targetNode = makeTextNode('target', 'target');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const parentConnection = makeConnection({
    outputNodeId: subGraphNode.id,
    outputId: 'old' as PortId,
    inputNodeId: targetNode.id,
  });
  const parentGraph = makeGraph(parentGraphId, [targetNode, subGraphNode], [parentConnection]);
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphOutputNode],
    connections: [],
    project: makeProject([makeGraph(subGraphId, [graphOutputNode]), parentGraph]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphOutputNode.id,
      newNode: nextGraphOutputNode,
    },
    currentState,
    previousNode: graphOutputNode,
    previousConnections: currentState.connections,
    previousRecoverableConnections: [],
    currentRecoverableConnections: [],
    projectNodeRegistry: registry,
  });

  assert.deepEqual(appliedData.projectGraphSnapshots?.[parentGraphId]?.previousGraph.connections, [parentConnection]);
  assert.deepEqual(appliedData.projectGraphSnapshots?.[parentGraphId]?.nextGraph.connections, [
    {
      ...parentConnection,
      outputId: 'new' as PortId,
    },
  ]);
});

test('editNode merged graph output renames keep the original undo snapshot and final external rewrite', () => {
  const graphOutputNode = makeGraphOutputNode('output-node', 'temp');
  const nextGraphOutputNode = {
    ...graphOutputNode,
    data: {
      ...(graphOutputNode.data as Record<string, unknown>),
      id: 'new',
    },
  } as ChartNode;
  const targetNode = makeTextNode('target', 'target');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const oldParentConnection = makeConnection({
    outputNodeId: subGraphNode.id,
    outputId: 'old' as PortId,
    inputNodeId: targetNode.id,
  });
  const tempParentConnection = {
    ...oldParentConnection,
    outputId: 'temp' as PortId,
  };
  const previousParentGraph = makeGraph(parentGraphId, [targetNode, subGraphNode], [oldParentConnection]);
  const currentParentGraph = makeGraph(parentGraphId, [targetNode, subGraphNode], [tempParentConnection]);
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphOutputNode],
    connections: [],
    project: makeProject([makeGraph(subGraphId, [graphOutputNode]), currentParentGraph]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphOutputNode.id,
      newNode: nextGraphOutputNode,
    },
    currentState,
    previousNode: makeGraphOutputNode('output-node', 'old'),
    previousConnections: [],
    previousRecoverableConnections: [],
    currentRecoverableConnections: [],
    isMergedEdit: true,
    previousProjectGraphSnapshots: {
      [parentGraphId]: {
        previousGraph: previousParentGraph,
        nextGraph: currentParentGraph,
      },
    },
    projectNodeRegistry: registry,
  });

  assert.deepEqual(appliedData.projectGraphSnapshots?.[parentGraphId]?.previousGraph.connections, [
    oldParentConnection,
  ]);
  assert.deepEqual(appliedData.projectGraphSnapshots?.[parentGraphId]?.nextGraph.connections, [
    {
      ...oldParentConnection,
      outputId: 'new' as PortId,
    },
  ]);
});

test('editNode merged graph output renames preserve original and unrelated external output connections', () => {
  const graphOutputNode = makeGraphOutputNode('output-node', 'temp');
  const nextGraphOutputNode = {
    ...graphOutputNode,
    data: {
      ...(graphOutputNode.data as Record<string, unknown>),
      id: 'final',
    },
  } as ChartNode;
  const firstTargetNode = makeTextNode('first-target', 'first target');
  const secondTargetNode = makeTextNode('second-target', 'second target');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const oldParentConnection = makeConnection({
    outputNodeId: subGraphNode.id,
    outputId: 'old' as PortId,
    inputNodeId: firstTargetNode.id,
    inputId: 'input' as PortId,
  });
  const tempParentConnection = makeConnection({
    outputNodeId: subGraphNode.id,
    outputId: 'temp' as PortId,
    inputNodeId: secondTargetNode.id,
    inputId: 'input' as PortId,
  });
  const previousParentGraph = makeGraph(
    parentGraphId,
    [firstTargetNode, secondTargetNode, subGraphNode],
    [oldParentConnection, tempParentConnection],
  );
  const currentParentGraph = makeGraph(
    parentGraphId,
    [firstTargetNode, secondTargetNode, subGraphNode],
    [tempParentConnection],
  );
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphOutputNode],
    connections: [],
    project: makeProject([makeGraph(subGraphId, [graphOutputNode]), currentParentGraph]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphOutputNode.id,
      newNode: nextGraphOutputNode,
    },
    currentState,
    previousNode: makeGraphOutputNode('output-node', 'old'),
    previousConnections: [],
    previousRecoverableConnections: [],
    currentRecoverableConnections: [],
    isMergedEdit: true,
    previousProjectGraphSnapshots: {
      [parentGraphId]: {
        previousGraph: previousParentGraph,
        nextGraph: currentParentGraph,
      },
    },
    projectNodeRegistry: registry,
  });

  assert.deepEqual(appliedData.projectGraphSnapshots?.[parentGraphId]?.nextGraph.connections, [
    {
      ...oldParentConnection,
      outputId: 'final' as PortId,
    },
    tempParentConnection,
  ]);
});

test('editNode merged graph output renames restore external callers when the final id returns to the original id', () => {
  const graphOutputNode = makeGraphOutputNode('output-node', 'temp');
  const nextGraphOutputNode = {
    ...graphOutputNode,
    data: {
      ...(graphOutputNode.data as Record<string, unknown>),
      id: 'old',
    },
  } as ChartNode;
  const targetNode = makeTextNode('target', 'target');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const oldParentConnection = makeConnection({
    outputNodeId: subGraphNode.id,
    outputId: 'old' as PortId,
    inputNodeId: targetNode.id,
  });
  const tempParentConnection = {
    ...oldParentConnection,
    outputId: 'temp' as PortId,
  };
  const previousParentGraph = makeGraph(parentGraphId, [targetNode, subGraphNode], [oldParentConnection]);
  const currentParentGraph = makeGraph(parentGraphId, [targetNode, subGraphNode], [tempParentConnection]);
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphOutputNode],
    connections: [],
    project: makeProject([makeGraph(subGraphId, [graphOutputNode]), currentParentGraph]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphOutputNode.id,
      newNode: nextGraphOutputNode,
    },
    currentState,
    previousNode: makeGraphOutputNode('output-node', 'old'),
    previousConnections: [],
    previousRecoverableConnections: [],
    currentRecoverableConnections: [],
    isMergedEdit: true,
    previousProjectGraphSnapshots: {
      [parentGraphId]: {
        previousGraph: previousParentGraph,
        nextGraph: currentParentGraph,
      },
    },
    projectNodeRegistry: registry,
  });

  assert.deepEqual(appliedData.projectGraphSnapshots?.[parentGraphId]?.nextGraph.connections, [oldParentConnection]);
});

test('editNode graph output renames update recursive current-graph subgraph caller connections', () => {
  const graphOutputNode = makeGraphOutputNode('output-node', 'old');
  const nextGraphOutputNode = {
    ...graphOutputNode,
    data: {
      ...(graphOutputNode.data as Record<string, unknown>),
      id: 'new',
    },
  } as ChartNode;
  const targetNode = makeTextNode('target', 'target');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const connection = makeConnection({
    outputNodeId: subGraphNode.id,
    outputId: 'old' as PortId,
    inputNodeId: targetNode.id,
  });
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphOutputNode, targetNode, subGraphNode],
    connections: [connection],
    project: makeProject([makeGraph(subGraphId, [graphOutputNode, targetNode, subGraphNode], [connection])]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphOutputNode.id,
      newNode: nextGraphOutputNode,
    },
    currentState,
    previousNode: graphOutputNode,
    previousConnections: currentState.connections,
    previousRecoverableConnections: [],
    currentRecoverableConnections: [],
    projectNodeRegistry: registry,
  });

  assert.deepEqual(appliedData.projectGraphSnapshots, undefined);
  assert.deepEqual(appliedData.nextConnections, [
    {
      ...connection,
      outputId: 'new' as PortId,
    },
  ]);
});

test('editNode merged graph output renames restore a recursive caller when the final ID returns to the original value', () => {
  const graphOutputNode = makeGraphOutputNode('output-node', 'temp');
  const nextGraphOutputNode = {
    ...graphOutputNode,
    data: {
      ...(graphOutputNode.data as Record<string, unknown>),
      id: 'old',
    },
  } as ChartNode;
  const targetNode = makeTextNode('target', 'target');
  const previousRecursiveCaller = makeSubGraphNode('recursive-caller', subGraphId, {
    data: { outputPortOrder: ['old'] },
  });
  const currentRecursiveCaller = {
    ...previousRecursiveCaller,
    data: {
      ...(previousRecursiveCaller.data as Record<string, unknown>),
      outputPortOrder: ['temp'],
    },
  } as ChartNode;
  const oldConnection = makeConnection({
    outputNodeId: previousRecursiveCaller.id,
    outputId: 'old' as PortId,
    inputNodeId: targetNode.id,
  });
  const tempConnection = {
    ...oldConnection,
    outputId: 'temp' as PortId,
  };
  const previousGraphOutputNode = makeGraphOutputNode('output-node', 'old');
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphOutputNode, targetNode, currentRecursiveCaller],
    connections: [tempConnection],
    project: makeProject([
      makeGraph(subGraphId, [graphOutputNode, targetNode, currentRecursiveCaller], [tempConnection]),
    ]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphOutputNode.id,
      newNode: nextGraphOutputNode,
    },
    currentState,
    previousNode: previousGraphOutputNode,
    previousCurrentNodes: [previousGraphOutputNode, targetNode, previousRecursiveCaller],
    previousConnections: [oldConnection],
    previousRecoverableConnections: [],
    currentRecoverableConnections: [],
    isMergedEdit: true,
    projectNodeRegistry: registry,
  });
  const nextRecursiveCaller = appliedData.nextCurrentNodes!.find((node) => node.id === previousRecursiveCaller.id)!;

  assert.deepEqual((nextRecursiveCaller.data as { outputPortOrder?: string[] }).outputPortOrder, ['old']);
  assert.deepEqual(appliedData.nextConnections, [oldConnection]);
  assert.deepEqual(appliedData.currentGraphSnapshot?.nextGraph.nodes.find((node) => node.id === nextRecursiveCaller.id), nextRecursiveCaller);
  assert.deepEqual(appliedData.currentGraphSnapshot?.nextGraph.connections, [oldConnection]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { type ChartNode, type PortId } from '@valerypopoff/rivet2-core';
import {
  makeConnection,
  makeGraph,
  makeGraphInputNode,
  makeGraphOutputNode,
  makeProject,
  makeSubGraphNode,
  makeTextNode,
} from '../domain/graphEditing/testGraphBuilders.js';
import { buildEditNodeAppliedData } from './editNodeCommand.js';
import { makeCommandState, parentGraphId, registry, subGraphId } from './editNodeCommandTestUtils.js';

test('editNode applied data snapshots external subgraph caller rewrites on graph input rename', () => {
  const graphInputNode = makeGraphInputNode('input-node', 'old');
  const nextGraphInputNode = {
    ...graphInputNode,
    data: {
      ...(graphInputNode.data as Record<string, unknown>),
      id: 'new',
    },
  } as ChartNode;
  const sourceNode = makeTextNode('source', 'source');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const parentConnection = makeConnection({
    outputNodeId: sourceNode.id,
    inputNodeId: subGraphNode.id,
    inputId: 'old' as PortId,
  });
  const parentGraph = makeGraph(parentGraphId, [sourceNode, subGraphNode], [parentConnection]);
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphInputNode],
    connections: [],
    project: makeProject([makeGraph(subGraphId, [graphInputNode]), parentGraph]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphInputNode.id,
      newNode: nextGraphInputNode,
    },
    currentState,
    previousNode: graphInputNode,
    previousConnections: currentState.connections,
    previousRecoverableConnections: [],
    currentRecoverableConnections: [],
    projectNodeRegistry: registry,
  });

  assert.deepEqual(appliedData.projectGraphSnapshots?.[parentGraphId]?.previousGraph.connections, [parentConnection]);
  assert.deepEqual(appliedData.projectGraphSnapshots?.[parentGraphId]?.nextGraph.connections, [
    {
      ...parentConnection,
      inputId: 'new' as PortId,
    },
  ]);
});

test('editNode merged graph input renames keep the original undo snapshot and final external rewrite', () => {
  const graphInputNode = makeGraphInputNode('input-node', 'temp');
  const nextGraphInputNode = {
    ...graphInputNode,
    data: {
      ...(graphInputNode.data as Record<string, unknown>),
      id: 'new',
    },
  } as ChartNode;
  const sourceNode = makeTextNode('source', 'source');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const oldParentConnection = makeConnection({
    outputNodeId: sourceNode.id,
    inputNodeId: subGraphNode.id,
    inputId: 'old' as PortId,
  });
  const tempParentConnection = {
    ...oldParentConnection,
    inputId: 'temp' as PortId,
  };
  const previousParentGraph = makeGraph(parentGraphId, [sourceNode, subGraphNode], [oldParentConnection]);
  const currentParentGraph = makeGraph(parentGraphId, [sourceNode, subGraphNode], [tempParentConnection]);
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphInputNode],
    connections: [],
    project: makeProject([makeGraph(subGraphId, [graphInputNode]), currentParentGraph]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphInputNode.id,
      newNode: nextGraphInputNode,
    },
    currentState,
    previousNode: makeGraphInputNode('input-node', 'old'),
    previousConnections: [],
    previousRecoverableConnections: [],
    currentRecoverableConnections: [],
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
      inputId: 'new' as PortId,
    },
  ]);
});

test('editNode merged graph input renames preserve original external connections after a transient collision', () => {
  const graphInputNode = makeGraphInputNode('input-node', 'temp');
  const nextGraphInputNode = {
    ...graphInputNode,
    data: {
      ...(graphInputNode.data as Record<string, unknown>),
      id: 'final',
    },
  } as ChartNode;
  const oldSourceNode = makeTextNode('old-source', 'old source');
  const tempSourceNode = makeTextNode('temp-source', 'temp source');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const oldParentConnection = makeConnection({
    outputNodeId: oldSourceNode.id,
    inputNodeId: subGraphNode.id,
    inputId: 'old' as PortId,
  });
  const tempParentConnection = makeConnection({
    outputNodeId: tempSourceNode.id,
    inputNodeId: subGraphNode.id,
    inputId: 'temp' as PortId,
  });
  const previousParentGraph = makeGraph(
    parentGraphId,
    [oldSourceNode, tempSourceNode, subGraphNode],
    [oldParentConnection, tempParentConnection],
  );
  const currentParentGraph = makeGraph(
    parentGraphId,
    [oldSourceNode, tempSourceNode, subGraphNode],
    [tempParentConnection],
  );
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphInputNode],
    connections: [],
    project: makeProject([makeGraph(subGraphId, [graphInputNode]), currentParentGraph]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphInputNode.id,
      newNode: nextGraphInputNode,
    },
    currentState,
    previousNode: makeGraphInputNode('input-node', 'old'),
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
      inputId: 'final' as PortId,
    },
    tempParentConnection,
  ]);
});

test('editNode merged graph input renames restore external callers when the final id returns to the original id', () => {
  const graphInputNode = makeGraphInputNode('input-node', 'temp');
  const nextGraphInputNode = {
    ...graphInputNode,
    data: {
      ...(graphInputNode.data as Record<string, unknown>),
      id: 'old',
    },
  } as ChartNode;
  const oldSourceNode = makeTextNode('old-source', 'old source');
  const tempSourceNode = makeTextNode('temp-source', 'temp source');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const oldParentConnection = makeConnection({
    outputNodeId: oldSourceNode.id,
    inputNodeId: subGraphNode.id,
    inputId: 'old' as PortId,
  });
  const tempParentConnection = makeConnection({
    outputNodeId: tempSourceNode.id,
    inputNodeId: subGraphNode.id,
    inputId: 'temp' as PortId,
  });
  const previousParentGraph = makeGraph(
    parentGraphId,
    [oldSourceNode, tempSourceNode, subGraphNode],
    [oldParentConnection, tempParentConnection],
  );
  const currentParentGraph = makeGraph(
    parentGraphId,
    [oldSourceNode, tempSourceNode, subGraphNode],
    [tempParentConnection],
  );
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphInputNode],
    connections: [],
    project: makeProject([makeGraph(subGraphId, [graphInputNode]), currentParentGraph]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphInputNode.id,
      newNode: nextGraphInputNode,
    },
    currentState,
    previousNode: makeGraphInputNode('input-node', 'old'),
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
    oldParentConnection,
    tempParentConnection,
  ]);
});

test('editNode merged graph input renames preserve original current-graph connections after a transient collision', () => {
  const graphInputNode = makeGraphInputNode('input-node', 'temp');
  const nextGraphInputNode = {
    ...graphInputNode,
    data: {
      ...(graphInputNode.data as Record<string, unknown>),
      id: 'final',
    },
  } as ChartNode;
  const oldSourceNode = makeTextNode('old-source', 'old source');
  const tempSourceNode = makeTextNode('temp-source', 'temp source');
  const subGraphNode = makeSubGraphNode('subgraph', subGraphId);
  const oldConnection = makeConnection({
    outputNodeId: oldSourceNode.id,
    inputNodeId: subGraphNode.id,
    inputId: 'old' as PortId,
  });
  const tempConnection = makeConnection({
    outputNodeId: tempSourceNode.id,
    inputNodeId: subGraphNode.id,
    inputId: 'temp' as PortId,
  });
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphInputNode, oldSourceNode, tempSourceNode, subGraphNode],
    connections: [tempConnection],
    project: makeProject([makeGraph(subGraphId, [graphInputNode, oldSourceNode, tempSourceNode, subGraphNode])]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphInputNode.id,
      newNode: nextGraphInputNode,
    },
    currentState,
    previousNode: makeGraphInputNode('input-node', 'old'),
    previousConnections: [oldConnection, tempConnection],
    previousRecoverableConnections: [],
    currentRecoverableConnections: [],
    isMergedEdit: true,
    projectNodeRegistry: registry,
  });

  assert.deepEqual(appliedData.nextConnections, [
    {
      ...oldConnection,
      inputId: 'final' as PortId,
    },
    tempConnection,
  ]);
});

test('editNode merged graph input renames restore recursive caller data, order, and connections after a transient collision', () => {
  const graphInputNode = makeGraphInputNode('input-node', 'temp');
  const existingGraphInputNode = makeGraphInputNode('existing-input-node', 'temp');
  const nextGraphInputNode = {
    ...graphInputNode,
    data: {
      ...(graphInputNode.data as Record<string, unknown>),
      id: 'final',
    },
  } as ChartNode;
  const oldSourceNode = makeTextNode('old-source', 'old source');
  const tempSourceNode = makeTextNode('temp-source', 'temp source');
  const recursiveCaller = makeSubGraphNode('recursive-caller', subGraphId, {
    data: {
      inputData: {
        old: 'old default',
        temp: 'temp default',
      },
      inputPortOrder: ['old', 'temp'],
    },
  });
  const oldConnection = makeConnection({
    outputNodeId: oldSourceNode.id,
    inputNodeId: recursiveCaller.id,
    inputId: 'old' as PortId,
  });
  const tempConnection = makeConnection({
    outputNodeId: tempSourceNode.id,
    inputNodeId: recursiveCaller.id,
    inputId: 'temp' as PortId,
  });
  const currentState = makeCommandState({
    graphId: subGraphId,
    nodes: [graphInputNode, existingGraphInputNode, oldSourceNode, tempSourceNode, recursiveCaller],
    connections: [tempConnection],
    project: makeProject([
      makeGraph(
        subGraphId,
        [graphInputNode, existingGraphInputNode, oldSourceNode, tempSourceNode, recursiveCaller],
        [tempConnection],
      ),
    ]),
  });

  const appliedData = buildEditNodeAppliedData({
    params: {
      nodeId: graphInputNode.id,
      newNode: nextGraphInputNode,
    },
    currentState,
    previousNode: makeGraphInputNode('input-node', 'old'),
    previousCurrentNodes: [
      makeGraphInputNode('input-node', 'old'),
      existingGraphInputNode,
      oldSourceNode,
      tempSourceNode,
      recursiveCaller,
    ],
    previousConnections: [oldConnection, tempConnection],
    previousRecoverableConnections: [],
    currentRecoverableConnections: [],
    isMergedEdit: true,
    projectNodeRegistry: registry,
  });
  const nextRecursiveCaller = appliedData.nextCurrentNodes?.find((node) => node.id === recursiveCaller.id);

  assert.deepEqual((nextRecursiveCaller?.data as Record<string, unknown>).inputData, {
    final: 'old default',
    temp: 'temp default',
  });
  assert.deepEqual((nextRecursiveCaller?.data as Record<string, unknown>).inputPortOrder, ['final', 'temp']);
  assert.deepEqual(appliedData.nextConnections, [
    {
      ...oldConnection,
      inputId: 'final' as PortId,
    },
    tempConnection,
  ]);
  assert.deepEqual(
    appliedData.currentGraphSnapshot?.nextGraph.nodes.find((node) => node.id === recursiveCaller.id)?.data,
    nextRecursiveCaller?.data,
  );
  assert.deepEqual(appliedData.currentGraphSnapshot?.nextGraph.connections, appliedData.nextConnections);
});

test('editNode does not snapshot project graphs for ordinary same-ID boundary edits', () => {
  const boundaryEdits = [
    makeGraphInputNode('input-node', 'unchanged-input'),
    makeGraphOutputNode('output-node', 'unchanged-output'),
  ];

  for (const boundaryNode of boundaryEdits) {
    const currentState = makeCommandState({
      graphId: subGraphId,
      nodes: [boundaryNode],
      connections: [],
      project: makeProject([makeGraph(subGraphId, [boundaryNode])]),
    });
    const nextNode = {
      ...boundaryNode,
      title: `${boundaryNode.title} edited`,
    } as ChartNode;
    const appliedData = buildEditNodeAppliedData({
      params: {
        nodeId: boundaryNode.id,
        newNode: nextNode,
      },
      currentState,
      previousNode: boundaryNode,
      previousConnections: [],
      previousRecoverableConnections: [],
      currentRecoverableConnections: [],
      projectNodeRegistry: registry,
    });

    assert.equal(appliedData.currentGraphSnapshot, undefined);
    assert.equal(appliedData.projectGraphSnapshots, undefined);
  }
});

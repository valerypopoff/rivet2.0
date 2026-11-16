import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveNodePrefabInstance,
  type ChartNode,
  type NodeId,
  type NodePrefabId,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { createMakeConnectionCommand } from './makeConnectionCommand.js';
import { createRewireConnectionCommand } from './rewireConnectionCommand.js';
import { createReorderDataBusChannelsCommand } from './reorderDataBusChannelsCommand.js';
import { makeCommandState } from './editNodeCommandTestUtils.js';
import { makeGraph, makeGraphOutputNode, makeProject, makeTextNode } from '../domain/graphEditing/testGraphBuilders.js';
import { getConnectedDataBusChannelOrder, getDataBusChannelOrder } from '../domain/graphEditing/dataBusChannelOrder.js';

function bus(id = 'bus'): ChartNode {
  return { id: id as NodeId, type: 'dataBus', title: id, data: {}, visualData: { x: 0, y: 0 } };
}

function provider(channel: number, busId = 'bus', source = `source-${channel}`) {
  return {
    outputNodeId: source as NodeId,
    outputId: 'output' as PortId,
    inputNodeId: busId as NodeId,
    inputId: `input${channel}` as PortId,
  };
}

for (const rewire of [false, true]) {
  test(`${rewire ? 'rewiring' : 'connecting'} appends a reused low channel ID and restores exact order with undo/redo`, () => {
    const original = provider(1, 'sink');
    let graph = makeGraph('main', [bus(), makeTextNode('source-1')], [provider(2), provider(3), original]);
    const beforeNodes = structuredClone(graph.nodes);
    const beforeConnections = structuredClone(graph.connections);
    const read = () => makeCommandState({ nodes: graph.nodes, connections: graph.connections });
    const setGraph = (update: (current: typeof graph) => typeof graph) => {
      graph = update(graph);
    };
    const command = rewire ? createRewireConnectionCommand(setGraph) : createMakeConnectionCommand(setGraph);
    const params = { ...provider(1), originalConnection: original };
    const applied = command.apply(params, undefined, read());
    assert.deepEqual(getConnectedDataBusChannelOrder(graph.nodes[0]!, graph.connections), [2, 3, 1]);
    assert.deepEqual(graph.connections.at(-1), provider(1));
    command.undo(params, applied as any, read());
    assert.deepEqual(graph.nodes, beforeNodes);
    assert.deepEqual(
      new Set(graph.connections.map((connection) => JSON.stringify(connection))),
      new Set(beforeConnections.map((connection) => JSON.stringify(connection))),
    );
    command.apply(params, applied as any, read());
    assert.deepEqual(graph.nodes[0]!.visualData.dataBusChannelOrder, [2, 3, 1]);
  });
}

test('reordering changes only presentation, supports undo/redo, and a deleted slot appends when reused', () => {
  let graph = makeGraph('main', [bus()], [provider(1), provider(2), provider(3)]);
  const connections = graph.connections;
  const read = () => makeCommandState({ nodes: graph.nodes, connections: graph.connections });
  const setGraph = (update: (current: typeof graph) => typeof graph) => {
    graph = update(graph);
  };
  const command = createReorderDataBusChannelsCommand(setGraph);
  const move = { nodeId: 'bus' as NodeId, channelIndex: 3, targetChannelIndex: 1, side: 'before' as const };
  const applied = command.apply(move, undefined, read());
  assert.deepEqual(graph.nodes[0]!.visualData.dataBusChannelOrder, [3, 1, 2]);
  assert.equal(graph.connections, connections);
  assert.deepEqual(graph.nodes[0]!.data, {});
  command.undo(move, applied, read());
  assert.equal(Object.hasOwn(graph.nodes[0]!.visualData, 'dataBusChannelOrder'), false);
  command.apply(move, applied, read());
  assert.deepEqual(graph.nodes[0]!.visualData.dataBusChannelOrder, [3, 1, 2]);

  graph = { ...graph, connections: graph.connections.filter((connection) => connection.inputId !== 'input3') };
  const connect = createMakeConnectionCommand(setGraph);
  const add = connect.apply(provider(3), undefined, read());
  assert.deepEqual(graph.nodes[0]!.visualData.dataBusChannelOrder, [1, 2, 3]);
  connect.undo(provider(3), add, read());
  assert.deepEqual(graph.nodes[0]!.visualData.dataBusChannelOrder, [3, 1, 2]);
  // Undoing the earlier deletion can restore its original position.
  graph = { ...graph, connections };
  assert.deepEqual(getConnectedDataBusChannelOrder(graph.nodes[0]!, graph.connections), [3, 1, 2]);
});

test('provider replacement keeps channel positions and stale/duplicate order entries are harmless', () => {
  const node = bus();
  node.visualData.dataBusChannelOrder = [3, 3, 99, 2];
  let graph = makeGraph('main', [node], [provider(2), provider(3)]);
  const nodes = graph.nodes;
  const command = createMakeConnectionCommand((update) => {
    graph = update(graph);
  });
  command.apply(provider(2, 'bus', 'replacement'), undefined, makeCommandState(graph));
  assert.equal(graph.nodes, nodes);
  assert.deepEqual(getConnectedDataBusChannelOrder(node, graph.connections), [3, 2]);
  assert.deepEqual(getDataBusChannelOrder([1, 2, 3], [3, 3, 99, -1, 1]), [3, 1, 2]);
});

test('stale or unchanged reorder requests do not write the graph; moving after a target keeps wire identities', () => {
  let graph = makeGraph('main', [bus()], [provider(1), provider(2), provider(3)]);
  const original = graph;
  const command = createReorderDataBusChannelsCommand((update) => {
    graph = update(graph);
  });
  const read = () => makeCommandState(graph);
  for (const [channelIndex, targetChannelIndex, side] of [
    [1, 1, 'before'],
    [1, 1, 'after'],
    [1, 2, 'before'],
    [3, 2, 'after'],
    [99, 1, 'before'],
    [1, 99, 'after'],
  ] as const) {
    assert.deepEqual(
      command.apply({ nodeId: 'bus' as NodeId, channelIndex, targetChannelIndex, side }, undefined, read()),
      [],
    );
    assert.equal(graph, original);
  }
  command.apply({ nodeId: 'bus' as NodeId, channelIndex: 1, targetChannelIndex: 3, side: 'after' }, undefined, read());
  assert.deepEqual(graph.nodes[0]!.visualData.dataBusChannelOrder, [2, 3, 1]);
  assert.equal(graph.connections, original.connections);
});

test('bus-to-bus connections append in both rails and linked bus ordering belongs to the instance', () => {
  const instance = { ...bus('linked'), type: 'nodePrefabInstance', data: { prefabId: 'library-bus' } };
  const source = bus('library-source');
  source.visualData.dataBusChannelOrder = [1, 2];
  const project = makeProject();
  project.nodePrefabs = { ['library-bus' as NodePrefabId]: { id: 'library-bus' as NodePrefabId, sourceNode: source } };
  let graph = makeGraph('main', [bus(), instance], [provider(2), provider(2, 'linked')]);
  const command = createMakeConnectionCommand((update) => {
    graph = update(graph);
  });
  command.apply(
    { ...provider(1), outputNodeId: instance.id, outputId: 'output1' as PortId },
    undefined,
    makeCommandState({ ...graph, project }),
  );
  for (const node of graph.nodes) assert.deepEqual(node.visualData.dataBusChannelOrder, [2, 1]);
  assert.deepEqual(resolveNodePrefabInstance(project, graph.nodes[1]!).visualData.dataBusChannelOrder, [2, 1]);
  assert.deepEqual(source.visualData.dataBusChannelOrder, [1, 2]);
});

test('receiver-only channels retain positions during repair and append new outgoing channels on rewire', () => {
  const node = bus();
  node.visualData.dataBusChannelOrder = [7, 2];
  const receiver = (channel: number) => ({
    outputNodeId: node.id,
    outputId: `output${channel}` as PortId,
    inputNodeId: `sink-${channel}` as NodeId,
    inputId: 'value' as PortId,
  });
  const original = receiver(2);
  let graph = makeGraph(
    'main',
    [
      node,
      makeTextNode('source-1'),
      makeTextNode('source-7'),
      makeGraphOutputNode('sink-2', 'two'),
      makeGraphOutputNode('sink-7', 'seven'),
    ],
    [original, receiver(7)],
  );
  const setGraph = (update: (current: typeof graph) => typeof graph) => {
    graph = update(graph);
  };
  const read = () => makeCommandState(graph);
  const connect = createMakeConnectionCommand(setGraph);
  connect.apply(provider(1), undefined, read());
  assert.deepEqual(getConnectedDataBusChannelOrder(graph.nodes[0]!, graph.connections), [7, 2, 1]);
  // Restoring a provider to an existing receiver-only slot must not move it.
  connect.apply(provider(7), undefined, read());
  assert.deepEqual(getConnectedDataBusChannelOrder(graph.nodes[0]!, graph.connections), [7, 2, 1]);
  const rewire = createRewireConnectionCommand(setGraph);
  const params = { ...original, outputId: 'output3' as PortId, originalConnection: original };
  const before = graph.connections;
  const applied = rewire.apply(params, undefined, read());
  assert.deepEqual(getConnectedDataBusChannelOrder(graph.nodes[0]!, graph.connections), [7, 1, 3]);
  rewire.undo(params, applied, read());
  assert.deepEqual(getConnectedDataBusChannelOrder(graph.nodes[0]!, graph.connections), [7, 2, 1]);
  assert.deepEqual(
    new Set(graph.connections.map((connection) => JSON.stringify(connection))),
    new Set(before.map((connection) => JSON.stringify(connection))),
  );
});

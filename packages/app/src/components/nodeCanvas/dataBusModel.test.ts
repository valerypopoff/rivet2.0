import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ChartNode,
  NodeConnection,
  NodeId,
  NodeInputDefinition,
  NodeOutputDefinition,
  PortId,
} from '@valerypopoff/rivet2-core';
import {
  buildDataBusGroupPresentation,
  connectionMatchesDataBusChannelKeys,
  createDataBusTopology,
  getDataBusConnectionChannels,
  getDataBusRelatedChannelKeys,
  getDataBusPortChannelIndexKey,
  getRenderableDataBusNodes,
  isDataBusChannelPort,
  isEstablishedDataBusConnection,
  shouldRenderDataBusConnection,
} from './dataBusModel.js';

function node(id: string, dataBus = false): ChartNode {
  return {
    id: id as NodeId,
    type: dataBus ? 'dataBus' : 'text',
    title: id,
    data: {},
    visualData: { x: 0, y: 0 },
  };
}

function connection(outputNodeId: string, outputId: string, inputNodeId: string, inputId: string): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    outputId: outputId as PortId,
    inputNodeId: inputNodeId as NodeId,
    inputId: inputId as PortId,
  };
}

function topology(nodesById: Record<string, ChartNode>, connections: readonly NodeConnection[]) {
  return createDataBusTopology({ connections, nodesById: nodesById as Record<NodeId, ChartNode> });
}

function input(id: string): NodeInputDefinition {
  return { id: id as PortId, title: id, dataType: 'any' } as NodeInputDefinition;
}

function output(id: string): NodeOutputDefinition {
  return { id: id as PortId, title: id, dataType: 'any' } as NodeOutputDefinition;
}

test('indexes provider and consumer connections once while exposing normal endpoint antennas', () => {
  const nodesById = { source: node('source'), bus: node('bus', true), receiver: node('receiver') };
  const provider = connection('source', 'output', 'bus', 'input2');
  const consumer = connection('bus', 'output2', 'receiver', 'input');
  const index = topology(nodesById, [provider, consumer]);

  assert.deepEqual(getDataBusConnectionChannels(provider, index), [
    { busNodeId: 'bus', busTitle: 'bus', channelIndex: 2, channelKey: 'bus:2' },
  ]);
  assert.equal(
    index.connectionsByInputPort.get(
      getDataBusPortChannelIndexKey({ input: true, nodeId: 'bus' as NodeId, portId: 'input2' as PortId }),
    )?.[0],
    provider,
  );
  assert.equal(
    index.connectionsByOutputPort.get(
      getDataBusPortChannelIndexKey({ input: false, nodeId: 'bus' as NodeId, portId: 'output2' as PortId }),
    )?.[0],
    consumer,
  );
  assert.deepEqual(
    index.portChannels
      .get(getDataBusPortChannelIndexKey({ input: false, nodeId: 'source' as NodeId, portId: 'output' as PortId }))
      ?.map((channel) => channel.channelKey),
    ['bus:2'],
  );
  assert.deepEqual(
    index.portChannels
      .get(getDataBusPortChannelIndexKey({ input: true, nodeId: 'receiver' as NodeId, portId: 'input' as PortId }))
      ?.map((channel) => channel.channelKey),
    ['bus:2'],
  );
});

test('uses the dedicated Data Bus node type as the primary rail topology node', () => {
  const bus: ChartNode = {
    id: 'bus' as NodeId,
    type: 'dataBus',
    title: 'bus',
    data: {},
    visualData: { x: 0, y: 0 },
  };
  const provider = connection('source', 'output', 'bus', 'input1');
  const consumer = connection('bus', 'output1', 'receiver', 'input');
  const index = topology({ source: node('source'), bus, receiver: node('receiver') } as Record<string, ChartNode>, [
    provider,
    consumer,
  ]);

  assert.equal(isEstablishedDataBusConnection(provider, index), true);
  assert.equal(isEstablishedDataBusConnection(consumer, index), true);
  assert.deepEqual(
    getRenderableDataBusNodes({ effectiveNodesById: { [bus.id]: bus }, nodes: [bus], presentationEnabled: true }).map(
      ({ editorNode }) => editorNode.id,
    ),
    ['bus'],
  );
});

test('preserves both roles of a direct bus-to-bus connection for hover revelation', () => {
  const nodesById = { first: node('first', true), second: node('second', true) };
  const directBusConnection = connection('first', 'output1', 'second', 'input2');
  const index = topology(nodesById, [directBusConnection]);

  assert.deepEqual(
    getDataBusConnectionChannels(directBusConnection, index).map((channel) => channel.channelKey),
    ['second:2', 'first:1'],
  );
  assert.equal(
    connectionMatchesDataBusChannelKeys({
      connection: directBusConnection,
      topology: index,
      channelKeys: new Set(['first:1']),
    }),
    true,
  );
  assert.equal(
    connectionMatchesDataBusChannelKeys({
      connection: directBusConnection,
      topology: index,
      channelKeys: new Set(['second:2']),
    }),
    true,
  );
  assert.equal(index.activeChannelKeys.has('first:1'), true);
  assert.equal(index.activeChannelKeys.has('second:2'), true);
});

test('follows a complete relay chain when revealing a Data Bus channel', () => {
  const nodesById = {
    source: node('source'),
    first: node('first', true),
    second: node('second', true),
    third: node('third', true),
    receiver: node('receiver'),
  };
  const index = topology(nodesById, [
    connection('source', 'output', 'first', 'input1'),
    connection('first', 'output1', 'second', 'input1'),
    connection('second', 'output1', 'third', 'input1'),
    connection('third', 'output1', 'receiver', 'input'),
  ]);

  assert.deepEqual(getDataBusRelatedChannelKeys(index, ['first:1']), ['first:1', 'second:1', 'third:1']);

  const presentation = buildDataBusGroupPresentation({
    busNode: nodesById.first as any,
    inputDefinitions: [input('input1'), input('input2')],
    outputDefinitions: [output('output1')],
    topology: index,
  });
  assert.deepEqual(presentation.dataChannels[0]?.relatedChannelKeys, ['second:1', 'third:1']);
});

test('identifies canonical ports on dedicated Data Buses for drag overlay routing', () => {
  const bus: ChartNode = {
    id: 'bus' as NodeId,
    type: 'dataBus',
    title: 'bus',
    data: {},
    visualData: { x: 0, y: 0 },
  };
  const nodesById = { bus, ordinary: node('ordinary') } as Record<NodeId, ChartNode>;

  assert.equal(isDataBusChannelPort({ input: true, nodeId: bus.id, nodesById, portId: 'input1' as PortId }), true);
  assert.equal(isDataBusChannelPort({ input: false, nodeId: bus.id, nodesById, portId: 'output1' as PortId }), true);
  assert.equal(isDataBusChannelPort({ input: true, nodeId: bus.id, nodesById, portId: 'input0' as PortId }), false);
  assert.equal(
    isDataBusChannelPort({ input: true, nodeId: 'ordinary' as NodeId, nodesById, portId: 'input1' as PortId }),
    false,
  );
});

test('derives live rail presentation from definitions and shared topology', () => {
  const bus = node('bus', true);
  const provider = connection('source', 'output', 'bus', 'input1');
  const firstConsumer = connection('bus', 'output1', 'first-receiver', 'input');
  const secondConsumer = connection('bus', 'output1', 'second-receiver', 'input');
  const index = topology(
    {
      bus,
      source: node('source'),
      'first-receiver': node('first-receiver'),
      'second-receiver': node('second-receiver'),
    },
    [provider, firstConsumer, secondConsumer],
  );
  const presentation = buildDataBusGroupPresentation({
    busNode: bus as any,
    inputDefinitions: [input('input1'), input('input2')],
    outputDefinitions: [output('output1')],
    topology: index,
  });

  assert.equal(presentation.dataChannels.length, 1);
  assert.equal(presentation.dataChannels[0]?.providerConnections[0], provider);
  assert.equal(presentation.dataChannels[0]?.consumerCount, 2);
  assert.equal(presentation.connectProviderChannel?.channelIndex, 2);
  assert.equal(presentation.connectProviderChannel?.outputDefinition, undefined);
});

test('retains missing and multiple-provider states instead of normalizing them away', () => {
  const bus = node('bus', true);
  const firstProvider = connection('first-source', 'output', 'bus', 'input1');
  const secondProvider = connection('second-source', 'output', 'bus', 'input1');
  const missingProviderConsumer = connection('bus', 'output2', 'receiver', 'input');
  const index = topology(
    {
      bus,
      'first-source': node('first-source'),
      'second-source': node('second-source'),
      receiver: node('receiver'),
    },
    [firstProvider, secondProvider, missingProviderConsumer],
  );
  const presentation = buildDataBusGroupPresentation({
    busNode: bus as any,
    inputDefinitions: [input('input1'), input('input2')],
    outputDefinitions: [output('output1'), output('output2')],
    topology: index,
  });

  assert.equal(presentation.dataChannels[0]?.providerConnections.length, 2);
  assert.equal(presentation.dataChannels[1]?.providerConnections.length, 0);
  assert.equal(presentation.dataChannels[1]?.consumerCount, 1);
});

test('leaves Passthroughs, execution-modified buses, and out-of-range ports out of presentation topology', () => {
  const ordinaryPassthrough: ChartNode = {
    id: 'ordinary-passthrough' as NodeId,
    type: 'passthrough',
    title: 'ordinary-passthrough',
    data: { renderAsDataBus: true },
    visualData: { x: 0, y: 0 },
  };
  const conditionalBus = { ...node('conditional-bus', true), isConditional: true };
  const rangeBus = node('range-bus', true);
  const nodesById = {
    source: node('source'),
    'ordinary-passthrough': ordinaryPassthrough,
    'conditional-bus': conditionalBus,
    'range-bus': rangeBus,
  };
  const ordinary = connection('source', 'output', 'ordinary-passthrough', 'input1');
  const conditional = connection('source', 'output', 'conditional-bus', 'input1');
  const outOfRange = connection('source', 'output', 'range-bus', 'input1000000000');
  const index = topology(nodesById, [ordinary, conditional, outOfRange]);

  assert.equal(isEstablishedDataBusConnection(ordinary, index), false);
  assert.equal(isEstablishedDataBusConnection(conditional, index), false);
  assert.equal(isEstablishedDataBusConnection(outOfRange, index), false);
  assert.equal(index.channelsByConnection.size, 0);
  assert.equal(index.connectionsByInputPort.size, 0);
  assert.equal(index.connectionsByOutputPort.size, 0);
});

test('limits visual buses to connection-enabled canvases and preserves wire repair/comparison visibility', () => {
  const bus = node('bus', true);
  const nodesById = { source: node('source'), bus };
  const provider = connection('source', 'output', 'bus', 'input1');
  const index = topology(nodesById, [provider]);

  assert.deepEqual(
    getRenderableDataBusNodes({ effectiveNodesById: { [bus.id]: bus }, nodes: [bus], presentationEnabled: false }),
    [],
  );
  assert.equal(
    shouldRenderDataBusConnection({
      connection: provider,
      forceVisible: false,
      isDefinitionValid: true,
      topology: index,
    }),
    false,
  );
  assert.equal(
    shouldRenderDataBusConnection({
      connection: provider,
      forceVisible: false,
      isDefinitionValid: false,
      topology: index,
    }),
    true,
  );
  assert.equal(
    shouldRenderDataBusConnection({
      connection: provider,
      forceVisible: true,
      isDefinitionValid: true,
      topology: index,
    }),
    true,
  );
});

test('deduplicates channel references on a normal port without losing duplicate provider diagnostics', () => {
  const nodesById = { source: node('source'), bus: node('bus', true) };
  const duplicate = connection('source', 'output', 'bus', 'input1');
  const index = topology(nodesById, [duplicate, { ...duplicate }]);
  const channels = index.portChannels.get(
    getDataBusPortChannelIndexKey({ input: false, nodeId: 'source' as NodeId, portId: 'output' as PortId }),
  );

  assert.equal(channels?.length, 1);
  assert.equal(channels[0]?.channelKey, 'bus:1');
  assert.equal(
    index.connectionsByInputPort.get(
      getDataBusPortChannelIndexKey({ input: true, nodeId: 'bus' as NodeId, portId: 'input1' as PortId }),
    )?.length,
    2,
  );
});

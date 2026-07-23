import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, NodeConnection, NodeId, PortId } from '@valerypopoff/rivet2-core';
import {
  buildDataBusPortChannelIndex,
  connectionMatchesDataBusChannelKeys,
  getDataBusConnectionChannels,
  getDataBusPortChannelIndexKey,
  getRenderableDataBusNodes,
  isEstablishedDataBusConnection,
  shouldRenderDataBusConnection,
} from './dataBusModel.js';

function node(id: string, renderAsDataBus = false): ChartNode {
  return {
    id: id as NodeId,
    type: renderAsDataBus ? 'passthrough' : 'text',
    title: id,
    data: renderAsDataBus ? { renderAsDataBus: true } : {},
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

test('classifies both sides of an established data-bus channel', () => {
  const nodesById = {
    source: node('source'),
    bus: node('bus', true),
    receiver: node('receiver'),
  };
  const provider = connection('source', 'output', 'bus', 'input2');
  const consumer = connection('bus', 'output2', 'receiver', 'input');

  assert.deepEqual(getDataBusConnectionChannels(provider, nodesById), [
    {
      busNodeId: 'bus',
      busTitle: 'bus',
      channelIndex: 2,
      channelKey: 'bus:2',
    },
  ]);
  assert.equal(isEstablishedDataBusConnection(consumer, nodesById), true);
  const portChannelIndex = buildDataBusPortChannelIndex({
    connections: [provider, consumer],
    nodesById,
  });
  assert.deepEqual(
    portChannelIndex
      .get(
        getDataBusPortChannelIndexKey({
          input: false,
          nodeId: 'source' as NodeId,
          portId: 'output' as PortId,
        }),
      )
      ?.map((channel) => channel.channelKey),
    ['bus:2'],
  );
  assert.deepEqual(
    portChannelIndex
      .get(
        getDataBusPortChannelIndexKey({
          input: true,
          nodeId: 'receiver' as NodeId,
          portId: 'input' as PortId,
        }),
      )
      ?.map((channel) => channel.channelKey),
    ['bus:2'],
  );
});

test('indexes both roles of a direct bus-to-bus connection', () => {
  const nodesById = {
    first: node('first', true),
    second: node('second', true),
  };
  const portChannelIndex = buildDataBusPortChannelIndex({
    connections: [connection('first', 'output1', 'second', 'input2')],
    nodesById,
  });

  assert.deepEqual(
    portChannelIndex
      .get(
        getDataBusPortChannelIndexKey({
          input: false,
          nodeId: 'first' as NodeId,
          portId: 'output1' as PortId,
        }),
      )
      ?.map((channel) => channel.channelKey),
    ['second:2'],
  );
  assert.deepEqual(
    portChannelIndex
      .get(
        getDataBusPortChannelIndexKey({
          input: true,
          nodeId: 'second' as NodeId,
          portId: 'input2' as PortId,
        }),
      )
      ?.map((channel) => channel.channelKey),
    ['first:1'],
  );
});

test('matches every involved bus channel when revealing a connection on hover', () => {
  const nodesById = {
    first: node('first', true),
    second: node('second', true),
  };
  const directBusConnection = connection('first', 'output1', 'second', 'input2');

  assert.deepEqual(
    getDataBusConnectionChannels(directBusConnection, nodesById).map((channel) => channel.channelKey),
    ['second:2', 'first:1'],
  );
  assert.equal(
    connectionMatchesDataBusChannelKeys({
      connection: directBusConnection,
      nodesById,
      channelKeys: new Set(['first:1']),
    }),
    true,
  );
  assert.equal(
    connectionMatchesDataBusChannelKeys({
      connection: directBusConnection,
      nodesById,
      channelKeys: new Set(['second:2']),
    }),
    true,
  );
  assert.equal(
    connectionMatchesDataBusChannelKeys({
      connection: directBusConnection,
      nodesById,
      channelKeys: new Set(['first:3']),
    }),
    false,
  );
});

test('leaves ordinary and execution-modified Passthrough connections visible', () => {
  const ordinaryBus = node('ordinary-bus');
  const conditionalBus = { ...node('conditional-bus', true), isConditional: true };
  const nodesById = {
    source: node('source'),
    'ordinary-bus': ordinaryBus,
    'conditional-bus': conditionalBus,
  };

  assert.equal(
    isEstablishedDataBusConnection(connection('source', 'output', 'ordinary-bus', 'input1'), nodesById),
    false,
  );
  assert.equal(
    isEstablishedDataBusConnection(connection('source', 'output', 'conditional-bus', 'input1'), nodesById),
    false,
  );
});

test('rejects channel indexes that the Passthrough runtime will not expose', () => {
  const nodesById = {
    source: node('source'),
    bus: node('bus', true),
  };
  const pathologicalConnection = connection('source', 'output', 'bus', 'input1000000000');

  assert.deepEqual(getDataBusConnectionChannels(pathologicalConnection, nodesById), []);
  assert.equal(isEstablishedDataBusConnection(pathologicalConnection, nodesById), false);
});

test('limits data-bus presentation to connection-enabled graph canvases', () => {
  const bus = node('bus', true);
  const effectiveNodesById = { [bus.id]: bus };

  assert.deepEqual(
    getRenderableDataBusNodes({
      effectiveNodesById,
      nodes: [bus],
      presentationEnabled: false,
    }),
    [],
  );
  assert.deepEqual(
    getRenderableDataBusNodes({
      effectiveNodesById,
      nodes: [bus],
      presentationEnabled: true,
    }),
    [{ editorNode: bus, effectiveNode: bus }],
  );
});

test('suppresses only established bus wires while retaining repair and comparison wires', () => {
  const nodesById = {
    source: node('source'),
    bus: node('bus', true),
  };
  const provider = connection('source', 'output', 'bus', 'input1');

  assert.equal(
    shouldRenderDataBusConnection({
      connection: provider,
      forceVisible: false,
      isDefinitionValid: true,
      nodesById,
    }),
    false,
  );
  assert.equal(
    shouldRenderDataBusConnection({
      connection: provider,
      forceVisible: false,
      isDefinitionValid: false,
      nodesById,
    }),
    true,
  );
  assert.equal(
    shouldRenderDataBusConnection({
      connection: provider,
      forceVisible: true,
      isDefinitionValid: true,
      nodesById,
    }),
    true,
  );
});

test('deduplicates multiple matching references on one visible port', () => {
  const nodesById = {
    source: node('source'),
    bus: node('bus', true),
  };
  const duplicate = connection('source', 'output', 'bus', 'input1');

  const portChannelIndex = buildDataBusPortChannelIndex({
    connections: [duplicate, { ...duplicate }],
    nodesById,
  });
  const channels = portChannelIndex.get(
    getDataBusPortChannelIndexKey({
      input: false,
      nodeId: 'source' as NodeId,
      portId: 'output' as PortId,
    }),
  );

  assert.equal(channels?.length, 1);
  assert.equal(channels[0]?.channelKey, 'bus:1');
});

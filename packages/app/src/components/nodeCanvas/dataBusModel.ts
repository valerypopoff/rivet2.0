import {
  canRenderPassthroughAsDataBus,
  MAX_PASSTHROUGH_PORT_INDEX,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type PassthroughNode,
  type PortId,
} from '@valerypopoff/rivet2-core';

const INPUT_PORT_PATTERN = /^input(\d+)$/;
const OUTPUT_PORT_PATTERN = /^output(\d+)$/;

export type DataBusChannelReference = {
  busNodeId: NodeId;
  busTitle: string;
  channelIndex: number;
  channelKey: string;
};

export type DataBusPortChannelIndex = ReadonlyMap<string, readonly DataBusChannelReference[]>;

export type RenderableDataBusNode = {
  editorNode: ChartNode;
  effectiveNode: PassthroughNode;
};

function parseChannelIndex(portId: PortId, pattern: RegExp): number | undefined {
  const match = pattern.exec(portId);
  const channelIndex = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(channelIndex) && channelIndex > 0 && channelIndex <= MAX_PASSTHROUGH_PORT_INDEX
    ? channelIndex
    : undefined;
}

export function getDataBusChannelKey(busNodeId: NodeId, channelIndex: number): string {
  return `${busNodeId}:${channelIndex}`;
}

export function getDataBusInputChannelIndex(portId: PortId): number | undefined {
  return parseChannelIndex(portId, INPUT_PORT_PATTERN);
}

export function getDataBusOutputChannelIndex(portId: PortId): number | undefined {
  return parseChannelIndex(portId, OUTPUT_PORT_PATTERN);
}

export function getDataBusPortChannelIndexKey(options: { input: boolean; nodeId: NodeId; portId: PortId }): string {
  return `${options.nodeId}\u0000${options.input ? 'input' : 'output'}\u0000${options.portId}`;
}

export function getRenderableDataBusNodes(options: {
  effectiveNodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
  nodes: readonly ChartNode[];
  presentationEnabled: boolean;
}): RenderableDataBusNode[] {
  if (!options.presentationEnabled) {
    return [];
  }

  return options.nodes.flatMap((editorNode) => {
    const effectiveNode = options.effectiveNodesById[editorNode.id];
    return canRenderPassthroughAsDataBus(effectiveNode) ? [{ editorNode, effectiveNode }] : [];
  });
}

export function getDataBusConnectionChannels(
  connection: NodeConnection,
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>,
): readonly DataBusChannelReference[] {
  const channels: DataBusChannelReference[] = [];
  const inputNode = nodesById[connection.inputNodeId];
  const inputChannelIndex = getDataBusInputChannelIndex(connection.inputId);

  if (canRenderPassthroughAsDataBus(inputNode) && inputChannelIndex != null) {
    channels.push({
      busNodeId: inputNode.id,
      busTitle: inputNode.title,
      channelIndex: inputChannelIndex,
      channelKey: getDataBusChannelKey(inputNode.id, inputChannelIndex),
    });
  }

  const outputNode = nodesById[connection.outputNodeId];
  const outputChannelIndex = getDataBusOutputChannelIndex(connection.outputId);

  if (canRenderPassthroughAsDataBus(outputNode) && outputChannelIndex != null) {
    const channelKey = getDataBusChannelKey(outputNode.id, outputChannelIndex);

    if (!channels.some((channel) => channel.channelKey === channelKey)) {
      channels.push({
        busNodeId: outputNode.id,
        busTitle: outputNode.title,
        channelIndex: outputChannelIndex,
        channelKey,
      });
    }
  }

  return channels;
}

export function connectionMatchesDataBusChannelKeys(options: {
  connection: NodeConnection;
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
  channelKeys: ReadonlySet<string>;
}): boolean {
  return getDataBusConnectionChannels(options.connection, options.nodesById).some((channel) =>
    options.channelKeys.has(channel.channelKey),
  );
}

export function isEstablishedDataBusConnection(
  connection: NodeConnection,
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>,
): boolean {
  return getDataBusConnectionChannels(connection, nodesById).length > 0;
}

export function shouldRenderDataBusConnection(options: {
  connection: NodeConnection;
  forceVisible: boolean;
  isDefinitionValid: boolean;
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
}): boolean {
  return (
    options.forceVisible ||
    !options.isDefinitionValid ||
    !isEstablishedDataBusConnection(options.connection, options.nodesById)
  );
}

export function buildDataBusPortChannelIndex(options: {
  connections: readonly NodeConnection[];
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
}): DataBusPortChannelIndex {
  const channelsByPort = new Map<string, Map<string, DataBusChannelReference>>();

  const addChannel = (options: {
    busNode: PassthroughNode;
    channelIndex: number;
    input: boolean;
    nodeId: NodeId;
    portId: PortId;
  }) => {
    const portKey = getDataBusPortChannelIndexKey(options);
    const channelKey = getDataBusChannelKey(options.busNode.id, options.channelIndex);
    const channelsByKey = channelsByPort.get(portKey) ?? new Map<string, DataBusChannelReference>();

    channelsByKey.set(channelKey, {
      busNodeId: options.busNode.id,
      busTitle: options.busNode.title,
      channelIndex: options.channelIndex,
      channelKey,
    });
    channelsByPort.set(portKey, channelsByKey);
  };

  for (const connection of options.connections) {
    const providerBusNode = options.nodesById[connection.inputNodeId];
    const providerChannelIndex = getDataBusInputChannelIndex(connection.inputId);

    if (canRenderPassthroughAsDataBus(providerBusNode) && providerChannelIndex != null) {
      addChannel({
        busNode: providerBusNode,
        channelIndex: providerChannelIndex,
        input: false,
        nodeId: connection.outputNodeId,
        portId: connection.outputId,
      });
    }

    const consumerBusNode = options.nodesById[connection.outputNodeId];
    const consumerChannelIndex = getDataBusOutputChannelIndex(connection.outputId);

    if (canRenderPassthroughAsDataBus(consumerBusNode) && consumerChannelIndex != null) {
      addChannel({
        busNode: consumerBusNode,
        channelIndex: consumerChannelIndex,
        input: true,
        nodeId: connection.inputNodeId,
        portId: connection.inputId,
      });
    }
  }

  return new Map([...channelsByPort].map(([portKey, channelsByKey]) => [portKey, [...channelsByKey.values()]]));
}

export function formatDataBusChannelLabel(channel: DataBusChannelReference): string {
  return `${channel.busTitle} / Channel ${channel.channelIndex}`;
}

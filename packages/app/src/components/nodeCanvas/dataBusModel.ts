import {
  canRenderDataBusNode,
  getDataBusChannelKey as getCoreDataBusChannelKey,
  getDataBusInputChannelIndex as getCoreDataBusInputChannelIndex,
  getDataBusOutputChannelIndex as getCoreDataBusOutputChannelIndex,
  type ChartNode,
  type DataBusTopologyNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '@valerypopoff/rivet2-core';

export type DataBusChannelReference = {
  busNodeId: NodeId;
  busTitle: string;
  channelIndex: number;
  channelKey: string;
};

export type DataBusPortChannelIndex = ReadonlyMap<string, readonly DataBusChannelReference[]>;

/**
 * The one canvas-scoped interpretation of preview connections for data-bus UI.
 * It deliberately contains topology only: rendered port definitions remain
 * live in DataBusRail because plugins and variadic nodes can change them.
 */
export type DataBusTopology = {
  activeChannelKeys: ReadonlySet<string>;
  channelsByConnection: ReadonlyMap<NodeConnection, readonly DataBusChannelReference[]>;
  connectionsByInputPort: ReadonlyMap<string, readonly NodeConnection[]>;
  connectionsByOutputPort: ReadonlyMap<string, readonly NodeConnection[]>;
  portChannels: DataBusPortChannelIndex;
  /**
   * Direct relay relationships between channels. A connection from one Data
   * Bus channel to another creates an undirected edge here; callers use
   * getDataBusRelatedChannelKeys() to follow the complete relay route.
   */
  relatedChannelKeysByChannelKey: ReadonlyMap<string, readonly string[]>;
};

export type DataBusChannelPresentation = {
  channelIndex: number;
  channelKey: string;
  consumerCount: number;
  inputDefinition: NodeInputDefinition;
  outputDefinition: NodeOutputDefinition | undefined;
  providerConnections: readonly NodeConnection[];
  relatedChannelKeys: readonly string[];
};

export type DataBusGroupPresentation = {
  channels: readonly DataBusChannelPresentation[];
  connectProviderChannel: DataBusChannelPresentation | undefined;
  dataChannels: readonly DataBusChannelPresentation[];
};

export type RenderableDataBusNode = {
  editorNode: ChartNode;
  effectiveNode: DataBusTopologyNode;
};

export const EMPTY_DATA_BUS_TOPOLOGY: DataBusTopology = {
  activeChannelKeys: new Set(),
  channelsByConnection: new Map(),
  connectionsByInputPort: new Map(),
  connectionsByOutputPort: new Map(),
  portChannels: new Map(),
  relatedChannelKeysByChannelKey: new Map(),
};

export function getDataBusChannelKey(busNodeId: NodeId, channelIndex: number): string {
  return getCoreDataBusChannelKey(busNodeId, channelIndex);
}

export function getDataBusInputChannelIndex(portId: PortId): number | undefined {
  return getCoreDataBusInputChannelIndex(portId);
}

export function getDataBusOutputChannelIndex(portId: PortId): number | undefined {
  return getCoreDataBusOutputChannelIndex(portId);
}

export function getDataBusPortChannelIndexKey(options: { input: boolean; nodeId: NodeId; portId: PortId }): string {
  return `${options.nodeId}\u0000${options.input ? 'input' : 'output'}\u0000${options.portId}`;
}

/** Returns whether a live port belongs to a rendered Data Bus channel. */
export function isDataBusChannelPort(options: {
  input: boolean;
  nodeId: NodeId;
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
  portId: PortId;
}): boolean {
  const node = options.nodesById[options.nodeId];
  if (!canRenderDataBusNode(node)) {
    return false;
  }

  return options.input
    ? getDataBusInputChannelIndex(options.portId) != null
    : getDataBusOutputChannelIndex(options.portId) != null;
}

function getConnectionChannels(
  connection: NodeConnection,
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>,
): readonly DataBusChannelReference[] {
  const channels: DataBusChannelReference[] = [];
  const inputNode = nodesById[connection.inputNodeId];
  const inputChannelIndex = getDataBusInputChannelIndex(connection.inputId);

  if (canRenderDataBusNode(inputNode) && inputChannelIndex != null) {
    channels.push({
      busNodeId: inputNode.id,
      busTitle: inputNode.title,
      channelIndex: inputChannelIndex,
      channelKey: getDataBusChannelKey(inputNode.id, inputChannelIndex),
    });
  }

  const outputNode = nodesById[connection.outputNodeId];
  const outputChannelIndex = getDataBusOutputChannelIndex(connection.outputId);

  if (canRenderDataBusNode(outputNode) && outputChannelIndex != null) {
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

/**
 * Builds the shared, preview-connection topology once per canvas render pass.
 * Connection order is preserved in every grouped collection.
 */
export function createDataBusTopology(options: {
  connections: readonly NodeConnection[];
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
}): DataBusTopology {
  const connectionsByInputPort = new Map<string, NodeConnection[]>();
  const connectionsByOutputPort = new Map<string, NodeConnection[]>();
  const channelsByConnection = new Map<NodeConnection, readonly DataBusChannelReference[]>();
  const activeChannelKeys = new Set<string>();
  const mutablePortChannels = new Map<string, Map<string, DataBusChannelReference>>();
  const mutableRelatedChannelKeys = new Map<string, Set<string>>();

  const addConnection = (
    connectionsByPort: Map<string, NodeConnection[]>,
    options: {
      input: boolean;
      nodeId: NodeId;
      portId: PortId;
    },
    connection: NodeConnection,
  ) => {
    const key = getDataBusPortChannelIndexKey(options);
    const portConnections = connectionsByPort.get(key) ?? [];
    portConnections.push(connection);
    connectionsByPort.set(key, portConnections);
  };

  const addPortChannel = (options: {
    channel: DataBusChannelReference;
    input: boolean;
    nodeId: NodeId;
    portId: PortId;
  }) => {
    const portKey = getDataBusPortChannelIndexKey(options);
    const channelsByKey = mutablePortChannels.get(portKey) ?? new Map<string, DataBusChannelReference>();
    channelsByKey.set(options.channel.channelKey, options.channel);
    mutablePortChannels.set(portKey, channelsByKey);
  };

  const addChannelRelationships = (channels: readonly DataBusChannelReference[]) => {
    for (const channel of channels) {
      const relatedChannelKeys = mutableRelatedChannelKeys.get(channel.channelKey) ?? new Set<string>();
      mutableRelatedChannelKeys.set(channel.channelKey, relatedChannelKeys);

      for (const relatedChannel of channels) {
        if (relatedChannel.channelKey !== channel.channelKey) {
          relatedChannelKeys.add(relatedChannel.channelKey);
        }
      }
    }
  };

  for (const connection of options.connections) {
    const channels = getConnectionChannels(connection, options.nodesById);
    if (channels.length === 0) {
      continue;
    }

    channelsByConnection.set(connection, channels);
    channels.forEach((channel) => activeChannelKeys.add(channel.channelKey));
    addChannelRelationships(channels);

    const inputNode = options.nodesById[connection.inputNodeId];
    const inputChannelIndex = getDataBusInputChannelIndex(connection.inputId);
    const inputChannel =
      canRenderDataBusNode(inputNode) && inputChannelIndex != null
        ? channels.find(
            (candidate) => candidate.busNodeId === inputNode.id && candidate.channelIndex === inputChannelIndex,
          )
        : undefined;
    if (inputChannel) {
      addConnection(
        connectionsByInputPort,
        { input: true, nodeId: connection.inputNodeId, portId: connection.inputId },
        connection,
      );
      addPortChannel({
        channel: inputChannel,
        input: false,
        nodeId: connection.outputNodeId,
        portId: connection.outputId,
      });
    }

    const outputNode = options.nodesById[connection.outputNodeId];
    const outputChannelIndex = getDataBusOutputChannelIndex(connection.outputId);
    const outputChannel =
      canRenderDataBusNode(outputNode) && outputChannelIndex != null
        ? channels.find(
            (candidate) => candidate.busNodeId === outputNode.id && candidate.channelIndex === outputChannelIndex,
          )
        : undefined;
    if (outputChannel) {
      addConnection(
        connectionsByOutputPort,
        { input: false, nodeId: connection.outputNodeId, portId: connection.outputId },
        connection,
      );
      addPortChannel({
        channel: outputChannel,
        input: true,
        nodeId: connection.inputNodeId,
        portId: connection.inputId,
      });
    }
  }

  return {
    activeChannelKeys,
    channelsByConnection,
    connectionsByInputPort,
    connectionsByOutputPort,
    portChannels: new Map(
      [...mutablePortChannels].map(([portKey, channelsByKey]) => [portKey, [...channelsByKey.values()]]),
    ),
    relatedChannelKeysByChannelKey: new Map(
      [...mutableRelatedChannelKeys].map(([channelKey, relatedChannelKeys]) => [channelKey, [...relatedChannelKeys]]),
    ),
  };
}

/**
 * Resolves every Data Bus channel that belongs to the same relay route as
 * one of the supplied channels. This is intentionally transitive: the core
 * supports A -> B -> C Data Bus relays, so hover presentation must not stop
 * after the first hop.
 */
export function getDataBusRelatedChannelKeys(
  topology: DataBusTopology,
  channelKeys: readonly string[],
): readonly string[] {
  const resolvedChannelKeys = new Set<string>();
  const pendingChannelKeys = [...channelKeys];
  let pendingChannelIndex = 0;

  while (pendingChannelIndex < pendingChannelKeys.length) {
    const channelKey = pendingChannelKeys[pendingChannelIndex++]!;
    if (resolvedChannelKeys.has(channelKey)) {
      continue;
    }

    resolvedChannelKeys.add(channelKey);
    for (const relatedChannelKey of topology.relatedChannelKeysByChannelKey.get(channelKey) ?? []) {
      if (!resolvedChannelKeys.has(relatedChannelKey)) {
        pendingChannelKeys.push(relatedChannelKey);
      }
    }
  }

  return [...resolvedChannelKeys];
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
    return canRenderDataBusNode(effectiveNode) ? [{ editorNode, effectiveNode }] : [];
  });
}

/** Combines one bus's current live IO definitions with canvas-wide topology. */
export function buildDataBusGroupPresentation(options: {
  inputDefinitions: readonly NodeInputDefinition[];
  outputDefinitions: readonly NodeOutputDefinition[];
  topology: DataBusTopology;
  busNode: DataBusTopologyNode;
}): DataBusGroupPresentation {
  const outputDefinitionsByChannelIndex = new Map<number, NodeOutputDefinition>();
  for (const outputDefinition of options.outputDefinitions) {
    const channelIndex = getDataBusOutputChannelIndex(outputDefinition.id);
    if (channelIndex != null) {
      outputDefinitionsByChannelIndex.set(channelIndex, outputDefinition);
    }
  }

  const channels = options.inputDefinitions.flatMap((inputDefinition) => {
    const channelIndex = getDataBusInputChannelIndex(inputDefinition.id);
    if (channelIndex == null) {
      return [];
    }

    const channelKey = getDataBusChannelKey(options.busNode.id, channelIndex);
    const outputDefinition = outputDefinitionsByChannelIndex.get(channelIndex);
    const providerConnections =
      options.topology.connectionsByInputPort.get(
        getDataBusPortChannelIndexKey({ input: true, nodeId: options.busNode.id, portId: inputDefinition.id }),
      ) ?? [];
    const consumerConnections = outputDefinition
      ? options.topology.connectionsByOutputPort.get(
          getDataBusPortChannelIndexKey({ input: false, nodeId: options.busNode.id, portId: outputDefinition.id }),
        ) ?? []
      : [];
    const relatedChannelKeys = getDataBusRelatedChannelKeys(options.topology, [channelKey]).filter(
      (relatedChannelKey) => relatedChannelKey !== channelKey,
    );

    return [
      {
        channelIndex,
        channelKey,
        consumerCount: consumerConnections.length,
        inputDefinition,
        outputDefinition,
        providerConnections,
        relatedChannelKeys,
      },
    ];
  });
  const connectProviderChannel = channels.find((channel) => channel.outputDefinition == null);

  return {
    channels,
    connectProviderChannel,
    dataChannels: channels.filter(
      (channel) =>
        channel !== connectProviderChannel && (channel.providerConnections.length > 0 || channel.consumerCount > 0),
    ),
  };
}

export function getDataBusConnectionChannels(
  connection: NodeConnection,
  topology: DataBusTopology,
): readonly DataBusChannelReference[] {
  return topology.channelsByConnection.get(connection) ?? [];
}

export function connectionMatchesDataBusChannelKeys(options: {
  connection: NodeConnection;
  topology: DataBusTopology;
  channelKeys: ReadonlySet<string>;
}): boolean {
  return getDataBusConnectionChannels(options.connection, options.topology).some((channel) =>
    options.channelKeys.has(channel.channelKey),
  );
}

export function isEstablishedDataBusConnection(connection: NodeConnection, topology: DataBusTopology): boolean {
  return getDataBusConnectionChannels(connection, topology).length > 0;
}

export function shouldRenderDataBusConnection(options: {
  connection: NodeConnection;
  forceVisible: boolean;
  isDefinitionValid: boolean;
  topology: DataBusTopology;
}): boolean {
  return (
    options.forceVisible ||
    !options.isDefinitionValid ||
    !isEstablishedDataBusConnection(options.connection, options.topology)
  );
}

export function formatDataBusChannelLabel(channel: DataBusChannelReference): string {
  return `${channel.busTitle} / Channel ${channel.channelIndex}`;
}

import { parseDataBusChannelIndex } from './DataBusPorts.js';
import type { DataBusNode } from './nodes/DataBusNode.js';
import type { ChartNode, NodeConnection, NodeId, PortId } from './NodeBase.js';

type LegacyDataBusNodeData = {
  renderAsDataBus?: boolean;
};

export type DataBusTopologyNode = DataBusNode | ChartNode<'passthrough', LegacyDataBusNodeData>;

export type CompiledDataBusTopology = {
  connections: NodeConnection[];
  executionNodes: ChartNode[];
};

type MutableChannel = {
  busNodeId: NodeId;
  channelIndex: number;
  providerConnections: NodeConnection[];
  consumerConnections: NodeConnection[];
};

export function isLegacyDataBusNode(node: ChartNode | undefined): node is ChartNode<'passthrough', LegacyDataBusNodeData> {
  return node?.type === 'passthrough' && (node.data as LegacyDataBusNodeData | undefined)?.renderAsDataBus === true;
}

function isDataBusNode(node: ChartNode | undefined): node is DataBusNode {
  return node?.type === 'dataBus';
}

/**
 * Legacy rail Passthroughs become topology nodes only while their normal
 * execution modifiers are inactive. Imported incompatible Passthroughs keep
 * their ordinary runtime behavior until manually repaired or migrated.
 */
export function isDataBusTopologyNode(node: ChartNode | undefined): node is DataBusTopologyNode {
  if (isDataBusNode(node)) {
    return true;
  }

  return (
    isLegacyDataBusNode(node) &&
    !node.isConditional &&
    !node.isSplitRun &&
    !node.disabled &&
    (node.variants?.length ?? 0) === 0
  );
}

export function canRenderDataBusNode(node: ChartNode | undefined): node is DataBusTopologyNode {
  return (
    isDataBusTopologyNode(node) &&
    !node.isConditional &&
    !node.isSplitRun &&
    !node.disabled &&
    (node.variants?.length ?? 0) === 0
  );
}

export function getDataBusChannelKey(busNodeId: NodeId, channelIndex: number): string {
  return `${busNodeId}:${channelIndex}`;
}

export function getDataBusInputChannelIndex(portId: PortId): number | undefined {
  return parseDataBusChannelIndex(portId, true);
}

export function getDataBusOutputChannelIndex(portId: PortId): number | undefined {
  return parseDataBusChannelIndex(portId, false);
}

export function compileDataBusTopology(options: {
  connections: readonly NodeConnection[];
  graphNodes: readonly ChartNode[];
}): CompiledDataBusTopology {
  const nodesById = Object.fromEntries(options.graphNodes.map((node) => [node.id, node])) as Record<NodeId, ChartNode>;
  const dataBusNodeIds = new Set(options.graphNodes.filter(isDataBusTopologyNode).map((node) => node.id));

  if (dataBusNodeIds.size === 0) {
    return {
      connections: [...options.connections],
      executionNodes: [...options.graphNodes],
    };
  }

  for (const nodeId of dataBusNodeIds) {
    const node = nodesById[nodeId]!;
    if (isDataBusNode(node) && (node.isConditional || node.isSplitRun || node.disabled || node.variants?.length)) {
      throw new Error(
        `Data Bus "${node.title}" cannot be conditional, run per item, disabled, or variant-driven. Data Bus channels are always-active topology.`,
      );
    }
  }

  const channelsByBusAndIndex = new Map<string, MutableChannel>();
  const rawConnections = [...options.connections];
  const directConnections: NodeConnection[] = [];

  const getMutableChannel = (busNodeId: NodeId, channelIndex: number): MutableChannel => {
    const key = getDataBusChannelKey(busNodeId, channelIndex);
    const existing = channelsByBusAndIndex.get(key);
    if (existing) {
      return existing;
    }

    const channel = { busNodeId, channelIndex, providerConnections: [], consumerConnections: [] };
    channelsByBusAndIndex.set(key, channel);
    return channel;
  };

  for (const connection of rawConnections) {
    const inputNode = nodesById[connection.inputNodeId];
    const outputNode = nodesById[connection.outputNodeId];
    const inputBus = isDataBusTopologyNode(inputNode) ? inputNode : undefined;
    const outputBus = isDataBusTopologyNode(outputNode) ? outputNode : undefined;

    if (!inputBus && !outputBus) {
      directConnections.push(connection);
      continue;
    }

    if (inputBus) {
      const channelIndex = getDataBusInputChannelIndex(connection.inputId);
      if (channelIndex == null) {
        throw new Error(`Data Bus "${inputBus.title}" has an invalid input port "${connection.inputId}".`);
      }
      getMutableChannel(inputBus.id, channelIndex).providerConnections.push(connection);
    }

    if (outputBus) {
      const channelIndex = getDataBusOutputChannelIndex(connection.outputId);
      if (channelIndex == null) {
        throw new Error(`Data Bus "${outputBus.title}" has an invalid output port "${connection.outputId}".`);
      }
      getMutableChannel(outputBus.id, channelIndex).consumerConnections.push(connection);
    }
  }

  for (const [key, channel] of channelsByBusAndIndex) {
    if (channel.providerConnections.length > 1) {
      throw new Error(`Data Bus channel ${key} has ${channel.providerConnections.length} providers. Connect exactly one provider.`);
    }
  }

  // Validate the relay graph independently of ordinary consumers. Without
  // this pass, a closed bus-to-bus loop with no receiver would never be
  // resolved below and could be saved as invalid, dormant topology.
  const relayProviderByChannelKey = new Map<string, string>();
  for (const [key, channel] of channelsByBusAndIndex) {
    const providerConnection = channel.providerConnections[0];
    if (!providerConnection) {
      continue;
    }

    const providerNode = nodesById[providerConnection.outputNodeId];
    if (!isDataBusTopologyNode(providerNode)) {
      continue;
    }

    const providerChannelIndex = getDataBusOutputChannelIndex(providerConnection.outputId);
    if (providerChannelIndex == null) {
      throw new Error(`Data Bus "${providerNode.title}" has an invalid output port "${providerConnection.outputId}".`);
    }
    relayProviderByChannelKey.set(key, getDataBusChannelKey(providerNode.id, providerChannelIndex));
  }

  const checkedRelayChannelKeys = new Set<string>();
  for (const startKey of relayProviderByChannelKey.keys()) {
    if (checkedRelayChannelKeys.has(startKey)) {
      continue;
    }

    const path = new Set<string>();
    let currentKey: string | undefined = startKey;
    while (currentKey != null && !checkedRelayChannelKeys.has(currentKey)) {
      if (path.has(currentKey)) {
        throw new Error(
          `Data Bus relay cycle detected at channel ${currentKey}. Disconnect one relay connection to break the cycle.`,
        );
      }

      path.add(currentKey);
      currentKey = relayProviderByChannelKey.get(currentKey);
    }

    for (const key of path) {
      checkedRelayChannelKeys.add(key);
    }
  }

  type ResolvedBusOutput = { nodeId: NodeId; outputId: PortId };
  const resolvedBusOutputs = new Map<string, ResolvedBusOutput | undefined>();

  const resolveBusOutput = (busNodeId: NodeId, channelIndex: number): ResolvedBusOutput | undefined => {
    const startKey = getDataBusChannelKey(busNodeId, channelIndex);
    if (resolvedBusOutputs.has(startKey)) {
      return resolvedBusOutputs.get(startKey);
    }

    const traversedKeys: string[] = [];
    const traversedKeySet = new Set<string>();
    let currentKey = startKey;
    let resolved: ResolvedBusOutput | undefined;

    while (true) {
      if (resolvedBusOutputs.has(currentKey)) {
        resolved = resolvedBusOutputs.get(currentKey);
        break;
      }
      // Relay cycles were validated above. Retain this guard so malformed
      // future changes cannot turn resolution into an infinite loop.
      if (traversedKeySet.has(currentKey)) {
        throw new Error(
          `Data Bus relay cycle detected at channel ${currentKey}. Disconnect one relay connection to break the cycle.`,
        );
      }

      traversedKeySet.add(currentKey);
      traversedKeys.push(currentKey);
      const channel = channelsByBusAndIndex.get(currentKey);
      const providerConnection = channel?.providerConnections[0];
      if (!providerConnection) {
        break;
      }

      const providerNode = nodesById[providerConnection.outputNodeId];
      if (!isDataBusTopologyNode(providerNode)) {
        resolved = {
          nodeId: providerConnection.outputNodeId,
          outputId: providerConnection.outputId,
        };
        break;
      }

      const providerChannelIndex = getDataBusOutputChannelIndex(providerConnection.outputId);
      if (providerChannelIndex == null) {
        throw new Error(`Data Bus "${providerNode.title}" has an invalid output port "${providerConnection.outputId}".`);
      }
      currentKey = getDataBusChannelKey(providerNode.id, providerChannelIndex);
    }

    for (const key of traversedKeys) {
      resolvedBusOutputs.set(key, resolved);
    }
    return resolved;
  };

  const effectiveConnections = [...directConnections];
  const effectiveProviderByInput = new Map<string, NodeConnection>();

  const addEffectiveConnection = (connection: NodeConnection) => {
    const consumerKey = `${connection.inputNodeId}\u0000${connection.inputId}`;
    const existing = effectiveProviderByInput.get(consumerKey);
    if (existing) {
      if (existing.outputNodeId === connection.outputNodeId && existing.outputId === connection.outputId) {
        return;
      }
      throw new Error(
        `Data Bus routing gives "${nodesById[connection.inputNodeId]?.title ?? connection.inputNodeId}".${connection.inputId} more than one effective provider.`,
      );
    }
    effectiveProviderByInput.set(consumerKey, connection);
    effectiveConnections.push(connection);
  };

  for (const directConnection of directConnections) {
    effectiveProviderByInput.set(`${directConnection.inputNodeId}\u0000${directConnection.inputId}`, directConnection);
  }

  for (const channel of channelsByBusAndIndex.values()) {
    const busId = channel.busNodeId;
    const channelIndex = channel.channelIndex;
    for (const consumerConnection of channel.consumerConnections) {
      const consumerNode = nodesById[consumerConnection.inputNodeId];
      if (isDataBusTopologyNode(consumerNode)) {
        continue;
      }

      const resolved = resolveBusOutput(busId, channelIndex);
      if (!resolved) {
        continue;
      }

      const connection: NodeConnection = {
        inputNodeId: consumerConnection.inputNodeId,
        inputId: consumerConnection.inputId,
        outputNodeId: resolved.nodeId,
        outputId: resolved.outputId,
      };
      addEffectiveConnection(connection);
    }
  }

  return {
    connections: effectiveConnections,
    executionNodes: options.graphNodes.filter((node) => !dataBusNodeIds.has(node.id)),
  };
}

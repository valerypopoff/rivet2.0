import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '@valerypopoff/rivet2-core';

type NodeIoDefinitions = {
  inputDefinitions: readonly NodeInputDefinition[];
  outputDefinitions: readonly NodeOutputDefinition[];
};

type PortEndpoint = {
  nodeId: NodeId;
  portId: PortId;
};

type UpstreamResolution =
  | { kind: 'origin'; endpoint: PortEndpoint }
  | { kind: 'no-origin' }
  | { kind: 'invalid' };

const INPUT_PORT_PATTERN = /^input(\d+)$/;
const OUTPUT_PORT_PATTERN = /^output(\d+)$/;

function getSlotIndex(portId: PortId, pattern: RegExp): number | undefined {
  const match = pattern.exec(portId);
  if (!match) return undefined;

  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index > 0 ? index : undefined;
}

function getPortTitle(title: unknown): string | undefined {
  return typeof title === 'string' && title.trim() ? title : undefined;
}

/**
 * Resolves display-only Passthrough labels without changing its stable numbered
 * port IDs. Traversal crosses other Passthrough nodes but stops before asking
 * the I/O selector for one, which keeps relay cycles finite and avoids selector
 * recursion.
 */
export function applyPassthroughConnectionLabels(options: {
  nodeId: NodeId;
  nodesById: Readonly<Record<NodeId, ChartNode>>;
  connections: readonly NodeConnection[];
  inputDefinitions: readonly NodeInputDefinition[];
  outputDefinitions: readonly NodeOutputDefinition[];
  getNodeIoDefinitions: (nodeId: NodeId) => NodeIoDefinitions;
}): { inputDefinitions: NodeInputDefinition[]; outputDefinitions: NodeOutputDefinition[] } {
  if (options.nodesById[options.nodeId]?.type !== 'passthrough') {
    return {
      inputDefinitions: [...options.inputDefinitions],
      outputDefinitions: [...options.outputDefinitions],
    };
  }

  const connectionKey = (nodeId: NodeId, portId: PortId) => `${nodeId}\u0000${portId}`;
  const providersByInput = new Map<string, NodeConnection[]>();
  const consumersByOutput = new Map<string, NodeConnection[]>();
  for (const connection of options.connections) {
    const providers = providersByInput.get(connectionKey(connection.inputNodeId, connection.inputId)) ?? [];
    providers.push(connection);
    providersByInput.set(connectionKey(connection.inputNodeId, connection.inputId), providers);

    const consumers = consumersByOutput.get(connectionKey(connection.outputNodeId, connection.outputId)) ?? [];
    consumers.push(connection);
    consumersByOutput.set(connectionKey(connection.outputNodeId, connection.outputId), consumers);
  }
  const ioDefinitionsByNode = new Map<NodeId, NodeIoDefinitions>();
  const getIoDefinitions = (nodeId: NodeId) => {
    const cached = ioDefinitionsByNode.get(nodeId);
    if (cached) return cached;
    const definitions = options.getNodeIoDefinitions(nodeId);
    ioDefinitionsByNode.set(nodeId, definitions);
    return definitions;
  };

  const resolveUpstreamEndpoint = (nodeId: NodeId, slotIndex: number): UpstreamResolution => {
    const visited = new Set<string>();
    let currentNodeId = nodeId;
    let currentSlotIndex = slotIndex;

    while (true) {
      const visitKey = `${currentNodeId}:input${currentSlotIndex}`;
      if (visited.has(visitKey)) return { kind: 'invalid' };
      visited.add(visitKey);

      const providers = providersByInput.get(connectionKey(currentNodeId, `input${currentSlotIndex}` as PortId)) ?? [];
      if (providers.length === 0) return { kind: 'no-origin' };
      if (providers.length !== 1) return { kind: 'invalid' };

      const provider = providers[0]!;
      const providerNode = options.nodesById[provider.outputNodeId];
      if (!providerNode) return { kind: 'invalid' };
      if (providerNode.type !== 'passthrough') {
        return { kind: 'origin', endpoint: { nodeId: provider.outputNodeId, portId: provider.outputId } };
      }

      const providerSlotIndex = getSlotIndex(provider.outputId, OUTPUT_PORT_PATTERN);
      if (providerSlotIndex == null) return { kind: 'invalid' };
      currentNodeId = provider.outputNodeId;
      currentSlotIndex = providerSlotIndex;
    }
  };

  const resolveDownstreamEndpoints = (
    nodeId: NodeId,
    slotIndex: number,
  ): { complete: boolean; endpoints: PortEndpoint[] } => {
    const queue = [{ nodeId, slotIndex }];
    let queueIndex = 0;
    const visited = new Set<string>();
    const endpoints: PortEndpoint[] = [];
    let complete = true;

    while (queueIndex < queue.length) {
      const current = queue[queueIndex++]!;
      const visitKey = `${current.nodeId}:output${current.slotIndex}`;
      if (visited.has(visitKey)) {
        complete = false;
        continue;
      }
      visited.add(visitKey);

      const consumers =
        consumersByOutput.get(connectionKey(current.nodeId, `output${current.slotIndex}` as PortId)) ?? [];
      if (consumers.length === 0) complete = false;

      for (const consumer of consumers) {
        const consumerNode = options.nodesById[consumer.inputNodeId];
        if (!consumerNode) {
          complete = false;
          continue;
        }
        if (consumerNode.type !== 'passthrough') {
          endpoints.push({ nodeId: consumer.inputNodeId, portId: consumer.inputId });
          continue;
        }

        const consumerSlotIndex = getSlotIndex(consumer.inputId, INPUT_PORT_PATTERN);
        if (consumerSlotIndex == null) {
          complete = false;
          continue;
        }
        queue.push({ nodeId: consumer.inputNodeId, slotIndex: consumerSlotIndex });
      }
    }

    return { complete, endpoints };
  };

  const getConnectedTitle = (slotIndex: number): string | undefined => {
    const upstream = resolveUpstreamEndpoint(options.nodeId, slotIndex);
    if (upstream.kind === 'origin') {
      const output = getIoDefinitions(upstream.endpoint.nodeId).outputDefinitions.find(
        (definition) => definition.id === upstream.endpoint.portId,
      );
      return getPortTitle(output?.title);
    }
    if (upstream.kind === 'invalid') return undefined;

    const downstream = resolveDownstreamEndpoints(options.nodeId, slotIndex);
    if (!downstream.complete || downstream.endpoints.length === 0) return undefined;
    const downstreamTitles = downstream.endpoints.map((endpoint) =>
      getPortTitle(
        getIoDefinitions(endpoint.nodeId).inputDefinitions.find((definition) => definition.id === endpoint.portId)
          ?.title,
      ),
    );
    if (downstreamTitles.some((title) => title == null)) return undefined;

    const uniqueTitles = new Set(downstreamTitles);
    return uniqueTitles.size === 1 ? downstreamTitles[0] : undefined;
  };

  const titlesBySlot = new Map<number, string | undefined>();
  const getTitleForPort = (portId: PortId, pattern: RegExp) => {
    const slotIndex = getSlotIndex(portId, pattern);
    if (slotIndex == null) return undefined;
    if (!titlesBySlot.has(slotIndex)) titlesBySlot.set(slotIndex, getConnectedTitle(slotIndex));
    return titlesBySlot.get(slotIndex);
  };

  return {
    inputDefinitions: options.inputDefinitions.map((definition) => {
      const title = getTitleForPort(definition.id, INPUT_PORT_PATTERN);
      return title ? { ...definition, title } : definition;
    }),
    outputDefinitions: options.outputDefinitions.map((definition) => {
      const title = getTitleForPort(definition.id, OUTPUT_PORT_PATTERN);
      return title ? { ...definition, title } : definition;
    }),
  };
}

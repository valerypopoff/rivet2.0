import {
  type DataValue,
  type ExternalFunction,
  type NodeGraph,
  type NodeId,
  type NodeRegistration,
  type PortId,
  type Project,
} from '@valerypopoff/rivet2-core';

export function parseConnectionOptions(options: unknown) {
  if (
    typeof options !== 'object' ||
    options == null ||
    !('sourceNodeId' in options) ||
    !('destNodeId' in options) ||
    !('sourcePortId' in options) ||
    !('destPortId' in options)
  ) {
    throw new Error('Invalid connection options');
  }

  return options as {
    sourceNodeId: NodeId;
    destNodeId: NodeId;
    sourcePortId: PortId;
    destPortId: PortId;
  };
}

function normalizeNodeTypeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stripNodeTypeWrapper(value: string): string {
  const trimmed = value.trim();
  const codeFenceMatch = trimmed.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  const unwrapped = codeFenceMatch?.[1]?.trim() ?? trimmed;
  const jsonString = unwrapped.match(/^"(.*)"$/s) ? unwrapped : undefined;

  if (jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      if (typeof parsed === 'string') {
        return parsed.trim();
      }
    } catch {
      // Fall through to quote stripping below.
    }
  }

  return unwrapped
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+node$/i, '')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function stripStringWrapper(value: string): string {
  return value.trim().replace(/^["'`]+|["'`]+$/g, '');
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function resolveAiGraphBuilderNodeId(rawNodeId: unknown): NodeId {
  const nodeId = isRecord(rawNodeId) ? readStringField(rawNodeId, 'nodeId') : rawNodeId;

  if (typeof nodeId !== 'string' || nodeId.trim().length === 0) {
    throw new Error('Node id must be a non-empty string.');
  }

  return stripStringWrapper(nodeId) as NodeId;
}

export function resolveAiGraphBuilderNodeDataKey(data: Record<string, unknown>, rawKey: unknown): string {
  if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
    throw new Error('Node data key must be a non-empty string.');
  }

  const key = stripStringWrapper(rawKey);
  const bracketKey = key.match(/^(?:\$\.|node\.)?data\[['"`]?([^'"`\]]+)['"`]?\]$/)?.[1];
  const candidates = [
    key,
    key.replace(/^(?:\$\.|node\.)?data\./, ''),
    key.replace(/^nodeData\./, ''),
    bracketKey,
  ].filter((candidate): candidate is string => !!candidate);

  const matchingKey = candidates.find((candidate) => candidate in data);

  if (!matchingKey) {
    throw new Error(
      `Key ${rawKey} does not exist on node data. Available data keys: ${Object.keys(data).join(', ') || '(none)'}.`,
    );
  }

  return matchingKey;
}

export function parseAiGraphBuilderEditNodeArgs(
  rawNodeId: unknown,
  rawKey?: unknown,
  rawValue?: unknown,
): { nodeId: NodeId; key: string; value: unknown } {
  if (isRecord(rawNodeId) && 'nodeId' in rawNodeId) {
    return {
      nodeId: resolveAiGraphBuilderNodeId(rawNodeId),
      key: readStringField(rawNodeId, 'key') ?? '',
      value: rawNodeId.value,
    };
  }

  return {
    nodeId: resolveAiGraphBuilderNodeId(rawNodeId),
    key: typeof rawKey === 'string' ? rawKey : '',
    value: rawValue,
  };
}

function resolveAiGraphBuilderRequestedNodeType(rawNodeType: unknown): string {
  const nodeType = isRecord(rawNodeType) ? readStringField(rawNodeType, 'nodeType') : rawNodeType;

  if (typeof nodeType !== 'string') {
    throw new Error(`Node type must be a string, received ${typeof nodeType}.`);
  }

  return stripNodeTypeWrapper(nodeType);
}

export function resolveAiGraphBuilderNodeType(registry: NodeRegistration<any, any>, rawNodeType: unknown): string {
  const requestedNodeType = resolveAiGraphBuilderRequestedNodeType(rawNodeType);
  const requestedKey = normalizeNodeTypeLabel(requestedNodeType);
  const nodeTypes = registry.getNodeTypes() as string[];
  const aliasNodeType = getAiGraphBuilderNodeTypeAlias(requestedKey);

  if (aliasNodeType && nodeTypes.includes(aliasNodeType)) {
    return aliasNodeType;
  }

  for (const nodeType of nodeTypes) {
    if (nodeType === requestedNodeType) {
      return nodeType;
    }
  }

  for (const nodeType of nodeTypes) {
    const displayName = registry.getDynamicDisplayName(nodeType);
    const displayCandidates = [displayName, `${displayName} Node`].map(normalizeNodeTypeLabel);

    if (displayCandidates.includes(requestedKey)) {
      return nodeType;
    }
  }

  for (const nodeType of nodeTypes) {
    const internalCandidates = [nodeType, `${nodeType}Node`].map(normalizeNodeTypeLabel);

    if (internalCandidates.includes(requestedKey)) {
      return nodeType;
    }
  }

  throw new Error(`Unknown node type: ${requestedNodeType || rawNodeType}`);
}

function getAiGraphBuilderNodeTypeAlias(requestedKey: string): string | undefined {
  if (
    [
      'chat',
      'chatnode',
      'chatv2',
      'chatv2node',
      'openaichat',
      'openaichatnode',
      'llmchat',
      'llmchatnode',
      'llmchatv2',
      'llmchatv2node',
    ].includes(requestedKey)
  ) {
    return 'llmChatV2';
  }

  return undefined;
}

export function buildAiGraphBuilderExternalFunctions(options: {
  project: Project;
  referencedProjects: Record<string, Project>;
  registry: NodeRegistration<any, any>;
  showChanges: () => void;
  workingGraph: () => NodeGraph;
  setWorkingGraph: (graph: NodeGraph) => void;
  onLog?: (message: string) => void;
}): Record<string, ExternalFunction> {
  const getWorkingGraph = options.workingGraph;
  const setWorkingGraph = options.setWorkingGraph;

  return {
    createNode: async (_ctx: unknown, nodeType: unknown) => {
      const graph = getWorkingGraph();
      const resolvedNodeType = resolveAiGraphBuilderNodeType(options.registry, nodeType);
      options.onLog?.(`Resolved createNode node type ${JSON.stringify(nodeType)} -> ${resolvedNodeType}`);
      const newNode = options.registry.createDynamic(resolvedNodeType);
      setWorkingGraph({
        ...graph,
        nodes: [...graph.nodes, newNode],
      });
      options.showChanges();
      options.onLog?.(`Created node ${newNode.id} (${resolvedNodeType}).`);
      return {
        type: 'string',
        value: newNode.id,
      };
    },
    connectNodes: async (_ctx: unknown, rawOptions: unknown) => {
      const { sourceNodeId, destNodeId, sourcePortId, destPortId } = parseConnectionOptions(rawOptions);
      const graph = getWorkingGraph();
      const sourceNode = graph.nodes.find((node) => node.id === sourceNodeId);
      const destNode = graph.nodes.find((node) => node.id === destNodeId);
      options.onLog?.(`Connecting ${sourceNodeId}.${sourcePortId} -> ${destNodeId}.${destPortId}.`);

      if (!sourceNode) {
        throw new Error(`Node with ID ${sourceNodeId} not found`);
      }

      if (!destNode) {
        throw new Error(`Node with ID ${destNodeId} not found`);
      }

      const sourceInstance = options.registry.createDynamicImpl(sourceNode);
      const destInstance = options.registry.createDynamicImpl(destNode);
      const sourceNodeConnections = graph.connections.filter((connection) => connection.outputNodeId === sourceNodeId);
      const destNodeConnections = graph.connections.filter((connection) => connection.inputNodeId === destNodeId);
      const nodesById = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
      const sourcePort = sourceInstance
        .getOutputDefinitions(sourceNodeConnections, nodesById, options.project, options.referencedProjects)
        .find((port) => port.id === sourcePortId);
      const destPort = destInstance
        .getInputDefinitions(destNodeConnections, nodesById, options.project, options.referencedProjects)
        .find((port) => port.id === destPortId);

      if (!sourcePort) {
        throw new Error(`Output port with ID ${sourcePortId} not found on node ${sourceNodeId}`);
      }

      if (!destPort) {
        throw new Error(`Input port with ID ${destPortId} not found on node ${destNodeId}`);
      }

      const alreadyConnectedToDest = graph.connections.find(
        (connection) => connection.inputNodeId === destNodeId && connection.inputId === destPortId,
      );

      if (alreadyConnectedToDest) {
        throw new Error(`Node ${destNodeId} is already connected to this output. Disconnect it first.`);
      }

      setWorkingGraph({
        ...graph,
        connections: [
          ...graph.connections,
          {
            outputNodeId: sourceNodeId,
            outputId: sourcePortId,
            inputNodeId: destNodeId,
            inputId: destPortId,
          },
        ],
      });
      options.showChanges();
      options.onLog?.(`Connected ${sourceNodeId}.${sourcePortId} -> ${destNodeId}.${destPortId}.`);

      return {
        type: 'boolean',
        value: true,
      };
    },
    disconnectNodes: async (_ctx: unknown, rawOptions: unknown) => {
      const { sourceNodeId, destNodeId, sourcePortId, destPortId } = parseConnectionOptions(rawOptions);
      const graph = getWorkingGraph();
      options.onLog?.(`Disconnecting ${sourceNodeId}.${sourcePortId} -> ${destNodeId}.${destPortId}.`);
      const toRemove = graph.connections.find(
        (connection) =>
          connection.outputNodeId === sourceNodeId &&
          connection.inputNodeId === destNodeId &&
          connection.outputId === sourcePortId &&
          connection.inputId === destPortId,
      );

      if (!toRemove) {
        throw new Error('Connection not found. Use reviewGraph to see all connections.');
      }

      setWorkingGraph({
        ...graph,
        connections: graph.connections.filter((connection) => connection !== toRemove),
      });
      options.showChanges();
      options.onLog?.(`Disconnected ${sourceNodeId}.${sourcePortId} -> ${destNodeId}.${destPortId}.`);

      return {
        type: 'boolean',
        value: true,
      };
    },
    getSerializedGraph: async () => ({
      type: 'string',
      value: JSON.stringify(getWorkingGraph(), null, 2),
    }),
    getPorts: async (_ctx: unknown, nodeId: unknown) => {
      const graph = getWorkingGraph();
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);

      if (!node) {
        throw new Error(`Node with ID ${nodeId} not found`);
      }
      options.onLog?.(`Reading ports for node ${node.id} (${node.type}).`);

      const connectionsToNode = graph.connections.filter(
        (connection) => connection.inputNodeId === node.id || connection.outputNodeId === node.id,
      );
      const instance = options.registry.createDynamicImpl(node);
      const nodesById = Object.fromEntries(graph.nodes.map((candidate) => [candidate.id, candidate]));
      const inputs = instance.getInputDefinitions(connectionsToNode, nodesById, options.project, options.referencedProjects);
      const outputs = instance.getOutputDefinitions(connectionsToNode, nodesById, options.project, options.referencedProjects);

      return {
        type: 'object',
        value: {
          inputs: inputs.map((input) => ({
            definition: input,
            connectedTo: connectionsToNode.find(
              (connection) => connection.inputNodeId === node.id && connection.inputId === input.id,
            ),
            actualDataType: node.isSplitRun ? `${input.dataType}[]` : input.dataType,
          })),
          outputs: outputs.map((output) => ({
            definition: output,
            connectedTo: connectionsToNode.filter(
              (connection) => connection.outputNodeId === node.id && connection.outputId === output.id,
            ),
            actualDataType: node.isSplitRun ? `${output.dataType}[]` : output.dataType,
          })),
        },
      } as DataValue;
    },
  };
}

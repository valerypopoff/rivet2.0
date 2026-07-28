import {
  type ChartNode,
  type DataValue,
  type ExternalFunction,
  type NodeGraph,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type NodeRegistration,
  type PortId,
  type Project,
  newId,
} from '@valerypopoff/rivet2-core';
import { getPortCompatibilityStatus } from '../domain/graphEditing/portCompatibility.js';
import type { GraphBuilderAuthoringCatalogSnapshot } from '../features/graphBuilder/authoringCatalog.js';

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

  const matchingKey = candidates.find((candidate) => Object.hasOwn(data, candidate));

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

export function resolveLegacyGraphBuilderAuthoringChoice(
  catalog: GraphBuilderAuthoringCatalogSnapshot,
  rawNodeType: unknown,
): string {
  const requestedNodeType = resolveAiGraphBuilderRequestedNodeType(rawNodeType);
  const requestedKey = normalizeNodeTypeLabel(requestedNodeType);
  if (!requestedKey) {
    throw new Error('Node type must not be empty.');
  }

  const legacyAlias = getAiGraphBuilderNodeTypeAlias(requestedKey);
  if (legacyAlias) {
    const aliasedChoice = catalog
      .listEntries()
      .find((entry) => entry.family === 'registered' && entry.nodeType === legacyAlias);
    if (aliasedChoice) {
      return aliasedChoice.authoringChoiceId;
    }
  }

  const candidates = catalog.listEntries().filter((entry) => {
    const labels = [
      entry.authoringChoiceId,
      entry.nodeType,
      entry.displayName,
      `${entry.displayName} Node`,
      ...entry.aliases,
    ];
    return labels.some((label) => normalizeNodeTypeLabel(label) === requestedKey);
  });

  if (candidates.length === 1) {
    return candidates[0]!.authoringChoiceId;
  }
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous node type "${requestedNodeType}". Matching choices: ${candidates
        .map((candidate) => candidate.authoringChoiceId)
        .join(', ')}.`,
    );
  }

  throw new Error(`Unknown or unsupported node type: ${requestedNodeType}`);
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
  catalog: GraphBuilderAuthoringCatalogSnapshot;
  project: Project | (() => Project);
  referencedProjects: Record<string, Project>;
  registry: NodeRegistration<any, any>;
  showChanges: () => void;
  workingGraph: () => NodeGraph;
  setWorkingGraph: (graph: NodeGraph) => void;
  onLog?: (message: string) => void;
}): Record<string, ExternalFunction> {
  const getWorkingGraph = options.workingGraph;
  const setWorkingGraph = options.setWorkingGraph;
  const getProject = () => (typeof options.project === 'function' ? options.project() : options.project);

  return {
    createNode: async (_ctx: unknown, nodeType: unknown) => {
      const graph = getWorkingGraph();
      const authoringChoiceId = resolveLegacyGraphBuilderAuthoringChoice(options.catalog, nodeType);
      const newNode = options.catalog.createNode({
        authoringChoiceId,
        allocatedNodeId: newId<NodeId>(),
        project: getProject(),
      });
      options.onLog?.(`Resolved createNode node type ${JSON.stringify(nodeType)} -> ${authoringChoiceId}`);
      setWorkingGraph({
        ...graph,
        nodes: [...graph.nodes, newNode],
      });
      options.showChanges();
      options.onLog?.(`Created node ${newNode.id} (${newNode.type}).`);
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
      if (!options.catalog.canResolveNodeType(sourceNode.type) || !options.catalog.canResolveNodeType(destNode.type)) {
        throw new Error('Connections to opaque plugin nodes are unavailable in the legacy Graph Builder.');
      }

      const project = getProject();
      const sourcePorts = resolveAiGraphBuilderNodePorts({
        graph,
        node: sourceNode,
        project,
        referencedProjects: options.referencedProjects,
        registry: options.registry,
      });
      const destPorts = resolveAiGraphBuilderNodePorts({
        graph,
        node: destNode,
        project,
        referencedProjects: options.referencedProjects,
        registry: options.registry,
      });
      const sourcePort = sourcePorts.outputs.find((port) => port.id === sourcePortId);
      const destPort = destPorts.inputs.find((port) => port.id === destPortId);

      if (!sourcePort) {
        throw new Error(`Output port with ID ${sourcePortId} not found on node ${sourceNodeId}`);
      }

      if (!destPort) {
        throw new Error(`Input port with ID ${destPortId} not found on node ${destNodeId}`);
      }

      const compatibility = getPortCompatibilityStatus({
        draggingDataType: sourcePort.dataType,
        portDataType: destPort.dataType,
        canCoerce: destPort.coerced ?? true,
        isInput: true,
      });
      if (compatibility === 'incompatible' || compatibility === 'none') {
        throw new Error(
          `Output ${sourceNodeId}.${sourcePortId} is not compatible with input ${destNodeId}.${destPortId}.`,
        );
      }

      const alreadyConnectedToDest = graph.connections.find(
        (connection) => connection.inputNodeId === destNodeId && connection.inputId === destPortId,
      );

      if (alreadyConnectedToDest) {
        throw new Error(`Node ${destNodeId} already has a connection to this input. Disconnect it first.`);
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
    getPorts: async (_ctx: unknown, nodeId: unknown) => {
      const graph = getWorkingGraph();
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);

      if (!node) {
        throw new Error(`Node with ID ${nodeId} not found`);
      }
      if (!options.catalog.canResolveNodeType(node.type)) {
        throw new Error(
          `Ports for opaque plugin node type "${node.type}" are unavailable in the legacy Graph Builder.`,
        );
      }
      options.onLog?.(`Reading ports for node ${node.id} (${node.type}).`);

      const connectionsToNode = graph.connections.filter(
        (connection) => connection.inputNodeId === node.id || connection.outputNodeId === node.id,
      );
      const { inputs, outputs } = resolveAiGraphBuilderNodePorts({
        graph,
        node,
        project: getProject(),
        referencedProjects: options.referencedProjects,
        registry: options.registry,
      });

      return {
        type: 'object',
        value: {
          inputs: inputs.map((input) => ({
            definition: {
              id: input.id,
              title: input.title,
              dataType: input.dataType,
              required: input.required ?? false,
              coerced: input.coerced ?? false,
            },
            connectedTo: connectionsToNode.find(
              (connection) => connection.inputNodeId === node.id && connection.inputId === input.id,
            ),
            actualDataType: node.isSplitRun ? `${input.dataType}[]` : input.dataType,
          })),
          outputs: outputs.map((output) => ({
            definition: {
              id: output.id,
              title: output.title,
              dataType: output.dataType,
            },
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

export function resolveAiGraphBuilderNodePorts(options: {
  graph: NodeGraph;
  node: ChartNode;
  project: Project;
  referencedProjects: Record<string, Project>;
  registry: NodeRegistration<any, any>;
}): { inputs: NodeInputDefinition[]; outputs: NodeOutputDefinition[] } {
  const incidentConnections = options.graph.connections.filter(
    (connection) => connection.inputNodeId === options.node.id || connection.outputNodeId === options.node.id,
  );
  const nodesById = Object.fromEntries(options.graph.nodes.map((node) => [node.id, node]));
  const instance = options.registry.createDynamicImpl(options.node);

  return {
    inputs: instance.getInputDefinitionsIncludingBuiltIn(
      incidentConnections,
      nodesById,
      options.project,
      options.referencedProjects,
    ),
    outputs: instance.getOutputDefinitions(incidentConnections, nodesById, options.project, options.referencedProjects),
  };
}

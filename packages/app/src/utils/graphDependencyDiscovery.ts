import {
  findAutoDelegateGraphCandidate,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type PortId,
  type Project,
} from '@valerypopoff/rivet2-core';

export type GraphDependencyEdgeKind =
  | 'direct-static'
  | 'static-via-callgraph'
  | 'dynamic-via-callgraph'
  | 'cross-project'
  | 'invalid';

type GraphDependencyEdge = {
  kind: GraphDependencyEdgeKind;
  targets: readonly GraphId[];
  warnings?: string[];
};

type GraphDependencyProject = Pick<Project, 'graphs'>;

type GraphDependencyIndex = {
  allGraphIds: readonly GraphId[];
  connectionsByInputNodeId: ReadonlyMap<NodeId, readonly NodeConnection[]>;
  connectionsByOutputNodeId: ReadonlyMap<NodeId, readonly NodeConnection[]>;
  firstValidInputConnections: ReadonlyMap<NodeId, ReadonlyMap<PortId, NodeConnection>>;
  graph: NodeGraph;
  graphEntries: readonly [GraphId, NodeGraph][];
  nodesById: ReadonlyMap<NodeId, ChartNode>;
  project: GraphDependencyProject;
};

type GraphDependencyDiscovery = {
  allGraphIds: readonly GraphId[];
  graphEntries: readonly [GraphId, NodeGraph][];
  project: GraphDependencyProject;
};

type GraphReferenceNodeData = {
  graphId?: GraphId;
  useGraphIdOrNameInput?: boolean;
};

type LoopUntilNodeData = {
  targetGraph?: GraphId;
};

type CronNodeData = {
  targetGraph?: GraphId;
  useTargetGraphInput?: boolean;
};

type DelegateFunctionCallNodeData = {
  autoDelegate?: boolean;
  handlers?: Array<{ key: string; value: GraphId }>;
  unknownHandler?: GraphId;
};

type GptFunctionNodeData = {
  name?: string;
  useNameInput?: boolean;
};

type LLMChatV2NodeData = {
  useToolCalling?: boolean;
};

type LegacyChatNodeData = {
  enableFunctionUse?: boolean;
  parallelFunctionCalling?: boolean;
};

type RunThreadNodeData = {
  toolCallHandlers?: Array<{ key: string; value: GraphId }>;
  onMessageCreationSubgraphId?: GraphId;
};

type CallGraphSourceResolution =
  | {
      status: 'missing';
      warnings: string[];
    }
  | {
      status: 'resolved';
      sourceConnection: NodeConnection;
      sourceNode: ChartNode;
      warnings: string[];
    };

const CALL_GRAPH_INPUT_ID = 'graph' as PortId;
const GRAPH_REFERENCE_OUTPUT_ID = 'graph' as PortId;
const DELEGATE_FUNCTION_CALL_INPUT_ID = 'function-call' as PortId;
const FUNCTION_CALL_OUTPUT_ID = 'function-call' as PortId;
const FUNCTION_CALLS_OUTPUT_ID = 'function-calls' as PortId;
const indexesByDiscovery = new WeakMap<GraphDependencyDiscovery, Map<GraphId, GraphDependencyIndex>>();

/**
 * Creates the ordered, per-project discovery surface used by reachability
 * traversal and direct-reference queries. Graph map keys stay authoritative
 * here; runtime uses graph metadata IDs independently.
 */
export function createGraphDependencyDiscovery(project: GraphDependencyProject): GraphDependencyDiscovery {
  const graphEntries = Object.entries(project.graphs) as Array<[GraphId, NodeGraph]>;
  const discovery: GraphDependencyDiscovery = {
    allGraphIds: graphEntries.map(([graphId]) => graphId),
    graphEntries,
    project,
  };
  indexesByDiscovery.set(discovery, new Map());
  return discovery;
}

export function getGraphDependencyIndex(
  discovery: GraphDependencyDiscovery,
  graphId: GraphId,
): GraphDependencyIndex | undefined {
  const indexesByGraphId = indexesByDiscovery.get(discovery);
  if (!indexesByGraphId) {
    return undefined;
  }

  const existing = indexesByGraphId.get(graphId);
  if (existing) {
    return existing;
  }

  const graph = discovery.project.graphs[graphId];
  if (!graph) {
    return undefined;
  }

  const nodesById = new Map<NodeId, ChartNode>();
  for (const node of graph.nodes) {
    // Object.fromEntries in the former implementation retained the final
    // duplicate ID, so Map#set intentionally does the same.
    nodesById.set(node.id, node);
  }

  const connectionsByInputNodeId = new Map<NodeId, NodeConnection[]>();
  const connectionsByOutputNodeId = new Map<NodeId, NodeConnection[]>();
  for (const connection of graph.connections) {
    const inputConnections = connectionsByInputNodeId.get(connection.inputNodeId) ?? [];
    inputConnections.push(connection);
    connectionsByInputNodeId.set(connection.inputNodeId, inputConnections);

    const outputConnections = connectionsByOutputNodeId.get(connection.outputNodeId) ?? [];
    outputConnections.push(connection);
    connectionsByOutputNodeId.set(connection.outputNodeId, outputConnections);
  }

  const firstValidInputConnections = new Map<NodeId, Map<PortId, NodeConnection>>();
  for (const [inputNodeId, connections] of connectionsByInputNodeId) {
    const firstByPort = new Map<PortId, NodeConnection>();
    for (const connection of connections) {
      if (!firstByPort.has(connection.inputId) && nodesById.has(connection.outputNodeId)) {
        firstByPort.set(connection.inputId, connection);
      }
    }
    firstValidInputConnections.set(inputNodeId, firstByPort);
  }

  const index: GraphDependencyIndex = {
    allGraphIds: discovery.allGraphIds,
    connectionsByInputNodeId,
    connectionsByOutputNodeId,
    firstValidInputConnections,
    graph,
    graphEntries: discovery.graphEntries,
    nodesById,
    project: discovery.project,
  };
  indexesByGraphId.set(graphId, index);
  return index;
}

export function collectGraphDependencyEdges(options: {
  index: GraphDependencyIndex;
  includeDelegateFunctionCallEdges?: boolean;
  onlyDelegateFunctionCallEdges?: boolean;
}): GraphDependencyEdge[] {
  const { index, includeDelegateFunctionCallEdges = true, onlyDelegateFunctionCallEdges = false } = options;
  const edges: GraphDependencyEdge[] = [];

  for (const node of index.graph.nodes) {
    if (node.disabled) {
      continue;
    }

    if (onlyDelegateFunctionCallEdges && node.type !== 'delegateFunctionCall') {
      continue;
    }

    switch (node.type) {
      case 'subGraph':
        addStoredTarget(edges, index, 'direct-static', {
          graphId: (node.data as GraphReferenceNodeData).graphId,
          description: 'subgraph target',
          node,
        });
        break;

      case 'loopUntil':
        addStoredTarget(edges, index, 'direct-static', {
          graphId: (node.data as LoopUntilNodeData).targetGraph,
          description: 'loop target graph',
          node,
        });
        break;

      case 'cron':
        collectCronDependencies(edges, index, node);
        break;

      case 'delegateFunctionCall':
        if (includeDelegateFunctionCallEdges) {
          collectDelegateToolCallDependencies(edges, index, node);
        }
        break;

      case 'openaiRunThread':
        collectRunThreadDependencies(edges, index, node);
        break;

      case 'callGraph':
        edges.push(...collectCallGraphDependencies(index, node));
        break;

      case 'referencedGraphAlias':
        edges.push({ kind: 'cross-project', targets: [] });
        break;

      default:
        break;
    }
  }

  return edges;
}

/** Finds graph roots reachable through active Delegate Tool Call paths. */
export function getDelegateToolTargetGraphIds(discovery: GraphDependencyDiscovery): Set<GraphId> {
  const graphIds = new Set<GraphId>();

  for (const [graphId] of discovery.graphEntries) {
    const index = getGraphDependencyIndex(discovery, graphId);
    if (!index) {
      continue;
    }

    for (const edge of collectGraphDependencyEdges({ index, onlyDelegateFunctionCallEdges: true })) {
      if (isReachableGraphDependencyEdge(edge)) {
        edge.targets.forEach((targetGraphId) => graphIds.add(targetGraphId));
      }
    }
  }

  return graphIds;
}

export function isReachableGraphDependencyEdge(edge: GraphDependencyEdge): boolean {
  return edge.kind !== 'cross-project' && edge.kind !== 'invalid';
}

function addStoredTarget(
  edges: GraphDependencyEdge[],
  index: GraphDependencyIndex,
  kind: Extract<GraphDependencyEdgeKind, 'direct-static' | 'static-via-callgraph'>,
  options: {
    graphId: GraphId | undefined;
    description: string;
    node: ChartNode;
  },
) {
  const { graphId, description, node } = options;
  if (!graphId) {
    edges.push({
      kind: 'invalid',
      targets: [],
      warnings: [`${formatNodeContext(index.graph, node)} has no configured ${description}.`],
    });
    return;
  }

  if (!index.project.graphs[graphId]) {
    edges.push({
      kind: 'invalid',
      targets: [],
      warnings: [`${formatNodeContext(index.graph, node)} references missing graph ${graphId} via ${description}.`],
    });
    return;
  }

  edges.push({ kind, targets: [graphId] });
}

function collectCronDependencies(edges: GraphDependencyEdge[], index: GraphDependencyIndex, node: ChartNode) {
  const data = node.data as CronNodeData;
  const warning =
    data.useTargetGraphInput && data.targetGraph
      ? `${formatNodeContext(index.graph, node)} enables Target Graph input, but the current Cron node implementation still executes the stored targetGraph.`
      : undefined;

  addStoredTarget(edges, index, 'direct-static', {
    graphId: data.targetGraph,
    description: 'cron target graph',
    node,
  });

  if (warning) {
    const lastEdge = edges[edges.length - 1];
    if (lastEdge) {
      lastEdge.warnings = [...(lastEdge.warnings ?? []), warning];
    }
  }
}

function collectDelegateToolCallDependencies(
  edges: GraphDependencyEdge[],
  index: GraphDependencyIndex,
  node: ChartNode,
) {
  if (!hasActiveDelegateFunctionCallInput(index, node)) {
    return;
  }

  const data = node.data as DelegateFunctionCallNodeData;
  if (data.autoDelegate) {
    let hasUnmatchedConnectedTool = false;
    for (const toolName of getConnectedStaticToolNames(index, node)) {
      const targetGraph = findAutoDelegateGraphCandidate(
        index.graphEntries,
        toolName,
        ([, candidateGraph]) => candidateGraph.metadata?.name,
      );

      if (targetGraph) {
        // Analysis has always used the serialized project-map key rather than
        // graph.metadata.id. The runtime caller intentionally does the latter.
        edges.push({ kind: 'direct-static', targets: [targetGraph[0]] });
      } else {
        hasUnmatchedConnectedTool = true;
      }
    }

    if (data.unknownHandler && hasUnmatchedConnectedTool) {
      addStoredTarget(edges, index, 'direct-static', {
        graphId: data.unknownHandler,
        description: 'delegate fallback graph',
        node,
      });
    }
    return;
  }

  for (const handler of data.handlers ?? []) {
    if (!handler.key) {
      continue;
    }

    addStoredTarget(edges, index, 'direct-static', {
      graphId: handler.value,
      description: `delegate handler graph for "${handler.key || 'unknown'}"`,
      node,
    });
  }

  if (data.unknownHandler) {
    addStoredTarget(edges, index, 'direct-static', {
      graphId: data.unknownHandler,
      description: 'delegate fallback graph',
      node,
    });
  }
}

function collectRunThreadDependencies(edges: GraphDependencyEdge[], index: GraphDependencyIndex, node: ChartNode) {
  const data = node.data as RunThreadNodeData;
  for (const handler of data.toolCallHandlers ?? []) {
    addStoredTarget(edges, index, 'direct-static', {
      graphId: handler.value,
      description: `run thread handler graph for "${handler.key || 'unknown'}"`,
      node,
    });
  }

  if (data.onMessageCreationSubgraphId) {
    addStoredTarget(edges, index, 'direct-static', {
      graphId: data.onMessageCreationSubgraphId,
      description: 'run thread on-message graph',
      node,
    });
  }
}

function collectCallGraphDependencies(index: GraphDependencyIndex, node: ChartNode): GraphDependencyEdge[] {
  const sourceResolution = resolveCallGraphSource(index, node);
  if (sourceResolution.status === 'missing') {
    return createInvalidEdgeOrSkip(sourceResolution.warnings);
  }

  const { sourceConnection, sourceNode, warnings } = sourceResolution;
  if (sourceNode.disabled) {
    return createInvalidEdgeOrSkip(warnings);
  }

  if (!isStaticGraphReferenceCarrier(sourceNode, sourceConnection.outputId)) {
    return [withWarnings({ kind: 'dynamic-via-callgraph', targets: index.allGraphIds }, warnings)];
  }

  const data = sourceNode.data as GraphReferenceNodeData;
  if (data.useGraphIdOrNameInput) {
    return [withWarnings({ kind: 'dynamic-via-callgraph', targets: index.allGraphIds }, warnings)];
  }

  if (!data.graphId) {
    return [
      {
        kind: 'invalid',
        targets: [],
        warnings: [
          ...warnings,
          `${formatNodeContext(index.graph, sourceNode)} has no configured graph reference target.`,
        ],
      },
    ];
  }

  if (!index.project.graphs[data.graphId]) {
    return [
      {
        kind: 'invalid',
        targets: [],
        warnings: [
          ...warnings,
          `${formatNodeContext(index.graph, sourceNode)} references missing graph ${data.graphId}; downstream Call Graph nodes cannot resolve it statically.`,
        ],
      },
    ];
  }

  return [withWarnings({ kind: 'static-via-callgraph', targets: [data.graphId] }, warnings)];
}

function hasActiveDelegateFunctionCallInput(index: GraphDependencyIndex, delegateNode: ChartNode): boolean {
  const sourceConnection = getFirstValidInputConnection(index, delegateNode.id, DELEGATE_FUNCTION_CALL_INPUT_ID);
  if (!sourceConnection) {
    return false;
  }

  const sourceNode = index.nodesById.get(sourceConnection.outputNodeId)!;
  return !sourceNode.disabled && isEnabledToolCallOutput(sourceNode, sourceConnection.outputId);
}

function getConnectedStaticToolNames(index: GraphDependencyIndex, delegateNode: ChartNode): Set<string> {
  const toolNames = new Set<string>();

  for (const node of index.graph.nodes) {
    if (node.disabled || node.type !== 'gptFunction') {
      continue;
    }

    const data = node.data as GptFunctionNodeData;
    const toolName = data.useNameInput ? '' : data.name?.trim() ?? '';
    if (toolName && hasActiveConnectionPathToDelegate(index, node.id, delegateNode)) {
      toolNames.add(toolName);
    }
  }

  return toolNames;
}

function hasActiveConnectionPathToDelegate(
  index: GraphDependencyIndex,
  sourceNodeId: NodeId,
  delegateNode: ChartNode,
): boolean {
  const visited = new Set<NodeId>([sourceNodeId]);
  const queue = [sourceNodeId];

  while (queue.length > 0) {
    const currentNodeId = queue.shift()!;

    for (const connection of index.connectionsByOutputNodeId.get(currentNodeId) ?? []) {
      if (!isFirstValidInputConnection(index, connection)) {
        continue;
      }

      if (connection.inputNodeId === delegateNode.id && connection.inputId === DELEGATE_FUNCTION_CALL_INPUT_ID) {
        return true;
      }

      const nextNode = index.nodesById.get(connection.inputNodeId);
      if (!nextNode || nextNode.disabled || visited.has(nextNode.id)) {
        continue;
      }

      visited.add(nextNode.id);
      queue.push(nextNode.id);
    }
  }

  return false;
}

function getFirstValidInputConnection(
  index: GraphDependencyIndex,
  inputNodeId: NodeId,
  inputId: PortId,
): NodeConnection | undefined {
  return index.firstValidInputConnections.get(inputNodeId)?.get(inputId);
}

function isFirstValidInputConnection(index: GraphDependencyIndex, connection: NodeConnection): boolean {
  return getFirstValidInputConnection(index, connection.inputNodeId, connection.inputId) === connection;
}

function isEnabledToolCallOutput(node: ChartNode, outputId: PortId): boolean {
  if (node.type === 'llmChatV2') {
    return (node.data as LLMChatV2NodeData).useToolCalling === true && outputId === FUNCTION_CALLS_OUTPUT_ID;
  }

  if (node.type === 'chat') {
    const data = node.data as LegacyChatNodeData;
    return (
      data.enableFunctionUse === true &&
      outputId === (data.parallelFunctionCalling ? FUNCTION_CALLS_OUTPUT_ID : FUNCTION_CALL_OUTPUT_ID)
    );
  }

  // Other nodes can intentionally produce a Delegate Tool Call-compatible object.
  return true;
}

function resolveCallGraphSource(index: GraphDependencyIndex, node: ChartNode): CallGraphSourceResolution {
  const graphInputConnections = (index.connectionsByInputNodeId.get(node.id) ?? []).filter(
    (connection) => connection.inputId === CALL_GRAPH_INPUT_ID,
  );
  if (graphInputConnections.length === 0) {
    return { status: 'missing', warnings: [] };
  }

  const warnings: string[] = [];
  const validGraphInputConnections = graphInputConnections.filter((connection) => {
    if (index.nodesById.has(connection.outputNodeId)) {
      return true;
    }

    warnings.push(
      `${formatNodeContext(index.graph, node)} is wired from missing node ${connection.outputNodeId}; that connection is ignored during reachability analysis.`,
    );
    return false;
  });

  if (validGraphInputConnections.length === 0) {
    return { status: 'missing', warnings };
  }

  if (validGraphInputConnections.length > 1) {
    warnings.push(
      `${formatNodeContext(index.graph, node)} has multiple graph inputs; runtime uses the first connection and ignores the rest.`,
    );
  }

  const sourceConnection = validGraphInputConnections[0]!;
  return {
    status: 'resolved',
    sourceConnection,
    sourceNode: index.nodesById.get(sourceConnection.outputNodeId)!,
    warnings,
  };
}

function createInvalidEdgeOrSkip(warnings: string[]): GraphDependencyEdge[] {
  return warnings.length > 0 ? [{ kind: 'invalid', targets: [], warnings }] : [];
}

function withWarnings(edge: GraphDependencyEdge, warnings: string[]): GraphDependencyEdge {
  return warnings.length > 0 ? { ...edge, warnings } : edge;
}

function isStaticGraphReferenceCarrier(node: ChartNode, outputId: PortId): node is ChartNode<'graphReference'> {
  return node.type === 'graphReference' && outputId === GRAPH_REFERENCE_OUTPUT_ID;
}

function formatNodeContext(graph: NodeGraph, node: ChartNode): string {
  const graphName = graph.metadata?.name ?? graph.metadata?.id ?? 'Unnamed Graph';
  return `Node "${node.title || node.type}" (${node.type}) in graph "${graphName}"`;
}

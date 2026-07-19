import {
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type PortId,
  type PluginLoadSpec,
  type Project,
  type UiGraph,
  type UiGraphActionComponent,
  type UiGraphId,
  resolveBuiltInPlugin,
} from '@valerypopoff/rivet2-core';

export type GraphReachabilityBucket = 'definitely-reachable' | 'dynamically-reachable' | 'unreachable';

export type GraphReachabilityAnalysisStatus = 'ready' | 'partial' | 'blocked';

export type GraphReachabilityBlockedReason = 'missing-main-graph' | 'invalid-main-graph';

export type GraphReachabilityUnsupportedReason = 'unregistered-node-type' | 'third-party-plugin-node';

export type GraphDependencyEdgeKind =
  | 'direct-static'
  | 'static-via-callgraph'
  | 'dynamic-via-callgraph'
  | 'cross-project'
  | 'invalid';

export type GraphReachabilityRegistry = {
  isRegistered(type: string): boolean;
  getPluginFor(type: string): { id: string } | undefined;
};

export type GraphReachabilityReport = {
  status: GraphReachabilityAnalysisStatus;
  blockedReason?: GraphReachabilityBlockedReason;
  definite: Set<GraphId>;
  dynamic: Set<GraphId>;
  unreachable: Set<GraphId>;
  unsupportedNodeTypes: string[];
  unsupportedReasons: GraphReachabilityUnsupportedReason[];
  warnings: string[];
};

type ReachabilityMode = 'definite' | 'dynamic';

type GraphDependencyEdge = {
  kind: GraphDependencyEdgeKind;
  targets: GraphId[];
  warnings?: string[];
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

type ReachabilityProject = Pick<Project, 'metadata' | 'graphs' | 'uiGraphs'>;

type GetGraphReachabilityReportOptions = {
  registry?: GraphReachabilityRegistry;
  builtInPluginIds?: Iterable<string>;
};

type ConnectionIndex = Record<NodeId, NodeConnection[]>;

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

const CALL_GRAPH_INPUT_ID = 'graph' as PortId;
const GRAPH_REFERENCE_OUTPUT_ID = 'graph' as PortId;
const DELEGATE_FUNCTION_CALL_INPUT_ID = 'function-call' as PortId;
const FUNCTION_CALL_OUTPUT_ID = 'function-call' as PortId;
const FUNCTION_CALLS_OUTPUT_ID = 'function-calls' as PortId;

export function resolveSupportedBuiltInPluginIds(pluginSpecs: PluginLoadSpec[] | undefined): Set<string> {
  const supportedIds = new Set<string>();

  for (const spec of pluginSpecs ?? []) {
    if (spec.type !== 'built-in') {
      continue;
    }

    supportedIds.add(spec.id);

    try {
      supportedIds.add(resolveBuiltInPlugin(spec.id).id);
    } catch {
      // Keep the explicit spec id even if the built-in plugin catalog has drifted.
    }
  }

  return supportedIds;
}

export function getGraphReachabilityReport(
  project: ReachabilityProject,
  options: GetGraphReachabilityReportOptions = {},
): GraphReachabilityReport {
  const warnings = new Set<string>();
  const unsupportedNodeTypes = new Set<string>();
  const unsupportedReasons = new Set<GraphReachabilityUnsupportedReason>();
  const graphEntries = Object.entries(project.graphs) as Array<[GraphId, NodeGraph]>;
  const allGraphIds = graphEntries.map(([graphId]) => graphId);
  const builtInPluginIds = new Set(options.builtInPluginIds ?? []);

  const definite = new Set<GraphId>();
  const dynamic = new Set<GraphId>();
  const queue: Array<{ graphId: GraphId; mode: ReachabilityMode }> = [];
  const strongestModeByGraph = new Map<GraphId, number>();

  const enqueue = (graphId: GraphId, mode: ReachabilityMode) => {
    if (!project.graphs[graphId]) {
      return;
    }

    const nextStrength = mode === 'definite' ? 2 : 1;
    const currentStrength = strongestModeByGraph.get(graphId) ?? 0;
    if (currentStrength >= nextStrength) {
      return;
    }

    strongestModeByGraph.set(graphId, nextStrength);
    queue.push({ graphId, mode });
  };

  const mainGraphId = project.metadata.mainGraphId;
  if (!mainGraphId) {
    warnings.add(
      'Reachability is rooted at project.metadata.mainGraphId. This project has no main graph, even though some runtime paths can fall back to a different graph.',
    );

    return buildBlockedReport({
      blockedReason: 'missing-main-graph',
      definite,
      dynamic,
      allGraphIds,
      warnings,
    });
  }

  if (!project.graphs[mainGraphId]) {
    warnings.add(`The configured main graph ${mainGraphId} does not exist in the current project.`);

    return buildBlockedReport({
      blockedReason: 'invalid-main-graph',
      definite,
      dynamic,
      allGraphIds,
      warnings,
    });
  }

  enqueue(mainGraphId, 'definite');
  for (const graphId of getUiGraphActionTargetGraphIds(project.uiGraphs)) {
    enqueue(graphId, 'definite');
  }
  for (const graphId of getDelegateToolTargetGraphIds(project, allGraphIds)) {
    enqueue(graphId, 'definite');
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const graph = project.graphs[current.graphId];
    if (!graph) {
      continue;
    }

    if (current.mode === 'definite') {
      definite.add(current.graphId);
      dynamic.delete(current.graphId);
    } else if (!definite.has(current.graphId)) {
      dynamic.add(current.graphId);
    }

    collectUnsupportedNodeTypes({
      builtInPluginIds,
      graph,
      registry: options.registry,
      unsupportedNodeTypes,
      unsupportedReasons,
    });

    const edges = collectGraphDependencyEdges({
      allGraphIds,
      graph,
      project,
    });

    for (const edge of edges) {
      edge.warnings?.forEach((warning) => warnings.add(warning));

      if (!isReachableGraphDependencyEdge(edge)) {
        continue;
      }

      const nextMode =
        current.mode === 'dynamic'
          ? 'dynamic'
          : edge.kind === 'direct-static' || edge.kind === 'static-via-callgraph'
            ? 'definite'
            : 'dynamic';

      for (const target of edge.targets) {
        enqueue(target, nextMode);
      }
    }
  }

  const unreachable = new Set(allGraphIds.filter((graphId) => !definite.has(graphId) && !dynamic.has(graphId)));

  return {
    status: unsupportedNodeTypes.size > 0 ? 'partial' : 'ready',
    definite,
    dynamic,
    unreachable,
    unsupportedNodeTypes: [...unsupportedNodeTypes].sort(),
    unsupportedReasons: [...unsupportedReasons].sort(),
    warnings: [...warnings],
  };
}

export function getGraphIdsReferencingGraph(project: ReachabilityProject, targetGraphId: GraphId): Set<GraphId> {
  const referencingGraphIds = new Set<GraphId>();
  const graphEntries = Object.entries(project.graphs) as Array<[GraphId, NodeGraph]>;
  const allGraphIds = graphEntries.map(([graphId]) => graphId);

  for (const [graphId, graph] of graphEntries) {
    if (graphId === targetGraphId) {
      continue;
    }

    const referencesTarget = collectGraphDependencyEdges({
      allGraphIds,
      graph,
      includeDelegateFunctionCallEdges: false,
      project,
    }).some((edge) => isReachableGraphDependencyEdge(edge) && edge.targets.includes(targetGraphId));

    if (referencesTarget) {
      referencingGraphIds.add(graphId);
    }
  }

  return referencingGraphIds;
}

/** Returns web apps with a Button or Chat action that directly targets a graph. */
export function getUiGraphIdsReferencingGraph(
  project: Pick<Project, 'uiGraphs'>,
  targetGraphId: GraphId,
): Set<UiGraphId> {
  const referencingUiGraphIds = new Set<UiGraphId>();

  for (const [uiGraphId, uiGraph] of Object.entries(project.uiGraphs ?? {}) as Array<[UiGraphId, UiGraph]>) {
    if (uiGraph.components.some((component) => getUiGraphActionTargetGraphId(component) === targetGraphId)) {
      referencingUiGraphIds.add(uiGraphId);
    }
  }

  return referencingUiGraphIds;
}

function getUiGraphActionTargetGraphIds(uiGraphs: Record<UiGraphId, UiGraph> | undefined): Set<GraphId> {
  const graphIds = new Set<GraphId>();

  for (const uiGraph of Object.values(uiGraphs ?? {})) {
    for (const component of uiGraph.components) {
      const graphId = getUiGraphActionTargetGraphId(component);
      if (graphId) {
        graphIds.add(graphId);
      }
    }
  }

  return graphIds;
}

function getDelegateToolTargetGraphIds(project: ReachabilityProject, allGraphIds: GraphId[]): Set<GraphId> {
  const graphIds = new Set<GraphId>();

  for (const graph of Object.values(project.graphs) as NodeGraph[]) {
    for (const edge of collectGraphDependencyEdges({
      allGraphIds,
      graph,
      onlyDelegateFunctionCallEdges: true,
      project,
    })) {
      if (isReachableGraphDependencyEdge(edge)) {
        edge.targets.forEach((graphId) => graphIds.add(graphId));
      }
    }
  }

  return graphIds;
}

function getUiGraphActionTargetGraphId(component: UiGraph['components'][number]): GraphId | undefined {
  return isUiGraphActionComponent(component) ? component.action.graphId : undefined;
}

function isUiGraphActionComponent(component: UiGraph['components'][number]): component is UiGraphActionComponent {
  return component.type === 'button' || component.type === 'chat';
}

function isReachableGraphDependencyEdge(edge: GraphDependencyEdge): boolean {
  return edge.kind !== 'cross-project' && edge.kind !== 'invalid';
}

function collectUnsupportedNodeTypes(options: {
  builtInPluginIds: ReadonlySet<string>;
  graph: NodeGraph;
  registry: GraphReachabilityRegistry | undefined;
  unsupportedNodeTypes: Set<string>;
  unsupportedReasons: Set<GraphReachabilityUnsupportedReason>;
}) {
  const { builtInPluginIds, graph, registry, unsupportedNodeTypes, unsupportedReasons } = options;

  if (!registry) {
    return;
  }

  for (const node of graph.nodes) {
    if (node.disabled) {
      continue;
    }

    if (!registry.isRegistered(node.type)) {
      unsupportedNodeTypes.add(node.type);
      unsupportedReasons.add('unregistered-node-type');
      continue;
    }

    const plugin = registry.getPluginFor(node.type);
    if (plugin && !builtInPluginIds.has(plugin.id)) {
      unsupportedNodeTypes.add(node.type);
      unsupportedReasons.add('third-party-plugin-node');
    }
  }
}

function buildBlockedReport(options: {
  blockedReason: GraphReachabilityBlockedReason;
  definite: Set<GraphId>;
  dynamic: Set<GraphId>;
  allGraphIds: GraphId[];
  warnings: ReadonlySet<string>;
}): GraphReachabilityReport {
  const { blockedReason, definite, dynamic, allGraphIds, warnings } = options;

  return {
    status: 'blocked',
    blockedReason,
    definite,
    dynamic,
    unreachable: new Set(allGraphIds),
    unsupportedNodeTypes: [],
    unsupportedReasons: [],
    warnings: [...warnings],
  };
}

function collectGraphDependencyEdges(options: {
  allGraphIds: GraphId[];
  graph: NodeGraph;
  includeDelegateFunctionCallEdges?: boolean;
  onlyDelegateFunctionCallEdges?: boolean;
  project: ReachabilityProject;
}): GraphDependencyEdge[] {
  const {
    allGraphIds,
    graph,
    includeDelegateFunctionCallEdges = true,
    onlyDelegateFunctionCallEdges = false,
    project,
  } = options;
  const nodesById = Object.fromEntries(graph.nodes.map((node) => [node.id, node])) as Record<NodeId, ChartNode>;
  const connectionsByInputNodeId = graph.connections.reduce((accumulator, connection) => {
    accumulator[connection.inputNodeId] ??= [];
    accumulator[connection.inputNodeId]!.push(connection);
    return accumulator;
  }, {} as ConnectionIndex);
  const connectionsByOutputNodeId = graph.connections.reduce((accumulator, connection) => {
    accumulator[connection.outputNodeId] ??= [];
    accumulator[connection.outputNodeId]!.push(connection);
    return accumulator;
  }, {} as ConnectionIndex);

  const edges: GraphDependencyEdge[] = [];

  const addStoredTarget = (
    kind: Extract<GraphDependencyEdgeKind, 'direct-static' | 'static-via-callgraph'>,
    options: {
      graphId: GraphId | undefined;
      description: string;
      node: ChartNode;
    },
  ) => {
    const { graphId, description, node } = options;
    if (!graphId) {
      edges.push({
        kind: 'invalid',
        targets: [],
        warnings: [`${formatNodeContext(graph, node)} has no configured ${description}.`],
      });
      return;
    }

    if (!project.graphs[graphId]) {
      edges.push({
        kind: 'invalid',
        targets: [],
        warnings: [`${formatNodeContext(graph, node)} references missing graph ${graphId} via ${description}.`],
      });
      return;
    }

    edges.push({ kind, targets: [graphId] });
  };

  for (const node of graph.nodes) {
    if (node.disabled) {
      continue;
    }

    if (onlyDelegateFunctionCallEdges && node.type !== 'delegateFunctionCall') {
      continue;
    }

    switch (node.type) {
      case 'subGraph': {
        const data = node.data as GraphReferenceNodeData;
        addStoredTarget('direct-static', { graphId: data.graphId, description: 'subgraph target', node });
        break;
      }

      case 'loopUntil': {
        const data = node.data as LoopUntilNodeData;
        addStoredTarget('direct-static', { graphId: data.targetGraph, description: 'loop target graph', node });
        break;
      }

      case 'cron': {
        const data = node.data as CronNodeData;
        const cronWarnings =
          data.useTargetGraphInput && data.targetGraph
            ? [
                `${formatNodeContext(graph, node)} enables Target Graph input, but the current Cron node implementation still executes the stored targetGraph.`,
              ]
            : undefined;

        addStoredTarget('direct-static', { graphId: data.targetGraph, description: 'cron target graph', node });

        if (cronWarnings) {
          const lastEdge = edges[edges.length - 1];
          if (lastEdge) {
            lastEdge.warnings = [...(lastEdge.warnings ?? []), ...cronWarnings];
          }
        }
        break;
      }

      case 'delegateFunctionCall': {
        if (!includeDelegateFunctionCallEdges) {
          break;
        }

        const data = node.data as DelegateFunctionCallNodeData;
        if (!hasActiveDelegateFunctionCallInput(node, connectionsByInputNodeId, nodesById)) {
          break;
        }

        if (data.autoDelegate) {
          const connectedToolNames = getConnectedStaticToolNames({
            connectionsByOutputNodeId,
            connectionsByInputNodeId,
            delegateNode: node,
            graph,
            nodesById,
          });

          let hasUnmatchedConnectedTool = false;
          for (const toolName of connectedToolNames) {
            // Match the runtime resolver exactly: prefer an exact graph-name match,
            // then fall back to the first graph whose name contains the tool name.
            const graphEntries = Object.entries(project.graphs) as Array<[GraphId, NodeGraph]>;
            const targetGraph =
              graphEntries.find(([, candidateGraph]) => candidateGraph.metadata?.name === toolName) ??
              graphEntries.find(([, candidateGraph]) => candidateGraph.metadata?.name?.includes(toolName));

            if (targetGraph) {
              edges.push({ kind: 'direct-static', targets: [targetGraph[0]] });
            } else {
              hasUnmatchedConnectedTool = true;
            }
          }

          if (data.unknownHandler && hasUnmatchedConnectedTool) {
            addStoredTarget('direct-static', {
              graphId: data.unknownHandler,
              description: 'delegate fallback graph',
              node,
            });
          }
        } else {
          for (const handler of data.handlers ?? []) {
            if (!handler.key) {
              continue;
            }

            addStoredTarget('direct-static', {
              graphId: handler.value,
              description: `delegate handler graph for "${handler.key || 'unknown'}"`,
              node,
            });
          }

          if (data.unknownHandler) {
            addStoredTarget('direct-static', {
              graphId: data.unknownHandler,
              description: 'delegate fallback graph',
              node,
            });
          }
        }
        break;
      }

      case 'openaiRunThread': {
        const data = node.data as RunThreadNodeData;
        for (const handler of data.toolCallHandlers ?? []) {
          addStoredTarget('direct-static', {
            graphId: handler.value,
            description: `run thread handler graph for "${handler.key || 'unknown'}"`,
            node,
          });
        }

        if (data.onMessageCreationSubgraphId) {
          addStoredTarget('direct-static', {
            graphId: data.onMessageCreationSubgraphId,
            description: 'run thread on-message graph',
            node,
          });
        }
        break;
      }

      case 'callGraph': {
        edges.push(
          ...collectCallGraphEdges({
            allGraphIds,
            connectionsByInputNodeId,
            graph,
            node,
            nodesById,
            project,
          }),
        );
        break;
      }

      case 'referencedGraphAlias': {
        edges.push({ kind: 'cross-project', targets: [] });
        break;
      }

      default:
        break;
    }
  }

  return edges;
}

function hasActiveDelegateFunctionCallInput(
  delegateNode: ChartNode,
  connectionsByInputNodeId: ConnectionIndex,
  nodesById: Record<NodeId, ChartNode>,
): boolean {
  const sourceConnection = getFirstValidInputConnection({
    connectionsByInputNodeId,
    inputId: DELEGATE_FUNCTION_CALL_INPUT_ID,
    inputNodeId: delegateNode.id,
    nodesById,
  });
  if (!sourceConnection) {
    return false;
  }

  const sourceNode = nodesById[sourceConnection.outputNodeId]!;
  return !sourceNode.disabled && isEnabledToolCallOutput(sourceNode, sourceConnection.outputId);
}

function getConnectedStaticToolNames(options: {
  connectionsByOutputNodeId: ConnectionIndex;
  connectionsByInputNodeId: ConnectionIndex;
  delegateNode: ChartNode;
  graph: NodeGraph;
  nodesById: Record<NodeId, ChartNode>;
}): Set<string> {
  const { connectionsByOutputNodeId, connectionsByInputNodeId, delegateNode, graph, nodesById } = options;
  const toolNames = new Set<string>();

  for (const node of graph.nodes) {
    if (node.disabled || node.type !== 'gptFunction') {
      continue;
    }

    const data = node.data as GptFunctionNodeData;
    const toolName = data.useNameInput ? '' : data.name?.trim() ?? '';
    if (!toolName) {
      continue;
    }

    if (
      hasActiveConnectionPathToDelegate({
        connectionsByOutputNodeId,
        connectionsByInputNodeId,
        delegateNode,
        sourceNodeId: node.id,
        nodesById,
      })
    ) {
      toolNames.add(toolName);
    }
  }

  return toolNames;
}

function hasActiveConnectionPathToDelegate(options: {
  connectionsByOutputNodeId: ConnectionIndex;
  connectionsByInputNodeId: ConnectionIndex;
  delegateNode: ChartNode;
  sourceNodeId: NodeId;
  nodesById: Record<NodeId, ChartNode>;
}): boolean {
  const { connectionsByOutputNodeId, connectionsByInputNodeId, delegateNode, sourceNodeId, nodesById } = options;
  const visited = new Set<NodeId>([sourceNodeId]);
  const queue = [sourceNodeId];

  while (queue.length > 0) {
    const currentNodeId = queue.shift()!;

    for (const connection of connectionsByOutputNodeId[currentNodeId] ?? []) {
      if (!isFirstValidInputConnection(connection, connectionsByInputNodeId, nodesById)) {
        continue;
      }

      if (connection.inputNodeId === delegateNode.id && connection.inputId === DELEGATE_FUNCTION_CALL_INPUT_ID) {
        return true;
      }

      const nextNode = nodesById[connection.inputNodeId];
      if (!nextNode || nextNode.disabled || visited.has(nextNode.id)) {
        continue;
      }

      visited.add(nextNode.id);
      queue.push(nextNode.id);
    }
  }

  return false;
}

function getFirstValidInputConnection(options: {
  connectionsByInputNodeId: ConnectionIndex;
  inputId: PortId;
  inputNodeId: NodeId;
  nodesById: Record<NodeId, ChartNode>;
}): NodeConnection | undefined {
  const { connectionsByInputNodeId, inputId, inputNodeId, nodesById } = options;
  return (connectionsByInputNodeId[inputNodeId] ?? []).find(
    (connection) => connection.inputId === inputId && nodesById[connection.outputNodeId] != null,
  );
}

function isFirstValidInputConnection(
  connection: NodeConnection,
  connectionsByInputNodeId: ConnectionIndex,
  nodesById: Record<NodeId, ChartNode>,
): boolean {
  return (
    getFirstValidInputConnection({
      connectionsByInputNodeId,
      inputId: connection.inputId,
      inputNodeId: connection.inputNodeId,
      nodesById,
    }) === connection
  );
}

function isEnabledToolCallOutput(node: ChartNode, outputId: PortId): boolean {
  if (node.type === 'llmChatV2') {
    const data = node.data as LLMChatV2NodeData;
    return data.useToolCalling === true && outputId === FUNCTION_CALLS_OUTPUT_ID;
  }

  if (node.type === 'chat') {
    const data = node.data as LegacyChatNodeData;
    return (
      data.enableFunctionUse === true &&
      outputId === (data.parallelFunctionCalling ? FUNCTION_CALLS_OUTPUT_ID : FUNCTION_CALL_OUTPUT_ID)
    );
  }

  // Other node types can intentionally produce a Delegate Tool Call-compatible object.
  return true;
}

function collectCallGraphEdges(options: {
  allGraphIds: GraphId[];
  connectionsByInputNodeId: ConnectionIndex;
  graph: NodeGraph;
  node: ChartNode;
  nodesById: Record<NodeId, ChartNode>;
  project: ReachabilityProject;
}): GraphDependencyEdge[] {
  const { allGraphIds, connectionsByInputNodeId, graph, node, nodesById, project } = options;
  const sourceResolution = resolveCallGraphSource({
    connectionsByInputNodeId,
    graph,
    node,
    nodesById,
  });

  if (sourceResolution.status === 'missing') {
    return createInvalidEdgeOrSkip(sourceResolution.warnings);
  }

  const { sourceConnection, sourceNode, warnings } = sourceResolution;

  if (sourceNode.disabled) {
    return createInvalidEdgeOrSkip(warnings);
  }

  if (isStaticGraphReferenceCarrier(sourceNode, sourceConnection.outputId)) {
    const data = sourceNode.data as GraphReferenceNodeData;
    if (data.useGraphIdOrNameInput) {
      return [withWarnings({ kind: 'dynamic-via-callgraph', targets: allGraphIds }, warnings)];
    }

    if (!data.graphId) {
      return [
        {
          kind: 'invalid',
          targets: [],
          warnings: [...warnings, `${formatNodeContext(graph, sourceNode)} has no configured graph reference target.`],
        },
      ];
    }

    if (!project.graphs[data.graphId]) {
      return [
        {
          kind: 'invalid',
          targets: [],
          warnings: [
            ...warnings,
            `${formatNodeContext(graph, sourceNode)} references missing graph ${data.graphId}; downstream Call Graph nodes cannot resolve it statically.`,
          ],
        },
      ];
    }

    return [withWarnings({ kind: 'static-via-callgraph', targets: [data.graphId] }, warnings)];
  }

  return [withWarnings({ kind: 'dynamic-via-callgraph', targets: allGraphIds }, warnings)];
}

function resolveCallGraphSource(options: {
  connectionsByInputNodeId: ConnectionIndex;
  graph: NodeGraph;
  node: ChartNode;
  nodesById: Record<NodeId, ChartNode>;
}): CallGraphSourceResolution {
  const { connectionsByInputNodeId, graph, node, nodesById } = options;
  const graphInputConnections = (connectionsByInputNodeId[node.id] ?? []).filter(
    (connection) => connection.inputId === CALL_GRAPH_INPUT_ID,
  );

  if (graphInputConnections.length === 0) {
    return { status: 'missing', warnings: [] };
  }

  const warnings: string[] = [];
  const validGraphInputConnections = graphInputConnections.filter((connection) => {
    if (nodesById[connection.outputNodeId]) {
      return true;
    }

    warnings.push(
      `${formatNodeContext(graph, node)} is wired from missing node ${connection.outputNodeId}; that connection is ignored during reachability analysis.`,
    );
    return false;
  });

  if (validGraphInputConnections.length === 0) {
    return { status: 'missing', warnings };
  }

  if (validGraphInputConnections.length > 1) {
    warnings.push(
      `${formatNodeContext(graph, node)} has multiple graph inputs; runtime uses the first connection and ignores the rest.`,
    );
  }

  const sourceConnection = validGraphInputConnections[0]!;

  return {
    status: 'resolved',
    sourceConnection,
    sourceNode: nodesById[sourceConnection.outputNodeId]!,
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

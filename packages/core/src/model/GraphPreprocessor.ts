import { values } from '../utils/typeSafety.js';
import { findStronglyConnectedComponents } from './CycleDetector.js';
import type { NodeRegistration } from './NodeRegistration.js';
import type { NodeGraph } from './NodeGraph.js';
import type { NodeConnection, NodeId, ChartNode, NodeInputDefinition, NodeOutputDefinition, PortId } from './NodeBase.js';
import type { NodeDefinitionContext, NodeImpl } from './NodeImpl.js';
import type { Project, ProjectId } from './Project.js';
import { resolveNodePrefabInstances } from './NodePrefabResolver.js';

export type GraphNodeDefinitions = Record<NodeId, { inputs: NodeInputDefinition[]; outputs: NodeOutputDefinition[] }>;
export type GraphPortConnectionMap = Record<NodeId, Partial<Record<PortId, NodeConnection>>>;
export type GraphPortConnectionsMap = Record<NodeId, Partial<Record<PortId, NodeConnection[]>>>;
export type GraphOutputNodeResult = {
  connections: NodeConnection[];
  connectionsToNodes: { connections: NodeConnection[]; node: ChartNode }[];
  nodes: ChartNode[];
};

export type GraphPreprocessorResult = {
  connections: Record<NodeId, NodeConnection[]>;
  definitions: GraphNodeDefinitions;
  nodeInstances: Record<NodeId, NodeImpl<ChartNode>>;
  nodesById: Record<NodeId, ChartNode>;
  nodesNotInCycle: ChartNode[];
  stronglyConnectedComponents: ChartNode[][];
};

export type GraphExecutionPlan = Omit<GraphPreprocessorResult, 'nodeInstances'> & {
  cycleIndexByNode: Record<NodeId, number>;
  graphNodes: ChartNode[];
  nodeIds: readonly NodeId[];
  inputConnectionByNodeAndPort: GraphPortConnectionMap;
  inputConnectionsByNode: Record<NodeId, NodeConnection[]>;
  inputNodesByNode: Record<NodeId, ChartNode[]>;
  missingRequiredInputsByNode: Record<NodeId, NodeInputDefinition[]>;
  outputConnectionsByNodeAndPort: GraphPortConnectionsMap;
  outputNodeResultsByNode: Record<NodeId, GraphOutputNodeResult>;
  startNodes: ChartNode[];
};

export type GraphPreprocessorExecutionPlanResult = GraphPreprocessorResult & GraphExecutionPlan;
export type GraphPreprocessedState = GraphPreprocessorResult | GraphPreprocessorExecutionPlanResult;

type GraphPreprocessorOptions = {
  buildExecutionPlan?: boolean;
  definitionContext?: NodeDefinitionContext;
  graph: NodeGraph;
  loadedProjects: Record<ProjectId, Project>;
  project: Project;
  registry: NodeRegistration<any, any>;
  warnOnInvalidGraph: boolean;
};

export function preprocessGraphState(
  options: GraphPreprocessorOptions & { buildExecutionPlan: true },
): GraphPreprocessorExecutionPlanResult;
export function preprocessGraphState(
  options: GraphPreprocessorOptions & { buildExecutionPlan?: false | undefined },
): GraphPreprocessorResult;
export function preprocessGraphState(
  options: GraphPreprocessorOptions,
): GraphPreprocessedState;
export function preprocessGraphState(options: GraphPreprocessorOptions): GraphPreprocessedState {
  const { buildExecutionPlan, definitionContext, graph, loadedProjects, project, registry, warnOnInvalidGraph } =
    options;
  const graphNodes = resolveNodePrefabInstances(project, graph.nodes);
  const effectiveDefinitionContext =
    definitionContext && graphNodes.some(usesGraphBoundaryDefinitionContext) ? definitionContext : undefined;
  const nodeInstances: Record<NodeId, NodeImpl<ChartNode>> = {};
  const nodesById: Record<NodeId, ChartNode> = {};
  const connections: Record<NodeId, NodeConnection[]> = {};

  for (const node of graphNodes) {
    nodeInstances[node.id] = registry.createDynamicImpl(node);
    nodesById[node.id] = node;
  }

  for (const connection of graph.connections) {
    if (!nodesById[connection.inputNodeId] || !nodesById[connection.outputNodeId]) {
      if (warnOnInvalidGraph) {
        if (!nodesById[connection.inputNodeId]) {
          console.warn(
            `Missing node ${connection.inputNodeId} in graph ${graph} (connection from ${
              nodesById[connection.outputNodeId]?.title
            })`,
          );
        } else {
          console.warn(
            `Missing node ${connection.outputNodeId} in graph ${graph} (connection to ${
              nodesById[connection.inputNodeId]?.title
            }) `,
          );
        }
      }

      continue;
    }

    connections[connection.inputNodeId] ??= [];
    connections[connection.outputNodeId] ??= [];
    connections[connection.inputNodeId]!.push(connection);
    connections[connection.outputNodeId]!.push(connection);
  }

  const definitions = loadInputOutputDefinitions({
    connections,
    loadedProjects,
    nodeInstances,
    nodesById,
    project,
    definitionContext: effectiveDefinitionContext,
    warnOnInvalidGraph,
  });

  const stronglyConnectedComponents = findStronglyConnectedComponents(graphNodes, (node) => {
    const nodeConnections = connections[node.id] ?? [];
    return nodeConnections
      .filter((connection) => connection.outputNodeId === node.id)
      .map((connection) => nodesById[connection.inputNodeId]!)
      .filter(Boolean);
  });
  const nodesNotInCycle = stronglyConnectedComponents.filter((component) => component.length === 1).flat();

  const result: GraphPreprocessorResult = {
    connections,
    definitions,
    nodeInstances,
    nodesById,
    nodesNotInCycle,
    stronglyConnectedComponents,
  };

  if (!buildExecutionPlan) {
    return result;
  }

  return {
    ...result,
    ...buildGraphExecutionPlan({
      connections,
      definitions,
      graphNodes,
      nodesById,
      stronglyConnectedComponents,
    }),
  };
}

export function isGraphExecutionPlan(
  preprocessedGraph: GraphPreprocessedState | GraphExecutionPlan,
): preprocessedGraph is GraphExecutionPlan {
  return 'inputConnectionByNodeAndPort' in preprocessedGraph;
}

export function toReusableGraphExecutionPlan(preprocessedGraph: GraphPreprocessorExecutionPlanResult): GraphExecutionPlan {
  return {
    connections: preprocessedGraph.connections,
    cycleIndexByNode: preprocessedGraph.cycleIndexByNode,
    definitions: preprocessedGraph.definitions,
    graphNodes: preprocessedGraph.graphNodes,
    nodeIds: preprocessedGraph.nodeIds,
    inputConnectionByNodeAndPort: preprocessedGraph.inputConnectionByNodeAndPort,
    inputConnectionsByNode: preprocessedGraph.inputConnectionsByNode,
    inputNodesByNode: preprocessedGraph.inputNodesByNode,
    missingRequiredInputsByNode: preprocessedGraph.missingRequiredInputsByNode,
    nodesById: preprocessedGraph.nodesById,
    nodesNotInCycle: preprocessedGraph.nodesNotInCycle,
    outputConnectionsByNodeAndPort: preprocessedGraph.outputConnectionsByNodeAndPort,
    outputNodeResultsByNode: preprocessedGraph.outputNodeResultsByNode,
    startNodes: preprocessedGraph.startNodes,
    stronglyConnectedComponents: preprocessedGraph.stronglyConnectedComponents,
  };
}

function loadInputOutputDefinitions(options: {
  connections: Record<NodeId, NodeConnection[]>;
  definitionContext?: NodeDefinitionContext;
  loadedProjects: Record<ProjectId, Project>;
  nodeInstances: Record<NodeId, NodeImpl<ChartNode>>;
  nodesById: Record<NodeId, ChartNode>;
  project: Project;
  warnOnInvalidGraph: boolean;
}): GraphNodeDefinitions {
  const { connections, definitionContext, loadedProjects, nodeInstances, nodesById, project, warnOnInvalidGraph } =
    options;
  const definitions: GraphNodeDefinitions = {};

  if (!definitionContext) {
    for (const node of values(nodesById)) {
      const connectionsForNode = connections[node.id] ?? [];
      const inputDefinitions = nodeInstances[node.id]!.getInputDefinitionsIncludingBuiltIn(
        connectionsForNode,
        nodesById,
        project,
        loadedProjects,
      );
      const outputDefinitions = nodeInstances[node.id]!.getOutputDefinitions(
        connectionsForNode,
        nodesById,
        project,
        loadedProjects,
      );

      definitions[node.id] = {
        inputs: inputDefinitions,
        outputs: outputDefinitions,
      };

      const invalidConnections = connectionsForNode.filter((connection) => {
        if (connection.inputNodeId === node.id) {
          const inputDefinition = inputDefinitions.find((definition) => definition.id === connection.inputId);

          if (!inputDefinition) {
            if (warnOnInvalidGraph) {
              const sourceNode = nodesById[connection.outputNodeId];
              console.warn(
                `[Warn] Invalid connection going from "${sourceNode?.title}".${connection.outputId} to "${node.title}".${connection.inputId}`,
              );
            }

            return true;
          }
        } else {
          const outputDefinition = outputDefinitions.find((definition) => definition.id === connection.outputId);

          if (!outputDefinition) {
            if (warnOnInvalidGraph) {
              const targetNode = nodesById[connection.inputNodeId];
              console.warn(
                `[Warn] Invalid connection going from "${node.title}".${connection.outputId} to "${targetNode?.title}".${connection.inputId}`,
              );
            }

            return true;
          }
        }

        return false;
      });

      if (invalidConnections.length > 0) {
        for (const invalidConnection of invalidConnections) {
          removeConnectionFromNode(connections, invalidConnection, invalidConnection.inputNodeId);

          if (invalidConnection.outputNodeId !== invalidConnection.inputNodeId) {
            removeConnectionFromNode(connections, invalidConnection, invalidConnection.outputNodeId);
          }
        }
      }
    }

    return definitions;
  }

  for (const node of values(nodesById)) {
    const connectionsForNode = connections[node.id] ?? [];
    const nodeDefinitionContext = usesGraphBoundaryDefinitionContext(node) ? definitionContext : undefined;
    const inputDefinitions = nodeDefinitionContext
      ? nodeInstances[node.id]!.getInputDefinitionsIncludingBuiltIn(
          connectionsForNode,
          nodesById,
          project,
          loadedProjects,
          nodeDefinitionContext,
        )
      : nodeInstances[node.id]!.getInputDefinitionsIncludingBuiltIn(
          connectionsForNode,
          nodesById,
          project,
          loadedProjects,
        );
    const outputDefinitions = nodeDefinitionContext
      ? nodeInstances[node.id]!.getOutputDefinitions(
          connectionsForNode,
          nodesById,
          project,
          loadedProjects,
          nodeDefinitionContext,
        )
      : nodeInstances[node.id]!.getOutputDefinitions(connectionsForNode, nodesById, project, loadedProjects);

    definitions[node.id] = {
      inputs: inputDefinitions,
      outputs: outputDefinitions,
    };

    removeInvalidDefinitionConnections(
      connections,
      connectionsForNode,
      inputDefinitions,
      node,
      nodesById,
      outputDefinitions,
      warnOnInvalidGraph,
    );
  }

  return definitions;
}

function removeInvalidDefinitionConnections(
  connections: Record<NodeId, NodeConnection[]>,
  connectionsForNode: NodeConnection[],
  inputDefinitions: NodeInputDefinition[],
  node: ChartNode,
  nodesById: Record<NodeId, ChartNode>,
  outputDefinitions: NodeOutputDefinition[],
  warnOnInvalidGraph: boolean,
): void {
  const invalidConnections = connectionsForNode.filter((connection) => {
    if (connection.inputNodeId === node.id) {
      const inputDefinition = inputDefinitions.find((definition) => definition.id === connection.inputId);

      if (!inputDefinition) {
        if (warnOnInvalidGraph) {
          const sourceNode = nodesById[connection.outputNodeId];
          console.warn(
            `[Warn] Invalid connection going from "${sourceNode?.title}".${connection.outputId} to "${node.title}".${connection.inputId}`,
          );
        }

        return true;
      }
    } else {
      const outputDefinition = outputDefinitions.find((definition) => definition.id === connection.outputId);

      if (!outputDefinition) {
        if (warnOnInvalidGraph) {
          const targetNode = nodesById[connection.inputNodeId];
          console.warn(
            `[Warn] Invalid connection going from "${node.title}".${connection.outputId} to "${targetNode?.title}".${connection.inputId}`,
          );
        }

        return true;
      }
    }

    return false;
  });

  if (invalidConnections.length > 0) {
    for (const invalidConnection of invalidConnections) {
      removeConnectionFromNode(connections, invalidConnection, invalidConnection.inputNodeId);

      if (invalidConnection.outputNodeId !== invalidConnection.inputNodeId) {
        removeConnectionFromNode(connections, invalidConnection, invalidConnection.outputNodeId);
      }
    }
  }
}

function usesGraphBoundaryDefinitionContext(node: ChartNode): boolean {
  return node.type === 'subGraph' || node.type === 'referencedGraphAlias' || node.type === 'loopUntil';
}

function removeConnectionFromNode(
  connections: Record<NodeId, NodeConnection[]>,
  connection: NodeConnection,
  nodeId: NodeId,
): void {
  const nodeConnections = connections[nodeId];
  if (!nodeConnections) {
    return;
  }

  const invalidConnectionIndex = nodeConnections.indexOf(connection);
  if (invalidConnectionIndex !== -1) {
    nodeConnections.splice(invalidConnectionIndex, 1);
  }
}

function buildGraphExecutionPlan(options: {
  connections: Record<NodeId, NodeConnection[]>;
  definitions: GraphNodeDefinitions;
  graphNodes: ChartNode[];
  nodesById: Record<NodeId, ChartNode>;
  stronglyConnectedComponents: ChartNode[][];
}): Omit<
  GraphExecutionPlan,
  | 'connections'
  | 'definitions'
  | 'nodesById'
  | 'nodesNotInCycle'
  | 'stronglyConnectedComponents'
> {
  const { connections, definitions, graphNodes, nodesById, stronglyConnectedComponents } = options;
  const cycleIndexByNode: Record<NodeId, number> = {};
  const inputConnectionByNodeAndPort: GraphPortConnectionMap = {};
  const inputConnectionsByNode: Record<NodeId, NodeConnection[]> = {};
  const inputNodesByNode: Record<NodeId, ChartNode[]> = {};
  const missingRequiredInputsByNode: Record<NodeId, NodeInputDefinition[]> = {};
  const outputConnectionsByNodeAndPort: GraphPortConnectionsMap = {};
  const outputNodeResultsByNode: Record<NodeId, GraphOutputNodeResult> = {};

  stronglyConnectedComponents.forEach((component, index) => {
    for (const node of component) {
      cycleIndexByNode[node.id] = index;
    }
  });

  for (const node of graphNodes) {
    const nodeConnections = connections[node.id] ?? [];
    const inputDefinitions = definitions[node.id]?.inputs ?? [];
    const outputDefinitions = definitions[node.id]?.outputs ?? [];
    const validInputIds = new Set(inputDefinitions.map((definition) => definition.id));
    const validOutputIds = new Set(outputDefinitions.map((definition) => definition.id));

    const inputConnections = nodeConnections.filter(
      (connection) => connection.inputNodeId === node.id && validInputIds.has(connection.inputId),
    );
    const outputConnections = nodeConnections.filter(
      (connection) => connection.outputNodeId === node.id && validOutputIds.has(connection.outputId),
    );

    inputConnectionsByNode[node.id] = inputConnections;
    outputConnectionsByNodeAndPort[node.id] = {};

    inputConnectionByNodeAndPort[node.id] = {};
    for (const connection of inputConnections) {
      inputConnectionByNodeAndPort[node.id]![connection.inputId] ??= connection;
    }
    for (const connection of outputConnections) {
      outputConnectionsByNodeAndPort[node.id]![connection.outputId] ??= [];
      outputConnectionsByNodeAndPort[node.id]![connection.outputId]!.push(connection);
    }

    inputNodesByNode[node.id] = inputConnections
      .map((connection) => nodesById[connection.outputNodeId])
      .filter((inputNode): inputNode is ChartNode => inputNode != null);

    missingRequiredInputsByNode[node.id] = inputDefinitions.filter(
      (input) => input.required && inputConnectionByNodeAndPort[node.id]?.[input.id] == null,
    );

    const outputNodes: ChartNode[] = [];
    const seenOutputNodeIds = new Set<NodeId>();
    const outputConnectionsByNode = new Map<NodeId, NodeConnection[]>();
    for (const connection of outputConnections) {
      const outputNode = nodesById[connection.inputNodeId];
      if (!outputNode) {
        continue;
      }

      if (!seenOutputNodeIds.has(outputNode.id)) {
        outputNodes.push(outputNode);
        seenOutputNodeIds.add(outputNode.id);
      }

      const nodeConnections = outputConnectionsByNode.get(outputNode.id);
      if (nodeConnections) {
        nodeConnections.push(connection);
      } else {
        outputConnectionsByNode.set(outputNode.id, [connection]);
      }
    }

    outputNodeResultsByNode[node.id] = {
      connections: outputConnections,
      connectionsToNodes: outputNodes.map((outputNode) => ({
        connections: outputConnectionsByNode.get(outputNode.id) ?? [],
        node: outputNode,
      })),
      nodes: outputNodes,
    };
  }

  return {
    cycleIndexByNode,
    graphNodes,
    nodeIds: graphNodes.map((node) => node.id),
    inputConnectionByNodeAndPort,
    inputConnectionsByNode,
    inputNodesByNode,
    missingRequiredInputsByNode,
    outputConnectionsByNodeAndPort,
    outputNodeResultsByNode,
    startNodes: graphNodes.filter((node) => outputNodeResultsByNode[node.id]?.nodes.length === 0),
  };
}

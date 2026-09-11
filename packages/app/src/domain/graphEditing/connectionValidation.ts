import {
  compileDataBusTopology,
  isDataBusTopologyNode,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type NodeRegistration,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';

type NodePortIds =
  | {
      inputPortIds: Set<PortId>;
      outputPortIds: Set<PortId>;
    }
  | undefined;

export type AsyncBranchTopologyViolation = {
  kind:
    | 'cycle'
    | 'externalInput'
    | 'graphOutput'
    | 'multipleStops'
    | 'invalidWatchInput'
    | 'missingSource'
    | 'splitRun'
    | 'disabledNode'
    | 'nestedWatch'
    | 'asyncBranch';
  triggerNodeId: NodeId;
  nodeId: NodeId;
  externalNodeId?: NodeId;
  nestedNodeId?: NodeId;
  nestedGraphId?: GraphId;
  message: string;
};

function getConnectionsByNodeId(connections: readonly NodeConnection[]): Record<NodeId, NodeConnection[]> {
  const connectionsByNodeId: Record<NodeId, NodeConnection[]> = {};

  for (const connection of connections) {
    connectionsByNodeId[connection.inputNodeId] ??= [];
    connectionsByNodeId[connection.inputNodeId]!.push(connection);

    connectionsByNodeId[connection.outputNodeId] ??= [];
    connectionsByNodeId[connection.outputNodeId]!.push(connection);
  }

  return connectionsByNodeId;
}

function resolveSubGraphPortIds({
  node,
  nodesById,
  connectionsByNodeId,
  project,
  referencedProjects,
  projectNodeRegistry,
}: {
  node: ChartNode;
  nodesById: Record<NodeId, ChartNode>;
  connectionsByNodeId: Record<NodeId, NodeConnection[]>;
  project: Project;
  referencedProjects: Record<ProjectId, Project>;
  projectNodeRegistry: NodeRegistration<any, any>;
}): NodePortIds {
  if (node.type !== 'subGraph') {
    return undefined;
  }

  try {
    const instance = projectNodeRegistry.createDynamicImpl(node);
    const nodeConnections = connectionsByNodeId[node.id] ?? [];

    return {
      inputPortIds: new Set(
        instance
          .getInputDefinitionsIncludingBuiltIn(nodeConnections, nodesById, project, referencedProjects)
          .map((definition) => definition.id),
      ),
      outputPortIds: new Set(
        instance
          .getOutputDefinitions(nodeConnections, nodesById, project, referencedProjects)
          .map((definition) => definition.id),
      ),
    };
  } catch {
    return undefined;
  }
}

function isSubGraphConnectionValid(
  connection: NodeConnection,
  outputPortIds: NodePortIds,
  inputPortIds: NodePortIds,
): boolean {
  const outputIsValid = outputPortIds ? outputPortIds.outputPortIds.has(connection.outputId) : true;
  const inputIsValid = inputPortIds ? inputPortIds.inputPortIds.has(connection.inputId) : true;

  return outputIsValid && inputIsValid;
}

function getSubGraphId(node: ChartNode): GraphId | undefined {
  if (node.type !== 'subGraph') {
    return undefined;
  }

  const graphId = (node.data as { graphId?: unknown }).graphId;
  return typeof graphId === 'string' ? (graphId as GraphId) : undefined;
}

function findReachableAsyncBranchInSubGraph(
  node: ChartNode,
  project: Project | undefined,
  visitedGraphIds: Set<GraphId> = new Set(),
): { graphId: GraphId; node: ChartNode } | undefined {
  const graphId = getSubGraphId(node);
  if (!project || !graphId || visitedGraphIds.has(graphId)) {
    return undefined;
  }

  const graph = project.graphs[graphId];
  if (!graph) {
    return undefined;
  }
  visitedGraphIds.add(graphId);

  const nodesById = Object.fromEntries(graph.nodes.map((childNode) => [childNode.id, childNode]));
  const outgoingByNodeId = new Map<NodeId, NodeId[]>();
  for (const connection of graph.connections) {
    const outgoingNodeIds = outgoingByNodeId.get(connection.outputNodeId) ?? [];
    outgoingNodeIds.push(connection.inputNodeId);
    outgoingByNodeId.set(connection.outputNodeId, outgoingNodeIds);
  }

  const hasRunnableAsyncDescendant = (triggerNodeId: NodeId): boolean => {
    const pendingNodeIds = [...(outgoingByNodeId.get(triggerNodeId) ?? [])];
    const visitedNodeIds = new Set<NodeId>();
    while (pendingNodeIds.length > 0) {
      const nodeId = pendingNodeIds.pop()!;
      if (visitedNodeIds.has(nodeId)) {
        continue;
      }
      visitedNodeIds.add(nodeId);

      const descendant = nodesById[nodeId];
      if (!descendant || descendant.disabled) {
        continue;
      }
      return true;
    }
    return false;
  };

  for (const childNode of graph.nodes) {
    if (childNode.disabled) {
      continue;
    }
    if (childNode.type === 'startBackgroundBranch' && hasRunnableAsyncDescendant(childNode.id)) {
      return { graphId, node: childNode };
    }

    const nestedAsyncBranch = findReachableAsyncBranchInSubGraph(childNode, project, visitedGraphIds);
    if (nestedAsyncBranch) {
      return nestedAsyncBranch;
    }
  }

  return undefined;
}

/**
 * A Watch owns a bounded scheduler. A nested Watch would create a second
 * scheduler whose retained evidence and queue limits escape the outer Watch,
 * so reject it even when the nested node is reached through one or more
 * Subgraphs.
 */
function findReachableStreamingWatchInSubGraph(
  node: ChartNode,
  project: Project | undefined,
  visitedGraphIds: Set<GraphId> = new Set(),
): { graphId: GraphId; node: ChartNode } | undefined {
  const graphId = getSubGraphId(node);
  if (!project || !graphId || visitedGraphIds.has(graphId)) {
    return undefined;
  }

  const graph = project.graphs[graphId];
  if (!graph) {
    return undefined;
  }
  visitedGraphIds.add(graphId);

  for (const childNode of graph.nodes) {
    if (childNode.disabled) {
      continue;
    }
    if (childNode.type === 'watchStreamingOutput') {
      return { graphId, node: childNode };
    }

    const nestedWatch = findReachableStreamingWatchInSubGraph(childNode, project, visitedGraphIds);
    if (nestedWatch) {
      return nestedWatch;
    }
  }

  return undefined;
}

function withCurrentGraphTopology(
  project: Project | undefined,
  graphId: GraphId | undefined,
  nodesById: Record<NodeId, ChartNode>,
  connections: readonly NodeConnection[],
): Project | undefined {
  const graph = graphId ? project?.graphs[graphId] : undefined;
  if (!project || !graph || !graphId) {
    return project;
  }

  return {
    ...project,
    graphs: {
      ...project.graphs,
      [graphId]: {
        ...graph,
        connections: [...connections],
        nodes: Object.values(nodesById),
      },
    },
  };
}

export function filterValidSubGraphConnections({
  connections,
  nodesById,
  project,
  referencedProjects,
  projectNodeRegistry,
}: {
  connections: readonly NodeConnection[];
  nodesById: Record<NodeId, ChartNode>;
  project: Project;
  referencedProjects: Record<ProjectId, Project>;
  projectNodeRegistry: NodeRegistration<any, any>;
}): NodeConnection[] {
  const connectionsByNodeId = getConnectionsByNodeId(connections);
  const portIdsByNodeId = new Map<NodeId, NodePortIds>();

  const getPortIds = (node: ChartNode) => {
    if (!portIdsByNodeId.has(node.id)) {
      portIdsByNodeId.set(
        node.id,
        resolveSubGraphPortIds({
          node,
          nodesById,
          connectionsByNodeId,
          project,
          referencedProjects,
          projectNodeRegistry,
        }),
      );
    }

    return portIdsByNodeId.get(node.id);
  };

  const filteredConnections = connections.filter((connection) => {
    const outputNode = nodesById[connection.outputNodeId];
    const inputNode = nodesById[connection.inputNodeId];

    if (!outputNode || !inputNode) {
      return true;
    }

    const outputPortIds = getPortIds(outputNode);
    const inputPortIds = getPortIds(inputNode);

    if (!outputPortIds && !inputPortIds) {
      return true;
    }

    return isSubGraphConnectionValid(connection, outputPortIds, inputPortIds);
  });

  return filteredConnections.length === connections.length ? (connections as NodeConnection[]) : filteredConnections;
}

/**
 * Returns the first topology violation in an enabled scheduler-boundary subtree.
 *
 * Start Async Branch remains root-owned side-effect work. Watch Streaming Output
 * has one explicit Stop boundary that may rejoin normal execution. Both must
 * keep pre-boundary inputs closed. Keep this check independent from port
 * definitions so it can validate a proposed connection during a wire drag.
 */
export function getAsyncBranchTopologyViolation({
  connections,
  graphId,
  project,
  nodesById,
}: {
  connections: readonly NodeConnection[];
  graphId?: GraphId;
  project?: Project;
  nodesById: Record<NodeId, ChartNode>;
}): AsyncBranchTopologyViolation | undefined {
  // A Data Bus is a topology-only relay. Analyze its compiled connections so
  // separate channels do not become one raw-connection hub while validating an
  // async subtree. If a hand-edited bus is itself invalid, its dedicated
  // validation/preprocessing error remains the actionable diagnosis. Exclude
  // bus edges from this secondary check instead of falling back to the raw hub
  // topology and inventing a false cross-channel async path.
  const graphNodes = Object.values(nodesById);
  let topologyConnections: readonly NodeConnection[];
  try {
    topologyConnections = compileDataBusTopology({
      connections,
      graphNodes,
    }).connections;
  } catch {
    topologyConnections = connections.filter(
      (connection) =>
        !isDataBusTopologyNode(nodesById[connection.inputNodeId]) &&
        !isDataBusTopologyNode(nodesById[connection.outputNodeId]),
    );
  }

  const outgoingByNodeId = new Map<NodeId, NodeId[]>();
  const incomingByNodeId = new Map<NodeId, NodeConnection[]>();
  const topologyProject = withCurrentGraphTopology(project, graphId, nodesById, connections);

  for (const connection of topologyConnections) {
    const outgoingNodeIds = outgoingByNodeId.get(connection.outputNodeId) ?? [];
    outgoingNodeIds.push(connection.inputNodeId);
    outgoingByNodeId.set(connection.outputNodeId, outgoingNodeIds);

    const incomingConnections = incomingByNodeId.get(connection.inputNodeId) ?? [];
    incomingConnections.push(connection);
    incomingByNodeId.set(connection.inputNodeId, incomingConnections);
  }

  for (const triggerNode of Object.values(nodesById)) {
    if (triggerNode.type !== 'startBackgroundBranch' || triggerNode.disabled) {
      continue;
    }

    const visitedNodeIds = new Set<NodeId>();
    const branchNodeIds = new Set<NodeId>();
    const pendingNodeIds = [...(outgoingByNodeId.get(triggerNode.id) ?? [])];

    while (pendingNodeIds.length > 0) {
      const nodeId = pendingNodeIds.pop()!;
      if (nodeId === triggerNode.id) {
        return {
          kind: 'cycle',
          triggerNodeId: triggerNode.id,
          nodeId,
          message: `Start Async Branch "${triggerNode.title}" cannot be part of a cycle or reconnect to its own inputs.`,
        };
      }
      if (visitedNodeIds.has(nodeId)) {
        continue;
      }
      visitedNodeIds.add(nodeId);

      const node = nodesById[nodeId];
      if (!node || node.disabled) {
        continue;
      }

      if (node.type === 'graphOutput') {
        return {
          kind: 'graphOutput',
          triggerNodeId: triggerNode.id,
          nodeId: node.id,
          message:
            `Start Async Branch "${triggerNode.title}" cannot contain Graph Output node "${node.title}". ` +
            'Async branches are side-effect-only.',
        };
      }

      branchNodeIds.add(nodeId);
      pendingNodeIds.push(...(outgoingByNodeId.get(nodeId) ?? []));
    }

    for (const nodeId of branchNodeIds) {
      const externalInput = (incomingByNodeId.get(nodeId) ?? []).find(
        (connection) => connection.outputNodeId !== triggerNode.id && !branchNodeIds.has(connection.outputNodeId),
      );
      if (!externalInput) {
        continue;
      }

      const node = nodesById[nodeId]!;
      const externalNode = nodesById[externalInput.outputNodeId];
      return {
        kind: 'externalInput',
        triggerNodeId: triggerNode.id,
        nodeId,
        externalNodeId: externalInput.outputNodeId,
        message:
          `Start Async Branch "${triggerNode.title}" cannot run "${node.title}" because it also depends on ` +
          `"${externalNode?.title ?? externalInput.outputNodeId}" outside the async branch. ` +
          'Assemble all required values before the async trigger.',
      };
    }
  }

  for (const watchNode of Object.values(nodesById)) {
    if (watchNode.type !== 'watchStreamingOutput' || watchNode.disabled) {
      continue;
    }

    const watchInputs = incomingByNodeId.get(watchNode.id) ?? [];
    if (watchInputs.length === 0) {
      // A Watch node is often added before its producer. Treat that incomplete
      // canvas state as dormant rather than blocking unrelated wire edits.
      continue;
    }
    if (watchInputs.length !== 1 || watchInputs[0]?.inputId !== ('stream' as PortId)) {
      return {
        kind: 'invalidWatchInput',
        triggerNodeId: watchNode.id,
        nodeId: watchNode.id,
        message: `Watch Streaming Output "${watchNode.title}" must have exactly one Streaming Output input connection.`,
      };
    }

    const sourceNode = nodesById[watchInputs[0]!.outputNodeId];
    if (!sourceNode || sourceNode.disabled) {
      return {
        kind: 'missingSource',
        triggerNodeId: watchNode.id,
        nodeId: watchInputs[0]!.outputNodeId,
        message: `Watch Streaming Output "${watchNode.title}" has no runnable streaming source.`,
      };
    }
    if (sourceNode.isSplitRun) {
      return {
        kind: 'splitRun',
        triggerNodeId: watchNode.id,
        nodeId: sourceNode.id,
        message:
          `Watch Streaming Output "${watchNode.title}" cannot watch split-run node "${sourceNode.title}". ` +
          'Assemble a single streaming value before the watch boundary.',
      };
    }

    const branchNodeIds = new Set<NodeId>();
    const pendingNodeIds = [...(outgoingByNodeId.get(watchNode.id) ?? [])];
    let stopNodeId: NodeId | undefined;
    while (pendingNodeIds.length > 0) {
      const nodeId = pendingNodeIds.pop()!;
      if (nodeId === watchNode.id) {
        return {
          kind: 'cycle',
          triggerNodeId: watchNode.id,
          nodeId,
          message: `Watch Streaming Output "${watchNode.title}" cannot reconnect to itself.`,
        };
      }
      if (branchNodeIds.has(nodeId)) {
        continue;
      }
      const node = nodesById[nodeId];
      if (!node) {
        continue;
      }
      if (node.disabled) {
        return {
          kind: 'disabledNode',
          triggerNodeId: watchNode.id,
          nodeId,
          message: `Watch Streaming Output "${watchNode.title}" cannot include disabled node "${node.title}".`,
        };
      }
      if (node.type === 'watchStreamingOutput') {
        return {
          kind: 'nestedWatch',
          triggerNodeId: watchNode.id,
          nodeId,
          message: `Watch Streaming Output "${watchNode.title}" cannot contain another Watch Streaming Output node.`,
        };
      }
      if (node.type === 'startBackgroundBranch') {
        return {
          kind: 'asyncBranch',
          triggerNodeId: watchNode.id,
          nodeId,
          message:
            `Watch Streaming Output "${watchNode.title}" cannot contain Start Async Branch. ` +
            'Keep watched work in the bounded watch branch.',
        };
      }
      if (node.type === 'subGraph') {
        const nestedAsyncBranch = findReachableAsyncBranchInSubGraph(node, topologyProject);
        if (nestedAsyncBranch) {
          return {
            kind: 'asyncBranch',
            triggerNodeId: watchNode.id,
            nodeId: node.id,
            nestedGraphId: nestedAsyncBranch.graphId,
            nestedNodeId: nestedAsyncBranch.node.id,
            message:
              `Start Async Branch "${nestedAsyncBranch.node.title}" cannot run inside Watch Streaming Output "${watchNode.title}" ` +
              `through Subgraph "${node.title}". A Watch invocation must keep all work within the Watch scheduler. ` +
              'Move Start Async Branch after Stop Watching Streaming Output, or run the work directly inside the watched branch.',
          };
        }
        const nestedWatch = findReachableStreamingWatchInSubGraph(node, topologyProject);
        if (nestedWatch) {
          return {
            kind: 'nestedWatch',
            triggerNodeId: watchNode.id,
            nodeId: node.id,
            nestedGraphId: nestedWatch.graphId,
            nestedNodeId: nestedWatch.node.id,
            message:
              `Watch Streaming Output "${nestedWatch.node.title}" cannot run inside Watch Streaming Output "${watchNode.title}" ` +
              `through Subgraph "${node.title}". A Watch branch cannot contain another Watch.`,
          };
        }
      }
      if (node.type === 'graphOutput') {
        return {
          kind: 'graphOutput',
          triggerNodeId: watchNode.id,
          nodeId,
          message:
            `Watch Streaming Output "${watchNode.title}" must reach Stop Watching Streaming Output before ` +
            `Graph Output "${node.title}".`,
        };
      }

      branchNodeIds.add(nodeId);
      if (node.type === 'stopWatchingStreamingOutput') {
        if (stopNodeId && stopNodeId !== nodeId) {
          return {
            kind: 'multipleStops',
            triggerNodeId: watchNode.id,
            nodeId,
            message: `Watch Streaming Output "${watchNode.title}" must have one Stop Watching Streaming Output boundary.`,
          };
        }
        stopNodeId = nodeId;
        continue;
      }

      pendingNodeIds.push(...(outgoingByNodeId.get(nodeId) ?? []));
    }

    for (const nodeId of branchNodeIds) {
      const externalInput = (incomingByNodeId.get(nodeId) ?? []).find(
        (connection) => connection.outputNodeId !== watchNode.id && !branchNodeIds.has(connection.outputNodeId),
      );
      if (!externalInput) {
        continue;
      }
      const node = nodesById[nodeId]!;
      const externalNode = nodesById[externalInput.outputNodeId];
      return {
        kind: 'externalInput',
        triggerNodeId: watchNode.id,
        nodeId,
        externalNodeId: externalInput.outputNodeId,
        message:
          `Watch Streaming Output "${watchNode.title}" cannot run "${node.title}" because it also depends on ` +
          `"${externalNode?.title ?? externalInput.outputNodeId}" outside the watch branch. ` +
          'Assemble every required value inside the watch boundary.',
      };
    }

    if (stopNodeId) {
      const reentry = (outgoingByNodeId.get(stopNodeId) ?? []).find(
        (nodeId) => nodeId === watchNode.id || branchNodeIds.has(nodeId),
      );
      if (reentry) {
        const stopNode = nodesById[stopNodeId]!;
        return {
          kind: 'cycle',
          triggerNodeId: watchNode.id,
          nodeId: stopNodeId,
          message:
            `Stop Watching Streaming Output "${stopNode.title}" cannot reconnect to its own Watch Streaming Output branch. ` +
            'Connect it only to ordinary downstream execution.',
        };
      }
    }
  }

  // A malformed topology can also be introduced while editing a nested
  // Subgraph after its parent was already wired to Watch. Recheck Watch roots
  // in sibling graphs against this graph's proposed node/connection snapshot,
  // but only surface a violation that actually belongs to the graph being
  // edited. Core remains the authority when project context is unavailable.
  if (topologyProject && graphId) {
    for (const [candidateGraphId, candidateGraph] of Object.entries(topologyProject.graphs)) {
      if (candidateGraphId === graphId) {
        continue;
      }

      const ancestorViolation = getAsyncBranchTopologyViolation({
        connections: candidateGraph.connections,
        nodesById: Object.fromEntries(candidateGraph.nodes.map((node) => [node.id, node])),
        project: topologyProject,
      });
      if (ancestorViolation?.nestedGraphId === graphId && ancestorViolation.nestedNodeId) {
        return {
          ...ancestorViolation,
          nodeId: ancestorViolation.nestedNodeId,
        };
      }
    }
  }

  return undefined;
}

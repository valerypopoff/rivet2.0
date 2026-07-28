import {
  compileDataBusTopology,
  isDataBusTopologyNode,
  type ChartNode,
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
  kind: 'cycle' | 'externalInput' | 'graphOutput';
  triggerNodeId: NodeId;
  nodeId: NodeId;
  externalNodeId?: NodeId;
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
 * Returns the first topology violation in an enabled Start Async Branch subtree.
 *
 * Async branches are root-owned side-effect work and must not participate in the
 * graph's output boundary, loop back through their trigger, or depend on input
 * from outside the subtree. Keep this check independent from port definitions so
 * it can validate a proposed connection during a wire drag.
 */
export function getAsyncBranchTopologyViolation({
  connections,
  nodesById,
}: {
  connections: readonly NodeConnection[];
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

  return undefined;
}

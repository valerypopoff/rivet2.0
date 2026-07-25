import type { NodeOutputs } from './NodeIO.js';
import type { ChartNode, NodeConnection, NodeId, PortId } from './NodeBase.js';
import type { NodeGraph } from './NodeGraph.js';

export type ToolCallContinuationAsyncBranchPlan = {
  graph: NodeGraph;
  nodeIds: ReadonlySet<NodeId>;
};

export type ToolCallContinuationBranchPlan = {
  graph: NodeGraph;
  preloadedOutputs: ReadonlyMap<NodeId, NodeOutputs>;
};

export type ToolCallContinuationBranchPlannerState = {
  erroredNodeIds: ReadonlySet<NodeId>;
  nodeOutputs: ReadonlyMap<NodeId, NodeOutputs>;
  runToRelevantNodeIds: ReadonlySet<NodeId> | undefined;
  visitedNodeIds: ReadonlySet<NodeId>;
};

export type ToolCallContinuationBranchPlanRequest = {
  activeOutputPortIds: ReadonlySet<PortId>;
  availableNodeOutputs: ReadonlyMap<NodeId, NodeOutputs>;
  excludedNodeIds: ReadonlySet<NodeId>;
  failOnUnsafeReadyNode?: boolean;
  sourceNode: ChartNode;
  sourceOutputs: NodeOutputs;
  state: ToolCallContinuationBranchPlannerState;
};

export type ToolCallContinuationBranchPlanner = {
  readonly unsafeNodeIds: ReadonlySet<NodeId>;
  plan(request: ToolCallContinuationBranchPlanRequest): ToolCallContinuationBranchPlan | undefined;
};

/**
 * Pure continuation-branch topology. Runtime state is supplied for each plan
 * so a final branch can see outputs that completed while an early branch ran.
 */
export function createToolCallContinuationBranchPlanner(options: {
  asyncBranchPlansByTriggerNodeId: ReadonlyMap<NodeId, ToolCallContinuationAsyncBranchPlan>;
  attachedNodeDataByNodeId: ReadonlyMap<NodeId, Readonly<Record<string, unknown>>>;
  effectiveConnections: readonly NodeConnection[];
  graph: NodeGraph;
  isDefinitionValidConnection(connection: NodeConnection): boolean;
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
  stronglyConnectedComponents: readonly (readonly ChartNode[])[];
}): ToolCallContinuationBranchPlanner {
  const outgoingConnectionsByNode = new Map<NodeId, NodeConnection[]>();
  const incomingConnectionsByNode = new Map<NodeId, NodeConnection[]>();
  for (const connection of options.effectiveConnections) {
    const outgoing = outgoingConnectionsByNode.get(connection.outputNodeId) ?? [];
    outgoing.push(connection);
    outgoingConnectionsByNode.set(connection.outputNodeId, outgoing);

    const incoming = incomingConnectionsByNode.get(connection.inputNodeId) ?? [];
    incoming.push(connection);
    incomingConnectionsByNode.set(connection.inputNodeId, incoming);
  }

  const unsafeNodeIds = getUnsafeNodeIds(options);

  return {
    unsafeNodeIds,
    plan: ({
      activeOutputPortIds,
      availableNodeOutputs,
      excludedNodeIds,
      failOnUnsafeReadyNode = false,
      sourceNode,
      sourceOutputs,
      state,
    }) => {
      const hasAvailableSourceOutput = (outputId: PortId) => {
        const output = sourceOutputs[outputId];
        return output != null && output.type !== 'control-flow-excluded';
      };
      const getAvailableNodeOutputs = (nodeId: NodeId) => {
        if (excludedNodeIds.has(nodeId) || unsafeNodeIds.has(nodeId) || state.erroredNodeIds.has(nodeId)) {
          return undefined;
        }
        return availableNodeOutputs.get(nodeId) ?? state.nodeOutputs.get(nodeId);
      };
      const canConsiderNode = (nodeId: NodeId) => {
        const node = options.nodesById[nodeId];
        return (
          node != null &&
          !node.disabled &&
          !state.visitedNodeIds.has(nodeId) &&
          (!state.runToRelevantNodeIds || state.runToRelevantNodeIds.has(nodeId))
        );
      };
      const isUnsafeNode = (nodeId: NodeId) => excludedNodeIds.has(nodeId) || unsafeNodeIds.has(nodeId);
      const reachableNodeIds = new Set<NodeId>();
      const candidateNodeIds = new Set<NodeId>();
      for (const connection of outgoingConnectionsByNode.get(sourceNode.id) ?? []) {
        if (activeOutputPortIds.has(connection.outputId) && canConsiderNode(connection.inputNodeId)) {
          candidateNodeIds.add(connection.inputNodeId);
        }
      }

      const boundaryNodeIds = new Set<NodeId>();
      let addedNode = true;
      while (addedNode) {
        addedNode = false;

        for (const candidateNodeId of [...candidateNodeIds]) {
          const incomingConnections = incomingConnectionsByNode.get(candidateNodeId) ?? [];
          const isReady = incomingConnections.every((connection) => {
            if (connection.outputNodeId === sourceNode.id) {
              return activeOutputPortIds.has(connection.outputId) || hasAvailableSourceOutput(connection.outputId);
            }

            return (
              reachableNodeIds.has(connection.outputNodeId) || getAvailableNodeOutputs(connection.outputNodeId) != null
            );
          });
          if (!isReady) {
            continue;
          }

          candidateNodeIds.delete(candidateNodeId);
          if (isUnsafeNode(candidateNodeId)) {
            if (failOnUnsafeReadyNode) {
              const unsafeNode = options.nodesById[candidateNodeId]!;
              throw new Error(
                `Delegate Tool Call "${sourceNode.title}" cannot fire its pre-tool Message branch through unsupported node "${unsafeNode.title}". Move cycles, races, loops, and foreground rejoin points outside that branch.`,
              );
            }
            continue;
          }
          reachableNodeIds.add(candidateNodeId);
          addedNode = true;

          for (const connection of incomingConnections) {
            if (
              connection.outputNodeId !== sourceNode.id &&
              !reachableNodeIds.has(connection.outputNodeId) &&
              getAvailableNodeOutputs(connection.outputNodeId) != null
            ) {
              boundaryNodeIds.add(connection.outputNodeId);
            }
          }

          if (options.nodesById[candidateNodeId]?.type === 'startBackgroundBranch') {
            continue;
          }

          for (const connection of outgoingConnectionsByNode.get(candidateNodeId) ?? []) {
            if (
              connection.inputNodeId !== sourceNode.id &&
              !reachableNodeIds.has(connection.inputNodeId) &&
              canConsiderNode(connection.inputNodeId)
            ) {
              candidateNodeIds.add(connection.inputNodeId);
            }
          }
        }
      }

      if (reachableNodeIds.size === 0) {
        return undefined;
      }

      const includedNodeIds = new Set<NodeId>([sourceNode.id, ...reachableNodeIds, ...boundaryNodeIds]);
      const asyncBranchConnections: NodeConnection[] = [];
      for (const nodeId of reachableNodeIds) {
        if (options.nodesById[nodeId]?.type !== 'startBackgroundBranch') {
          continue;
        }
        const asyncPlan = options.asyncBranchPlansByTriggerNodeId.get(nodeId);
        if (!asyncPlan) {
          continue;
        }
        for (const node of asyncPlan.graph.nodes) {
          includedNodeIds.add(node.id);
        }
        asyncBranchConnections.push(...asyncPlan.graph.connections);
      }

      const foregroundBranchConnections = options.effectiveConnections.filter((connection) => {
        if (!reachableNodeIds.has(connection.inputNodeId)) {
          return false;
        }

        if (connection.outputNodeId === sourceNode.id) {
          return activeOutputPortIds.has(connection.outputId) || hasAvailableSourceOutput(connection.outputId);
        }

        return includedNodeIds.has(connection.outputNodeId);
      });
      const seenConnections = new Set<string>();
      const connections = [...foregroundBranchConnections, ...asyncBranchConnections].filter((connection) => {
        const key = `${connection.outputNodeId}:${connection.outputId}:${connection.inputNodeId}:${connection.inputId}`;
        if (seenConnections.has(key)) {
          return false;
        }
        seenConnections.add(key);
        return true;
      });
      const graph: NodeGraph = {
        metadata: options.graph.metadata ? { ...options.graph.metadata } : undefined,
        nodes: Object.values(options.nodesById).filter(
          (node): node is ChartNode => node != null && includedNodeIds.has(node.id),
        ),
        connections,
      };
      const preloadedOutputs = new Map<NodeId, NodeOutputs>([[sourceNode.id, sourceOutputs]]);
      for (const nodeId of boundaryNodeIds) {
        preloadedOutputs.set(nodeId, getAvailableNodeOutputs(nodeId)!);
      }

      return { graph, preloadedOutputs };
    },
  };
}

function getUnsafeNodeIds(options: {
  attachedNodeDataByNodeId: ReadonlyMap<NodeId, Readonly<Record<string, unknown>>>;
  graph: NodeGraph;
  isDefinitionValidConnection(connection: NodeConnection): boolean;
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
  stronglyConnectedComponents: readonly (readonly ChartNode[])[];
}): Set<NodeId> {
  const unsafeNodeIds = new Set<NodeId>();
  for (const component of options.stronglyConnectedComponents) {
    if (component.length > 1) {
      component.forEach((node) => unsafeNodeIds.add(node.id));
    }
  }

  for (const node of Object.values(options.nodesById)) {
    if (!node) {
      continue;
    }
    const attachedData = options.attachedNodeDataByNodeId.get(node.id);
    if (
      node.type === 'loopController' ||
      node.type === 'raceInputs' ||
      (attachedData != null && Object.values(attachedData).some(Boolean))
    ) {
      unsafeNodeIds.add(node.id);
    }
  }

  // SCC preprocessing sees every persisted edge, including secondary edges
  // that still participate in scheduler readiness. Preserve the same view
  // when detecting a one-node cycle.
  for (const connection of options.graph.connections) {
    if (connection.inputNodeId === connection.outputNodeId && options.isDefinitionValidConnection(connection)) {
      unsafeNodeIds.add(connection.inputNodeId);
    }
  }

  return unsafeNodeIds;
}

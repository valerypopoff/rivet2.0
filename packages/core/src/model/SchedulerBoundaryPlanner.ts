import type { ChartNode, NodeId, NodeConnection, PortId } from './NodeBase.js';
import type { NodeGraph } from './NodeGraph.js';

/** Definition-only planners. Iteration order preserves the processor's existing
 * validation/installation order; scheduling and resource ownership stay there. */
type BoundaryPlanningOptions = {
  graph: NodeGraph;
  executionNodes: readonly ChartNode[];
  nodesById: Readonly<Record<NodeId, ChartNode>>;
  connections: readonly NodeConnection[];
  relevantNodeIds?: ReadonlySet<NodeId>;
  preloadedNodes: { has(nodeId: NodeId): boolean };
};
export type StreamingWatchTopologyPlan =
  | { kind: 'dormant'; watchNode: ChartNode }
  | {
      kind: 'watch';
      watchNode: ChartNode;
      sourceNodeId: NodeId;
      sourceOutputId: PortId;
      branchNodeIds: Set<NodeId>;
      graph: NodeGraph;
      includeAllStreamedOutput: boolean;
      stopNodeId?: NodeId;
    };

function indexConnections(connections: readonly NodeConnection[]) {
  const outgoingByNodeId = new Map<NodeId, NodeConnection[]>();
  const incomingByNodeId = new Map<NodeId, NodeConnection[]>();
  for (const connection of connections) {
    const outgoing = outgoingByNodeId.get(connection.outputNodeId) ?? [];
    outgoing.push(connection);
    outgoingByNodeId.set(connection.outputNodeId, outgoing);
    const incoming = incomingByNodeId.get(connection.inputNodeId) ?? [];
    incoming.push(connection);
    incomingByNodeId.set(connection.inputNodeId, incoming);
  }
  return { outgoingByNodeId, incomingByNodeId };
}

export function getAsyncBranchWatchViolation(
  triggerNode: ChartNode,
  enclosingWatchNode?: ChartNode,
): Error | undefined {
  if (!enclosingWatchNode) return undefined;
  return new Error(
    `Start Async Branch "${triggerNode.title}" cannot run inside Watch Streaming Output "${enclosingWatchNode.title}". ` +
      'A Watch invocation must keep all work within the Watch scheduler. Move Start Async Branch after Stop Watching Streaming Output, or run the work directly inside the watched branch.',
  );
}

export function* planStreamingWatchTopology(
  options: BoundaryPlanningOptions & {
    consumedWatchNodeId?: NodeId;
    enclosingWatchNode?: ChartNode;
  },
): Generator<StreamingWatchTopologyPlan> {
  const connections = options.connections;
  const { outgoingByNodeId, incomingByNodeId } = indexConnections(connections);
  const relevantNodeIds = options.relevantNodeIds;
  const isRelevant = (nodeId: NodeId) => !relevantNodeIds || relevantNodeIds.has(nodeId);

  for (const watchNode of Object.values(options.nodesById)) {
    if (watchNode.type !== 'watchStreamingOutput' || watchNode.disabled || !isRelevant(watchNode.id)) {
      continue;
    }
    if (watchNode.id === options.consumedWatchNodeId) {
      continue;
    }
    const enclosingWatchInvocation = options.enclosingWatchNode;
    if (enclosingWatchInvocation) {
      throw new Error(
        `Watch Streaming Output "${watchNode.title}" cannot run inside Watch Streaming Output ` +
          `"${enclosingWatchInvocation.title}". A Watch branch cannot contain another Watch, including through Subgraph.`,
      );
    }
    if (options.preloadedNodes.has(watchNode.id)) {
      throw new Error(
        `Cannot preload ${watchNode.title} because a streaming boundary must be scheduled. ` +
          "Run from Watch Streaming Output to reuse a producer's saved final value, or run from the producer to stream again.",
      );
    }

    const incoming = incomingByNodeId.get(watchNode.id) ?? [];
    if (incoming.length === 0) {
      // An unattached Watch is an ordinary in-progress authoring state. Keep
      // it dormant rather than making an incomplete canvas fail to run.
      yield { kind: 'dormant', watchNode };
      continue;
    }
    if (incoming.length !== 1 || incoming[0]!.inputId !== ('stream' as PortId)) {
      throw new Error(
        `Watch Streaming Output "${watchNode.title}" must have exactly one Streaming Output input connection.`,
      );
    }
    const sourceConnection = incoming[0]!;
    const sourceNode = options.nodesById[sourceConnection.outputNodeId];
    if (!sourceNode || sourceNode.disabled || !isRelevant(sourceNode.id)) {
      throw new Error(`Watch Streaming Output "${watchNode.title}" has no runnable streaming source.`);
    }
    if (sourceNode.isSplitRun) {
      throw new Error(
        `Watch Streaming Output "${watchNode.title}" cannot watch split-run node "${sourceNode.title}". ` +
          'Assemble a single streaming value before the watch boundary.',
      );
    }

    const branchNodeIds = new Set<NodeId>();
    const pendingNodeIds = (outgoingByNodeId.get(watchNode.id) ?? [])
      .map((connection) => connection.inputNodeId)
      .filter(isRelevant);
    let stopNodeId: NodeId | undefined;

    while (pendingNodeIds.length > 0) {
      const nodeId = pendingNodeIds.pop()!;
      if (nodeId === watchNode.id) {
        throw new Error(`Watch Streaming Output "${watchNode.title}" cannot reconnect to itself.`);
      }
      if (branchNodeIds.has(nodeId)) {
        continue;
      }
      const node = options.nodesById[nodeId];
      if (!node || !isRelevant(nodeId)) {
        continue;
      }
      if (node.disabled) {
        throw new Error(`Watch Streaming Output "${watchNode.title}" cannot include disabled node "${node.title}".`);
      }
      if (node.type === 'watchStreamingOutput') {
        throw new Error(
          `Watch Streaming Output "${watchNode.title}" cannot contain another Watch Streaming Output node.`,
        );
      }
      if (node.type === 'catchStreamingChunks') {
        throw new Error(
          `Watch Streaming Output "${watchNode.title}" cannot contain Catch streaming chunks "${node.title}". ` +
            'Put Catch streaming chunks outside the repeated Watch branch.',
        );
      }
      if (node.type === 'graphOutput') {
        throw new Error(
          `Watch Streaming Output "${watchNode.title}" must reach Stop Watching Streaming Output before Graph Output "${node.title}".`,
        );
      }
      if (node.type === 'startBackgroundBranch') {
        throw new Error(
          `Watch Streaming Output "${watchNode.title}" cannot contain Start Async Branch. ` +
            'Keep watched work in the bounded watch branch instead.',
        );
      }

      branchNodeIds.add(nodeId);
      if (node.type === 'stopWatchingStreamingOutput') {
        if (stopNodeId && stopNodeId !== nodeId) {
          throw new Error(
            `Watch Streaming Output "${watchNode.title}" must have one Stop Watching Streaming Output boundary.`,
          );
        }
        stopNodeId = nodeId;
        continue;
      }

      for (const connection of outgoingByNodeId.get(nodeId) ?? []) {
        if (isRelevant(connection.inputNodeId)) {
          pendingNodeIds.push(connection.inputNodeId);
        }
      }
    }

    if (branchNodeIds.size === 0) {
      // Source -> Watch is also a useful intermediate authoring state. There
      // is no downstream work to schedule yet, so do not create a coordinator.
      yield { kind: 'dormant', watchNode };
      continue;
    }

    if (stopNodeId) {
      const reentry = (outgoingByNodeId.get(stopNodeId) ?? []).find(
        (connection) => connection.inputNodeId === watchNode.id || branchNodeIds.has(connection.inputNodeId),
      );
      if (reentry) {
        const stopNode = options.nodesById[stopNodeId]!;
        throw new Error(
          `Stop Watching Streaming Output "${stopNode.title}" cannot reconnect to its own Watch Streaming Output branch. ` +
            'Connect it only to ordinary downstream execution.',
        );
      }
    }

    for (const nodeId of branchNodeIds) {
      const externalInput = (incomingByNodeId.get(nodeId) ?? []).find(
        (connection) => connection.outputNodeId !== watchNode.id && !branchNodeIds.has(connection.outputNodeId),
      );
      if (externalInput) {
        const node = options.nodesById[nodeId]!;
        const externalNode = options.nodesById[externalInput.outputNodeId];
        throw new Error(
          `Watch Streaming Output "${watchNode.title}" cannot run "${node.title}" because it also depends on ` +
            `"${externalNode?.title ?? externalInput.outputNodeId}" outside the watch branch. ` +
            'Assemble every required value inside the watch boundary.',
        );
      }
    }

    const graph: NodeGraph = {
      metadata: options.graph.metadata ? { ...options.graph.metadata } : undefined,
      nodes: options.executionNodes.filter((node) => node.id === watchNode.id || branchNodeIds.has(node.id)),
      connections: connections.filter(
        (connection) =>
          connection.inputNodeId === watchNode.id ||
          (branchNodeIds.has(connection.inputNodeId) &&
            (connection.outputNodeId === watchNode.id || branchNodeIds.has(connection.outputNodeId))),
      ),
    };
    yield {
      kind: 'watch',
      graph,
      watchNode,
      branchNodeIds,
      sourceNodeId: sourceNode.id,
      sourceOutputId: sourceConnection.outputId,
      stopNodeId,
      includeAllStreamedOutput: connections.some(
        (connection) =>
          connection.outputNodeId === watchNode.id &&
          connection.outputId === ('allStreamedOutput' as PortId) &&
          branchNodeIds.has(connection.inputNodeId),
      ),
    };
  }
}

export function* planAsyncBranchTopology(
  options: BoundaryPlanningOptions & {
    consumedTriggerNodeId?: NodeId;
    inputAnchorNodeIds?: ReadonlySet<NodeId>;
    enclosingWatchNode?: ChartNode;
  },
): Generator<{ triggerNode: ChartNode; graph: NodeGraph; nodeIds: Set<NodeId> }> {
  const connections = options.connections;
  const { outgoingByNodeId, incomingByNodeId } = indexConnections(connections);
  const relevantNodeIds = options.relevantNodeIds;
  const isRelevant = (nodeId: NodeId) => !relevantNodeIds || relevantNodeIds.has(nodeId);

  for (const triggerNode of Object.values(options.nodesById)) {
    // Input anchors describe the consumed trigger's ports, not executable work.
    // A variadic anchor may itself be an outer async trigger.
    if (options.inputAnchorNodeIds?.has(triggerNode.id)) continue;
    if (triggerNode.type !== 'startBackgroundBranch' || triggerNode.disabled || !isRelevant(triggerNode.id)) {
      continue;
    }
    if (triggerNode.id !== options.consumedTriggerNodeId && options.preloadedNodes.has(triggerNode.id)) {
      throw new Error(
        `Start Async Branch "${triggerNode.title}" cannot use preloaded outputs because replaying it could repeat async side effects.`,
      );
    }

    const nodeIds = new Set<NodeId>();
    const pendingNodeIds = (outgoingByNodeId.get(triggerNode.id) ?? [])
      .map((connection) => connection.inputNodeId)
      .filter(isRelevant);

    while (pendingNodeIds.length > 0) {
      const nodeId = pendingNodeIds.pop()!;
      if (nodeId === triggerNode.id) {
        throw new Error(
          `Start Async Branch "${triggerNode.title}" cannot be part of a cycle or reconnect to its own inputs.`,
        );
      }
      if (nodeIds.has(nodeId)) {
        continue;
      }

      const node = options.nodesById[nodeId];
      if (!node) {
        continue;
      }
      if (node.disabled) {
        continue;
      }
      if (node.type === 'graphOutput') {
        throw new Error(
          `Start Async Branch "${triggerNode.title}" cannot contain Graph Output node "${node.title}". Async branches are side-effect-only.`,
        );
      }

      nodeIds.add(nodeId);
      for (const connection of outgoingByNodeId.get(nodeId) ?? []) {
        if (isRelevant(connection.inputNodeId)) {
          pendingNodeIds.push(connection.inputNodeId);
        }
      }
    }

    for (const nodeId of nodeIds) {
      const externalInput = (incomingByNodeId.get(nodeId) ?? []).find(
        (connection) => connection.outputNodeId !== triggerNode.id && !nodeIds.has(connection.outputNodeId),
      );
      if (externalInput) {
        const node = options.nodesById[nodeId]!;
        const externalNode = options.nodesById[externalInput.outputNodeId];
        throw new Error(
          `Start Async Branch "${triggerNode.title}" cannot run "${node.title}" because it also depends on ` +
            `"${externalNode?.title ?? externalInput.outputNodeId}" outside the async branch. Assemble all required values before the async trigger.`,
        );
      }
    }

    if (nodeIds.size === 0) {
      continue;
    }

    const managedAsyncBranchWatchViolation = getAsyncBranchWatchViolation(triggerNode, options.enclosingWatchNode);
    if (managedAsyncBranchWatchViolation) {
      throw managedAsyncBranchWatchViolation;
    }

    const preloadedNodeId = [...nodeIds].find((nodeId) => options.preloadedNodes.has(nodeId));
    if (preloadedNodeId) {
      const preloadedNode = options.nodesById[preloadedNodeId]!;
      throw new Error(
        `Start Async Branch "${triggerNode.title}" cannot contain preloaded node "${preloadedNode.title}". Preloading an async descendant would bypass the trigger boundary.`,
      );
    }

    // The node derives its variadic output definitions from connected inputs.
    // Retain shallow input anchors in the slice even though the trigger itself is preloaded.
    const triggerInputConnections = connections.filter((connection) => connection.inputNodeId === triggerNode.id);
    const inputAnchorNodeIds = new Set(triggerInputConnections.map((connection) => connection.outputNodeId));
    const includedNodeIds = new Set<NodeId>([triggerNode.id, ...nodeIds, ...inputAnchorNodeIds]);
    const graph: NodeGraph = {
      metadata: options.graph.metadata ? { ...options.graph.metadata } : undefined,
      nodes: options.executionNodes.filter((node) => includedNodeIds.has(node.id)),
      connections: connections.filter(
        (connection) =>
          connection.inputNodeId === triggerNode.id ||
          (nodeIds.has(connection.inputNodeId) &&
            (connection.outputNodeId === triggerNode.id || nodeIds.has(connection.outputNodeId))),
      ),
    };
    yield { triggerNode, graph, nodeIds };
  }
}

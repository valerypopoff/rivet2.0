import type { ChartNode, NodeConnection, NodeGraph, NodeId } from '@valerypopoff/rivet2-core';

/**
 * Identifies the live wire that carries repeated partial snapshots into a
 * Watch Streaming Output node. This stays derived from the definition-valid,
 * effective graph: the special presentation must disappear for a disabled or
 * no-longer-valid watch without changing the serialized connection.
 */
export function getStreamingOutputWatchConnections(
  graph: Pick<NodeGraph, 'connections'> & { nodes: readonly ChartNode[] },
): ReadonlySet<NodeConnection> {
  const connections = new Set<NodeConnection>();

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const connection of graph.connections) {
    const inputNode = nodesById.get(connection.inputNodeId);
    if (inputNode?.type === 'watchStreamingOutput' && !inputNode.disabled && connection.inputId === 'stream') {
      connections.add(connection);
    }
  }

  return connections;
}

/**
 * Finds the authored, repeated branch owned by each runnable Watch. This is
 * presentation-only topology: Watch work remains ordinary node history, while
 * the Stop boundary is shown as its single accepted terminal result rather
 * than a pager of racing/cancelled attempts.
 */
export function getStreamingOutputWatchBranchNodeIds(
  graph: Pick<NodeGraph, 'connections'> & { nodes: readonly ChartNode[] },
): ReadonlySet<NodeId> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoingByNodeId = new Map<NodeId, NodeConnection[]>();
  const incomingByNodeId = new Map<NodeId, NodeConnection[]>();

  for (const connection of graph.connections) {
    const outgoing = outgoingByNodeId.get(connection.outputNodeId) ?? [];
    outgoing.push(connection);
    outgoingByNodeId.set(connection.outputNodeId, outgoing);
    const incoming = incomingByNodeId.get(connection.inputNodeId) ?? [];
    incoming.push(connection);
    incomingByNodeId.set(connection.inputNodeId, incoming);
  }

  const branchNodeIds = new Set<NodeId>();
  for (const watch of graph.nodes) {
    if (watch.type !== 'watchStreamingOutput' || watch.disabled) {
      continue;
    }

    const streamInputs = (incomingByNodeId.get(watch.id) ?? []).filter((connection) => connection.inputId === 'stream');
    const source = streamInputs.length === 1 ? nodesById.get(streamInputs[0]!.outputNodeId) : undefined;
    if (!source || source.disabled) {
      continue;
    }

    const pending = (outgoingByNodeId.get(watch.id) ?? []).map((connection) => connection.inputNodeId);
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (branchNodeIds.has(nodeId)) {
        continue;
      }

      const node = nodesById.get(nodeId);
      if (!node) {
        continue;
      }

      branchNodeIds.add(nodeId);
      if (node.type !== 'stopWatchingStreamingOutput') {
        pending.push(...(outgoingByNodeId.get(nodeId) ?? []).map((connection) => connection.inputNodeId));
      }
    }
  }

  return branchNodeIds;
}

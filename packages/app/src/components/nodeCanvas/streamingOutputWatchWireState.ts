import type { ChartNode, NodeConnection, NodeGraph } from '@valerypopoff/rivet2-core';

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

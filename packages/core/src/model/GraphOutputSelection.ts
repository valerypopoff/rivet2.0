import type { ChartNode, NodeId } from './NodeBase.js';
import type { NodeGraph } from './NodeGraph.js';
import { resolveToolContinuationConnections } from './chat-v2/toolContinuationConnection.js';

export type GraphOutputSelection = {
  startNodes: ChartNode[];
  nodeIds: ReadonlySet<NodeId>;
};

/** Invocation-local selection over compiled topology, never a mutation of the reusable graph plan. */
export function createGraphOutputSelection(
  graph: Pick<NodeGraph, 'nodes' | 'connections'>,
  requestedOutputIds: readonly string[],
  getInputNodes: (node: ChartNode) => readonly ChartNode[],
): GraphOutputSelection {
  const requestedIds = new Set(requestedOutputIds);
  const missingIds = new Set(requestedIds);
  const startNodes = graph.nodes.filter((node) => {
    if (node.type !== 'graphOutput') return false;
    const outputId = (node.data as { id: string }).id;
    missingIds.delete(outputId);
    return requestedIds.has(outputId);
  });

  if (missingIds.size > 0) {
    throw new Error(
      `Unknown requested graph output IDs: ${[...missingIds].map((id) => JSON.stringify(id)).join(', ')}`,
    );
  }

  const continuations = resolveToolContinuationConnections(graph);
  const nodeIds = new Set<NodeId>();
  const pendingNodes = [...startNodes];
  for (let index = 0; index < pendingNodes.length; index++) {
    const node = pendingNodes[index]!;
    if (nodeIds.has(node.id)) continue;
    nodeIds.add(node.id);

    // Include every scheduler prerequisite, even if only the first provider supplies an input value.
    pendingNodes.push(...getInputNodes(node));
    const continuation = continuations.get(node.id);
    if (continuation?.kind === 'connected') {
      // A connected Delegate is part of the LLM computation despite the forward-facing wire.
      pendingNodes.push(continuation.delegateNode);
    }
    // Ambiguous continuations retain their existing node-execution error; never choose a winner here.
  }

  return { startNodes, nodeIds };
}

import {
  type ChartNode,
  type NodeGraph,
  type NodeId,
  type NodePrefab,
  type NodePrefabId,
  type Project,
  newId,
  canUseNodeAsPrefabSource,
  getNodePrefabInstancePrefabId,
  isNodePrefabInstanceNode,
} from '@valerypopoff/rivet2-core';

export { canUseNodeAsPrefabSource };

export function buildNodePrefab(sourceNode: ChartNode): NodePrefab {
  const id = newId<NodePrefabId>();
  return {
    id,
    sourceNode: {
      ...sourceNode,
      title: sourceNode.title || 'Untitled library node',
      visualData: {
        ...sourceNode.visualData,
        width: sourceNode.visualData.width ?? 240,
      },
    },
  };
}

export type NodePrefabUsage = {
  graph: NodeGraph;
  nodeId: NodeId;
};

export function getNodePrefabUsage(
  project: Project,
  prefabId: NodePrefabId,
  liveGraphs: readonly NodeGraph[] = [],
): NodePrefabUsage[] {
  const graphsById = new Map<string, NodeGraph>(
    Object.entries(project.graphs).map(([graphId, graph]) => [graph.metadata?.id ?? graphId, graph]),
  );

  liveGraphs.forEach((graph, index) => {
    graphsById.set(graph.metadata?.id ?? `live:${index}`, graph);
  });

  return [...graphsById.values()].flatMap((graph) =>
    graph.nodes
      .filter((node) => isNodePrefabInstanceNode(node) && getNodePrefabInstancePrefabId(node) === prefabId)
      .map((node) => ({ graph, nodeId: node.id })),
  );
}

export function getNodePrefabUsageLabel(usage: NodePrefabUsage): string {
  return `${usage.graph.metadata?.name ?? 'Untitled graph'} (${usage.nodeId})`;
}

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

function getGraphsWithLiveOverrides(project: Project, liveGraphs: readonly NodeGraph[]): readonly NodeGraph[] {
  const graphsById = new Map<string, NodeGraph>(
    Object.entries(project.graphs).map(([graphId, graph]) => [graph.metadata?.id ?? graphId, graph]),
  );

  liveGraphs.forEach((graph, index) => {
    graphsById.set(graph.metadata?.id ?? `live:${index}`, graph);
  });

  return [...graphsById.values()];
}

/**
 * Index every linked library-node instance in the project. The optional live graph
 * replaces its saved snapshot so callers never count an unsaved instance twice.
 */
export function getNodePrefabUsages(
  project: Project,
  liveGraphs: readonly NodeGraph[] = [],
): ReadonlyMap<NodePrefabId, readonly NodePrefabUsage[]> {
  const usagesByPrefabId = new Map<NodePrefabId, NodePrefabUsage[]>();

  for (const graph of getGraphsWithLiveOverrides(project, liveGraphs)) {
    for (const node of graph.nodes) {
      if (!isNodePrefabInstanceNode(node)) {
        continue;
      }

      const prefabId = getNodePrefabInstancePrefabId(node);
      if (!prefabId) {
        continue;
      }

      const usages = usagesByPrefabId.get(prefabId) ?? [];
      usages.push({ graph, nodeId: node.id });
      usagesByPrefabId.set(prefabId, usages);
    }
  }

  return usagesByPrefabId;
}

export function getNodePrefabUsage(
  project: Project,
  prefabId: NodePrefabId,
  liveGraphs: readonly NodeGraph[] = [],
): NodePrefabUsage[] {
  return [...(getNodePrefabUsages(project, liveGraphs).get(prefabId) ?? [])];
}

export function getNodePrefabUsageLabel(usage: NodePrefabUsage): string {
  return `${usage.graph.metadata?.name ?? 'Untitled graph'} (${usage.nodeId})`;
}

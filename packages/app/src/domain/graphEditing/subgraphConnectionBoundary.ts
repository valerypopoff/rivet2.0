import {
  getGraphBoundary,
  getSubgraphProjectKey,
  getSubgraphTargetBoundaryChange,
  reconcileSubgraphTargetBoundary,
  type ChartNode,
  type GraphBoundary,
  type NodeConnection,
  type NodeId,
  type Project,
  type ProjectId,
  type SubGraphNode,
} from '@valerypopoff/rivet2-core';

export type SubgraphConnectionBoundaryChange = {
  nodeId: NodeId;
  previous: GraphBoundary | undefined;
  next: GraphBoundary;
};

/** Accepting a wire to a newly discovered port must persist its contract, too. */
export function captureSubgraphConnectionBoundaries(
  nodes: readonly ChartNode[],
  connection: NodeConnection,
  referencedProjects: Record<ProjectId, Project>,
): SubgraphConnectionBoundaryChange[] {
  const changes: SubgraphConnectionBoundaryChange[] = [];
  for (const node of nodes) {
    if (node.type !== 'subGraph') continue;
    const { data } = node as SubGraphNode;
    if (!data.targetProjectId) continue;
    const ports = [
      ...(connection.inputNodeId === node.id ? [{ side: 'inputs' as const, id: connection.inputId }] : []),
      ...(connection.outputNodeId === node.id ? [{ side: 'outputs' as const, id: connection.outputId }] : []),
    ];
    if (!ports.length || ports.every(({ side, id }) => data.targetBoundary?.[side].some((port) => port.portId === id)))
      continue;
    const target =
      referencedProjects[
        getSubgraphProjectKey({ projectId: data.targetProjectId, version: data.targetVersion ?? 'latest' })
      ];
    const actual = target && getGraphBoundary(target, data.graphId);
    // Do not silently accept removals/type changes or cross-version previews.
    if (!actual || getSubgraphTargetBoundaryChange(data.targetBoundary, actual)) continue;
    const next = reconcileSubgraphTargetBoundary(data.targetBoundary, actual);
    if (!ports.every(({ side, id }) => next[side].some((port) => port.portId === id))) continue;
    changes.push({ nodeId: node.id, previous: data.targetBoundary, next });
  }
  return structuredClone(changes);
}

export function applySubgraphConnectionBoundaries(
  nodes: ChartNode[],
  changes: readonly SubgraphConnectionBoundaryChange[],
  undo = false,
): ChartNode[] {
  if (!changes.length) return nodes;
  return nodes.map((node) => {
    const change = changes.find((entry) => entry.nodeId === node.id);
    if (!change || node.type !== 'subGraph') return node;
    return {
      ...node,
      data: { ...(node as SubGraphNode).data, targetBoundary: structuredClone(undo ? change.previous : change.next) },
    };
  });
}

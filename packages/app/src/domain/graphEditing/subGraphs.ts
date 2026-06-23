import type { ChartNode, GraphId } from '@valerypopoff/rivet2-core';

type SubGraphNodeData = {
  graphId?: unknown;
};

function getEnabledStaticSubGraphId(node: ChartNode): GraphId | undefined {
  if (node.type !== 'subGraph' || node.disabled) {
    return undefined;
  }

  const graphId = (node.data as SubGraphNodeData).graphId;
  return typeof graphId === 'string' && graphId ? (graphId as GraphId) : undefined;
}

export function getRecursiveSubGraphWarning(
  node: ChartNode,
  containingGraphId: GraphId | undefined,
): string | undefined {
  const graphId = getEnabledStaticSubGraphId(node);
  if (!graphId || !containingGraphId || graphId !== containingGraphId) {
    return undefined;
  }

  return 'This Subgraph points to the graph it is inside, creating direct recursion.';
}

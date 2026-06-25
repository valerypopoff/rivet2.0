import type {
  ChartNode,
  NodeId,
  NodeConnection,
  ProjectComparisonChangeKind,
  ProjectGraphComparison,
} from '@valerypopoff/rivet2-core';

export type CanvasProjectComparisonRenderState = {
  compareNodesById: Record<NodeId, ChartNode>;
  compareRemovedConnections: NodeConnection[];
  compareRemovedNodes: ChartNode[];
  connectionCompareKindsByKey: Record<string, ProjectComparisonChangeKind>;
  nodeCompareKindsById: Record<NodeId, ProjectComparisonChangeKind | undefined>;
};

export const EMPTY_CANVAS_PROJECT_COMPARISON_RENDER_STATE: CanvasProjectComparisonRenderState = {
  compareNodesById: {},
  compareRemovedConnections: [],
  compareRemovedNodes: [],
  connectionCompareKindsByKey: {},
  nodeCompareKindsById: {},
};

export function getCanvasNodeCompareKindsById(
  graphComparison: ProjectGraphComparison | undefined,
): Record<NodeId, ProjectComparisonChangeKind | undefined> {
  if (!graphComparison) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(graphComparison.nodes)
      .filter(
        ([, comparison]) =>
          (comparison.kind === 'added' || comparison.kind === 'changed') &&
          comparison.after &&
          comparison.after.type !== 'comment',
      )
      .map(([nodeId, comparison]) => [nodeId, comparison.kind]),
  ) as Record<NodeId, ProjectComparisonChangeKind | undefined>;
}

export function getCanvasProjectComparisonRenderState(
  graphComparison: ProjectGraphComparison | undefined,
): CanvasProjectComparisonRenderState {
  if (!graphComparison) {
    return EMPTY_CANVAS_PROJECT_COMPARISON_RENDER_STATE;
  }

  const compareRemovedNodes = Object.values(graphComparison.nodes)
    .filter((comparison) => comparison.kind === 'removed' && comparison.before)
    .map((comparison) => comparison.before!);
  const compareRemovedConnections = Object.values(graphComparison.connections)
    .filter((comparison) => comparison.before && (comparison.kind === 'removed' || comparison.kind === 'changed'))
    .map((comparison) => comparison.before!);
  const connectionCompareKindsByKey = Object.fromEntries(
    Object.entries(graphComparison.connections)
      .filter(([, comparison]) => comparison.kind !== 'unchanged' && comparison.after)
      .map(([key, comparison]) => [key, comparison.kind]),
  ) as Record<string, ProjectComparisonChangeKind>;

  return {
    compareNodesById: Object.fromEntries(compareRemovedNodes.map((node) => [node.id, node])) as Record<
      NodeId,
      ChartNode
    >,
    compareRemovedConnections,
    compareRemovedNodes,
    connectionCompareKindsByKey,
    nodeCompareKindsById: getCanvasNodeCompareKindsById(graphComparison),
  };
}

import type { ChartNode, NodeId } from '../../model/NodeBase.js';
import type { ProjectNodeComparison, ProjectNodeFieldComparison } from '../projectComparison.js';
import { areComparisonValuesEqual, getChangedValueComparisons, isComparisonRecord, unionKeys } from './values.js';

export function getProjectNodeFieldComparisons(comparison: ProjectNodeComparison): ProjectNodeFieldComparison[] {
  const before = comparison.before;
  const after = comparison.after;

  if (!before || !after) {
    return [];
  }

  return getChangedValueComparisons([], getComparableNodeRecord(before), getComparableNodeRecord(after));
}

export function getComparableGraphNodes(nodes: ChartNode[]): ChartNode[] {
  return nodes.filter((node) => node.type !== 'comment');
}

export function compareNodes(beforeNodes: ChartNode[], afterNodes: ChartNode[]): Record<NodeId, ProjectNodeComparison> {
  const beforeById = new Map(beforeNodes.map((node) => [node.id, node]));
  const afterById = new Map(afterNodes.map((node) => [node.id, node]));
  const nodeIds = unionKeys(Object.fromEntries(beforeById), Object.fromEntries(afterById)) as NodeId[];

  return Object.fromEntries(
    nodeIds.map((nodeId) => {
      const before = beforeById.get(nodeId);
      const after = afterById.get(nodeId);

      if (!before && after) {
        return [nodeId, { id: nodeId, kind: 'added', after } satisfies ProjectNodeComparison];
      }

      if (before && !after) {
        return [nodeId, { id: nodeId, kind: 'removed', before } satisfies ProjectNodeComparison];
      }

      return [
        nodeId,
        {
          id: nodeId,
          kind: areComparisonNodesEqual(before, after) ? 'unchanged' : 'changed',
          before,
          after,
        } satisfies ProjectNodeComparison,
      ];
    }),
  ) as Record<NodeId, ProjectNodeComparison>;
}

function areComparisonNodesEqual(left: ChartNode | undefined, right: ChartNode | undefined): boolean {
  return areComparisonValuesEqual(
    left ? getComparableNodeRecord(left) : left,
    right ? getComparableNodeRecord(right) : right,
  );
}

function getComparableNodeRecord(node: ChartNode): Record<string, unknown> {
  const { data, visualData, ...rest } = node as unknown as Record<string, unknown>;

  return {
    ...rest,
    data: getComparableNodeData(node, data),
    visualData: getComparableVisualData(visualData),
  };
}

function getComparableNodeData(node: ChartNode, data: unknown): unknown {
  if (node.type !== 'subGraph' || !isComparisonRecord(data)) {
    return data;
  }

  const { inputPortOrder: _inputPortOrder, outputPortOrder: _outputPortOrder, ...semanticData } = data;
  return semanticData;
}

function getComparableVisualData(visualData: unknown): Record<string, unknown> {
  if (!isComparisonRecord(visualData)) {
    return {};
  }

  const { x: _x, y: _y, zIndex: _zIndex, ...semanticVisualData } = visualData;
  return semanticVisualData;
}

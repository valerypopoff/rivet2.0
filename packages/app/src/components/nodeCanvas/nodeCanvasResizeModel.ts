import { type ChartNode, type NodeId } from '@valerypopoff/rivet2-core';
import {
  calculateNodeResizeGroupChanges,
  MIN_NODE_WIDTH,
  type NodeResizeChange,
  type NodeResizeBounds,
  type NodeResizeGroupSnapshot,
} from '../../utils/nodeResize.js';

export type ResizeNodeSnapshot = NodeResizeGroupSnapshot & {
  previousNode: ChartNode;
};

export type ActiveResizeGroup = {
  sourceNodeId: NodeId;
  snapshots: ResizeNodeSnapshot[];
};

export function parseFiniteStyleNumber(value: string | undefined, fallback: number): number {
  if (value == null) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getRenderedMinWidth(computedStyle: CSSStyleDeclaration | undefined): number {
  return Math.max(MIN_NODE_WIDTH, parseFiniteStyleNumber(computedStyle?.minWidth, MIN_NODE_WIDTH));
}

export function getResizeNodeIds(sourceNodeId: NodeId, selectedNodeIds: readonly NodeId[]): Set<NodeId> {
  const selectedNodeIdSet = new Set(selectedNodeIds);
  return selectedNodeIdSet.has(sourceNodeId) && selectedNodeIdSet.size > 1
    ? selectedNodeIdSet
    : new Set<NodeId>([sourceNodeId]);
}

export function createResizeNodeSnapshot(options: {
  height: number | undefined;
  minWidth: number;
  node: ChartNode;
  width: number;
}): ResizeNodeSnapshot {
  const { height, minWidth, node, width } = options;

  return {
    nodeId: node.id,
    x: node.visualData.x,
    y: node.type === 'comment' ? node.visualData.y : undefined,
    width,
    height: node.type === 'comment' ? height : undefined,
    minWidth,
    previousNode: structuredClone(node),
  };
}

export function getResizeChangesForGroup(options: {
  snapshots: readonly ResizeNodeSnapshot[];
  sourceNextBounds: NodeResizeBounds;
  sourceNodeId: NodeId;
}): NodeResizeChange[] {
  const previousNodesByNodeId = new Map(
    options.snapshots.map((snapshot) => [snapshot.nodeId, snapshot.previousNode]),
  );

  return calculateNodeResizeGroupChanges({
    sourceNodeId: options.sourceNodeId,
    sourceNextBounds: options.sourceNextBounds,
    snapshots: options.snapshots,
  }).map((change): NodeResizeChange => {
    const previousNode = previousNodesByNodeId.get(change.nodeId as NodeId);
    if (!previousNode) {
      throw new Error(`No resize snapshot found for node ${change.nodeId}`);
    }

    return {
      nodeId: change.nodeId as NodeId,
      nextBounds: change.nextBounds,
      previousNode,
    };
  });
}

export function hasResizeSnapshotChanged(snapshot: ResizeNodeSnapshot, nextBounds: NodeResizeBounds): boolean {
  return (
    snapshot.x !== nextBounds.x ||
    snapshot.width !== nextBounds.width ||
    (nextBounds.y !== undefined && snapshot.y !== nextBounds.y) ||
    (nextBounds.height !== undefined && snapshot.height !== nextBounds.height)
  );
}

export function getChangedResizeEntries(options: {
  changes: readonly NodeResizeChange[];
  snapshots: readonly ResizeNodeSnapshot[];
}): NodeResizeChange[] {
  const snapshotsByNodeId = new Map(options.snapshots.map((snapshot) => [snapshot.nodeId, snapshot]));

  return options.changes.filter((change) => {
    const snapshot = snapshotsByNodeId.get(change.nodeId);
    return snapshot ? hasResizeSnapshotChanged(snapshot, change.nextBounds) : true;
  });
}

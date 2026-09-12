import {
  getProjectConnectionComparisonKey,
  newId,
  type ChartNode,
  type CommentNode,
  type NodeConnection,
  type NodeId,
} from '@valerypopoff/rivet2-core';
import {
  DEFAULT_CANVAS_NODE_HEIGHT_ESTIMATE,
  getCanvasCommentHeight,
  getCanvasNodeWidth,
} from '../../hooks/canvasVisibilityBounds.js';
import { isNotNull } from '../../utils/genericUtilFunctions.js';

export type DragMode = 'move' | 'duplicate';
export type DragAxisLock = 'x' | 'y' | undefined;
export type DragActivatorModifierState = {
  altKey: boolean;
  ctrlKey: boolean;
  hoverControlsVisible: boolean;
  metaKey: boolean;
  nodeId: NodeId;
  shiftKey: boolean;
};
export type DragDelta = { x: number; y: number };

type DragModifierKeyEvent = Pick<KeyboardEvent, 'altKey' | 'key'>;
type DragShiftKeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey'>;
type DragCommentEnclosureKeyEvent = Pick<KeyboardEvent, 'ctrlKey' | 'key' | 'metaKey'>;
type NodeEnclosureBounds = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export function resolveDraggedNodeIds(selectedNodeIds: NodeId[], draggedNodeId: NodeId): NodeId[] {
  return selectedNodeIds.length > 0 ? [...new Set([...selectedNodeIds, draggedNodeId])] : [draggedNodeId];
}

export function resolveDraggedSourceNodes(
  draggedNodeIds: NodeId[],
  nodesById: Record<NodeId, ChartNode | undefined>,
): { sourceNodeIds: NodeId[]; sourceNodes: ChartNode[] } {
  const sourceNodes = draggedNodeIds.map((nodeId) => nodesById[nodeId]).filter(isNotNull);

  return {
    sourceNodeIds: sourceNodes.map((node) => node.id),
    sourceNodes,
  };
}

function getNodeCommentEnclosureBounds(node: ChartNode): NodeEnclosureBounds {
  const width = getCanvasNodeWidth(node);
  const height =
    node.type === 'comment'
      ? getCanvasCommentHeight(node as CommentNode)
      : DEFAULT_CANVAS_NODE_HEIGHT_ESTIMATE;

  return {
    bottom: node.visualData.y + height,
    left: node.visualData.x,
    right: node.visualData.x + width,
    top: node.visualData.y,
  };
}

function getDraggedCommentNodes(draggedNodeIds: ReadonlySet<NodeId>, nodes: readonly ChartNode[]): CommentNode[] {
  return nodes.filter(
    (node): node is CommentNode => draggedNodeIds.has(node.id) && node.type === 'comment',
  );
}

function isPointInsideBounds(point: { x: number; y: number }, bounds: NodeEnclosureBounds): boolean {
  return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
}

export function isNodeFullyInsideCommentBounds(node: ChartNode, commentNode: CommentNode): boolean {
  if (node.id === commentNode.id) {
    return false;
  }

  const nodeBounds = getNodeCommentEnclosureBounds(node);
  const commentBounds = getNodeCommentEnclosureBounds(commentNode);

  return (
    nodeBounds.left >= commentBounds.left &&
    nodeBounds.right <= commentBounds.right &&
    nodeBounds.top >= commentBounds.top &&
    nodeBounds.bottom <= commentBounds.bottom
  );
}

export function resolveCommentEnclosureDraggedNodeIds({
  draggedNodeIds,
  includeEnclosedNodes,
  nodes,
}: {
  draggedNodeIds: NodeId[];
  includeEnclosedNodes: boolean;
  nodes: readonly ChartNode[];
}): NodeId[] {
  if (!includeEnclosedNodes) {
    return draggedNodeIds;
  }

  const draggedNodeIdSet = new Set(draggedNodeIds);
  const commentNodes = getDraggedCommentNodes(draggedNodeIdSet, nodes);

  if (commentNodes.length === 0) {
    return draggedNodeIds;
  }

  const nextNodeIds = [...draggedNodeIds];

  for (const node of nodes) {
    if (draggedNodeIdSet.has(node.id)) {
      continue;
    }

    if (commentNodes.some((commentNode) => isNodeFullyInsideCommentBounds(node, commentNode))) {
      draggedNodeIdSet.add(node.id);
      nextNodeIds.push(node.id);
    }
  }

  return nextNodeIds;
}

/**
 * Returns authored connection bends that are spatially part of a dragged Comment.
 *
 * This deliberately uses only the bend position, rather than connection endpoints:
 * a Comment is a geometric grouping aid, and a wire can cross its boundary while
 * its user-authored bend still belongs with the Comment's contents.
 */
export function resolveCommentEnclosureDraggedConnectionBendKeys({
  connections,
  draggedNodeIds,
  includeEnclosedNodes,
  nodes,
}: {
  connections: readonly NodeConnection[];
  draggedNodeIds: NodeId[];
  includeEnclosedNodes: boolean;
  nodes: readonly ChartNode[];
}): string[] {
  if (!includeEnclosedNodes) {
    return [];
  }

  const commentBounds = getDraggedCommentNodes(new Set(draggedNodeIds), nodes).map(
    getNodeCommentEnclosureBounds,
  );

  if (commentBounds.length === 0) {
    return [];
  }

  return connections.flatMap((connection) => {
    const bendPoint = connection.bendPoint;
    if (
      !bendPoint ||
      !commentBounds.some((bounds) => isPointInsideBounds(bendPoint, bounds))
    ) {
      return [];
    }

    return [getProjectConnectionComparisonKey(connection)];
  });
}

export function resolveDragModeFromAlt(altKey: boolean): DragMode {
  return altKey ? 'duplicate' : 'move';
}

export function resolveDragAxisLock({
  axisLock,
  shiftKey,
  delta,
}: {
  axisLock: DragAxisLock;
  shiftKey: boolean;
  delta: DragDelta;
}): DragAxisLock {
  if (!shiftKey) {
    return undefined;
  }

  if (axisLock) {
    return axisLock;
  }

  if (delta.x === 0 && delta.y === 0) {
    return undefined;
  }

  return Math.abs(delta.x) >= Math.abs(delta.y) ? 'x' : 'y';
}

export function constrainDragDeltaToAxisLock<T extends DragDelta>(delta: T, axisLock: DragAxisLock): T {
  if (axisLock === 'x') {
    return { ...delta, y: 0 };
  }

  if (axisLock === 'y') {
    return { ...delta, x: 0 };
  }

  return delta;
}

export function createDragDuplicatePreviewNodes(nodes: ChartNode[]): ChartNode[] {
  return nodes.map((node) => ({
    ...node,
    id: newId<NodeId>(),
    visualData: {
      ...node.visualData,
    },
  }));
}

export function shouldUseDuplicateDragModeOnKeyDown(event: DragModifierKeyEvent): boolean {
  return event.key === 'Alt' || event.altKey;
}

export function shouldUseMoveDragModeOnKeyUp(event: DragModifierKeyEvent): boolean {
  return event.key === 'Alt' || !event.altKey;
}

export function shouldEnableStraightLineDragOnKeyDown(event: DragShiftKeyEvent): boolean {
  return event.key === 'Shift' || event.shiftKey;
}

export function shouldDisableStraightLineDragOnKeyUp(event: DragShiftKeyEvent): boolean {
  return event.key === 'Shift' || !event.shiftKey;
}

export function isCommentEnclosureDragModifierActive(
  event: Pick<DragCommentEnclosureKeyEvent, 'ctrlKey' | 'metaKey'>,
): boolean {
  return event.ctrlKey || event.metaKey;
}

export function shouldEnableCommentEnclosureDragOnKeyDown(event: DragCommentEnclosureKeyEvent): boolean {
  return event.key === 'Control' || event.key === 'Meta' || isCommentEnclosureDragModifierActive(event);
}

export function shouldDisableCommentEnclosureDragOnKeyUp(event: DragCommentEnclosureKeyEvent): boolean {
  return !isCommentEnclosureDragModifierActive(event);
}

export function getDraggingPreviewNodes(options: {
  dragMode: DragMode;
  sourceNodes: ChartNode[];
  previewNodes: ChartNode[];
}): ChartNode[] {
  return options.dragMode === 'duplicate' ? options.previewNodes : options.sourceNodes;
}

export function getDraggingConnectionSourceNodeIds(options: { dragMode: DragMode; sourceNodeIds: NodeId[] }): NodeId[] {
  return options.dragMode === 'move' ? options.sourceNodeIds : [];
}

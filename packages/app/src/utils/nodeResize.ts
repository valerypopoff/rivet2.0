import type { ChartNode, CommentNode, NodeId } from '@valerypopoff/rivet2-core';

export type HorizontalNodeResizeDirection = 'left' | 'right';

export type BoxNodeResizeDirection =
  | HorizontalNodeResizeDirection
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export type HorizontalNodeResizeBounds = {
  x: number;
  width: number;
};

export type NodeResizeBounds = HorizontalNodeResizeBounds & {
  y?: number;
  height?: number;
};

export type NodeResizeGroupSnapshot = NodeResizeBounds & {
  nodeId: string;
  minWidth: number;
};

export type NodeResizeGroupChange = {
  nodeId: string;
  nextBounds: NodeResizeBounds;
};

export type NodeResizeChange = {
  nodeId: NodeId;
  nextBounds: NodeResizeBounds;
  previousNode: ChartNode;
};

export const DEFAULT_NODE_WIDTH = 300;
export const MIN_NODE_WIDTH = 160;
export const MIN_NODE_HEIGHT = 120;

export function haveHorizontalNodeResizeBoundsChanged(
  previousBounds: HorizontalNodeResizeBounds,
  nextBounds: HorizontalNodeResizeBounds,
): boolean {
  return previousBounds.x !== nextBounds.x || previousBounds.width !== nextBounds.width;
}

export function computeHorizontalNodeResizeBounds({
  direction,
  initialWidth,
  initialX,
  deltaX,
  minWidth = MIN_NODE_WIDTH,
}: {
  direction: HorizontalNodeResizeDirection;
  initialWidth: number;
  initialX: number;
  deltaX: number;
  minWidth?: number;
}): HorizontalNodeResizeBounds {
  if (direction === 'right') {
    return {
      x: initialX,
      width: Math.max(minWidth, initialWidth + deltaX),
    };
  }

  const nextWidth = Math.max(minWidth, initialWidth - deltaX);
  const preservedRightEdge = initialX + initialWidth;

  return {
    x: preservedRightEdge - nextWidth,
    width: nextWidth,
  };
}

export function haveNodeResizeBoundsChanged(previousBounds: NodeResizeBounds, nextBounds: NodeResizeBounds): boolean {
  return (
    previousBounds.x !== nextBounds.x ||
    previousBounds.y !== nextBounds.y ||
    previousBounds.width !== nextBounds.width ||
    previousBounds.height !== nextBounds.height
  );
}

export function computeBoxNodeResizeBounds({
  direction,
  initialHeight,
  initialWidth,
  initialX,
  initialY,
  deltaX,
  deltaY,
  minHeight = MIN_NODE_HEIGHT,
  minWidth = MIN_NODE_WIDTH,
}: {
  direction: BoxNodeResizeDirection;
  initialHeight: number;
  initialWidth: number;
  initialX: number;
  initialY: number;
  deltaX: number;
  deltaY: number;
  minHeight?: number;
  minWidth?: number;
}): Required<NodeResizeBounds> {
  const resizesLeft = direction === 'left' || direction.endsWith('-left');
  const resizesRight = direction === 'right' || direction.endsWith('-right');
  const resizesTop = direction === 'top' || direction.startsWith('top-');
  const resizesBottom = direction === 'bottom' || direction.startsWith('bottom-');

  const width = resizesLeft
    ? Math.max(minWidth, initialWidth - deltaX)
    : resizesRight
      ? Math.max(minWidth, initialWidth + deltaX)
      : initialWidth;

  const height = resizesTop
    ? Math.max(minHeight, initialHeight - deltaY)
    : resizesBottom
      ? Math.max(minHeight, initialHeight + deltaY)
      : initialHeight;

  return {
    x: resizesLeft ? initialX + initialWidth - width : initialX,
    y: resizesTop ? initialY + initialHeight - height : initialY,
    width,
    height,
  };
}

export function calculateNodeResizeGroupChanges({
  sourceNodeId,
  sourceNextBounds,
  snapshots,
}: {
  sourceNodeId: string;
  sourceNextBounds: NodeResizeBounds;
  snapshots: readonly NodeResizeGroupSnapshot[];
}): NodeResizeGroupChange[] {
  const sourceSnapshot = snapshots.find((snapshot) => snapshot.nodeId === sourceNodeId);
  if (!sourceSnapshot) {
    return [];
  }

  const sourceNextWidth = Math.max(sourceSnapshot.minWidth, sourceNextBounds.width);
  const widthDelta = sourceNextWidth - sourceSnapshot.width;
  const resizesFromLeft = sourceNextBounds.x !== sourceSnapshot.x;
  const sourceNextX = resizesFromLeft ? sourceSnapshot.x - widthDelta : sourceNextBounds.x;

  return snapshots.map((snapshot) => {
    if (snapshot.nodeId === sourceNodeId) {
      return {
        nodeId: snapshot.nodeId,
        nextBounds: {
          x: sourceNextX,
          y: sourceNextBounds.y,
          width: sourceNextWidth,
          height: sourceNextBounds.height,
        },
      };
    }

    const nextWidth = Math.max(snapshot.minWidth, snapshot.width + widthDelta);
    const actualWidthDelta = nextWidth - snapshot.width;

    return {
      nodeId: snapshot.nodeId,
      nextBounds: {
        x: resizesFromLeft ? snapshot.x - actualWidthDelta : snapshot.x,
        width: nextWidth,
      },
    };
  });
}

export function applyResizeBoundsToNode(node: ChartNode, nextBounds: NodeResizeBounds): ChartNode {
  const nextNode: ChartNode = {
    ...node,
    visualData: {
      ...node.visualData,
      x: nextBounds.x,
      y: nextBounds.y ?? node.visualData.y,
      width: nextBounds.width,
    },
  };

  if (nextNode.type === 'comment' && nextBounds.height != null) {
    return {
      ...nextNode,
      data: {
        ...(nextNode as CommentNode).data,
        height: nextBounds.height,
      },
    } as ChartNode;
  }

  return nextNode;
}

export function applyResizeChangesToNodes(
  nodes: ChartNode[],
  resizeChanges: readonly NodeResizeChange[],
  options?: { requireAllChanges?: boolean },
): ChartNode[] {
  if (options?.requireAllChanges) {
    const nodeIds = new Set(nodes.map((node) => node.id));
    const missingChange = resizeChanges.find((change) => !nodeIds.has(change.nodeId));
    if (missingChange) {
      throw new Error(`Node with id ${missingChange.nodeId} not found`);
    }
  }

  const resizeChangesByNodeId = new Map(resizeChanges.map((change) => [change.nodeId, change.nextBounds]));
  return nodes.map((node) => {
    const nextBounds = resizeChangesByNodeId.get(node.id);
    return nextBounds ? applyResizeBoundsToNode(node, nextBounds) : node;
  });
}

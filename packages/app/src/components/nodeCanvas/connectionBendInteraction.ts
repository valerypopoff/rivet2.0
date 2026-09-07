import type { NodeConnection } from '@valerypopoff/rivet2-core';

export type ConnectionBendPoint = NonNullable<NodeConnection['bendPoint']>;
export type ConnectionBendAxisLock = 'x' | 'y' | undefined;

export type ConnectionBendClickStart = {
  connectionKey: string;
  clientX: number;
  clientY: number;
};

export type DraggingConnectionBend = {
  axisLock: ConnectionBendAxisLock;
  connection: NodeConnection;
  connectionKey: string;
  hasMoved: boolean;
  point: ConnectionBendPoint;
  startClientX: number;
  startClientY: number;
  startPoint: ConnectionBendPoint;
};

export const CONNECTION_BEND_DRAG_THRESHOLD_PX = 2;
export const CONNECTION_BEND_CLICK_THRESHOLD_PX = 5;

export function getGhostConnectionBendPoint({
  allowEditing,
  hoveredConnection,
  hoveredConnectionPoint,
}: {
  allowEditing: boolean;
  hoveredConnection: NodeConnection | undefined;
  hoveredConnectionPoint: ConnectionBendPoint | undefined;
}): ConnectionBendPoint | undefined {
  return allowEditing && hoveredConnection && !hoveredConnection.bendPoint ? hoveredConnectionPoint : undefined;
}

export function shouldCommitConnectionBendClick({
  clickStart,
  connectionKey,
  clientX,
  clientY,
  hasBendPoint,
  isDraggingBend,
  isReadOnlyGraph,
}: {
  clickStart: ConnectionBendClickStart | undefined;
  connectionKey: string;
  clientX: number;
  clientY: number;
  hasBendPoint: boolean;
  isDraggingBend: boolean;
  isReadOnlyGraph: boolean;
}): boolean {
  if (isReadOnlyGraph || hasBendPoint || isDraggingBend) {
    return false;
  }

  if (!clickStart) {
    return true;
  }

  return (
    clickStart.connectionKey === connectionKey &&
    Math.hypot(clientX - clickStart.clientX, clientY - clickStart.clientY) <
      CONNECTION_BEND_CLICK_THRESHOLD_PX
  );
}

export function updateConnectionBendDrag({
  clientX,
  clientY,
  drag,
  point,
  shiftKey,
}: {
  clientX: number;
  clientY: number;
  drag: DraggingConnectionBend;
  point: ConnectionBendPoint;
  shiftKey: boolean;
}): DraggingConnectionBend | undefined {
  const hasMoved =
    drag.hasMoved ||
    Math.hypot(clientX - drag.startClientX, clientY - drag.startClientY) >= CONNECTION_BEND_DRAG_THRESHOLD_PX;

  if (!hasMoved) {
    return undefined;
  }

  const axisLock = resolveConnectionBendAxisLock({
    axisLock: drag.axisLock,
    point,
    shiftKey,
    startPoint: drag.startPoint,
  });

  return {
    ...drag,
    axisLock,
    hasMoved,
    point: constrainConnectionBendPointToAxisLock({ axisLock, point, startPoint: drag.startPoint }),
  };
}

function resolveConnectionBendAxisLock({
  axisLock,
  point,
  shiftKey,
  startPoint,
}: {
  axisLock: ConnectionBendAxisLock;
  point: ConnectionBendPoint;
  shiftKey: boolean;
  startPoint: ConnectionBendPoint;
}): ConnectionBendAxisLock {
  if (!shiftKey) {
    return undefined;
  }

  if (axisLock) {
    return axisLock;
  }

  const deltaX = point.x - startPoint.x;
  const deltaY = point.y - startPoint.y;
  if (deltaX === 0 && deltaY === 0) {
    return undefined;
  }

  return Math.abs(deltaX) >= Math.abs(deltaY) ? 'x' : 'y';
}

function constrainConnectionBendPointToAxisLock({
  axisLock,
  point,
  startPoint,
}: {
  axisLock: ConnectionBendAxisLock;
  point: ConnectionBendPoint;
  startPoint: ConnectionBendPoint;
}): ConnectionBendPoint {
  if (axisLock === 'x') {
    return { ...point, y: startPoint.y };
  }

  if (axisLock === 'y') {
    return { ...point, x: startPoint.x };
  }

  return point;
}

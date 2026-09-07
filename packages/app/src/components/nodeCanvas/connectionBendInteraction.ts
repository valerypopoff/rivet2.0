import type { NodeConnection } from '@valerypopoff/rivet2-core';

export type ConnectionBendPoint = NonNullable<NodeConnection['bendPoint']>;

export type ConnectionBendClickStart = {
  connectionKey: string;
  clientX: number;
  clientY: number;
};

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
    Math.hypot(clientX - clickStart.clientX, clientY - clickStart.clientY) < CONNECTION_BEND_CLICK_THRESHOLD_PX
  );
}

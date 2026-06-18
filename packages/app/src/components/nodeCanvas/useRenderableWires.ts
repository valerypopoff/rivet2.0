import { useMemo, useRef } from 'react';
import type { ChartNode, NodeConnection, NodeId, PortId } from '@valerypopoff/rivet2-core';
import { getConnectionCacheKeys, getNodePortPosition } from '../Wire.js';
import type { PortPositions } from '../NodeCanvas.js';
import { lineCrossesViewport, type LineClipRect } from '../../utils/lineClipping.js';
import { markCanvasPerfEnd, markCanvasPerfStart, setCanvasPerf } from './canvasPerfDebug.js';
import { getRenderableWireCandidates } from './getRenderableWireCandidates.js';

type CanvasPositionConverter = (x: number, y: number) => { x: number; y: number };

export function useRenderableWires({
  canvasToClientPosition,
  connections,
  draggingNode,
  draggingWire,
  highlightedNodes,
  highlightedPort,
  nearViewportNodeIdSet,
  nodesById,
  portPositions,
  runningNodeIdSet,
  visibleNodeIdSet,
  viewportClientRect,
}: {
  canvasToClientPosition: CanvasPositionConverter;
  connections: NodeConnection[];
  draggingNode: boolean;
  draggingWire: boolean;
  highlightedNodes?: NodeId[];
  highlightedPort?:
    | {
        isInput: boolean;
        nodeId: NodeId;
        portId: PortId;
      }
    | undefined;
  nearViewportNodeIdSet: ReadonlySet<NodeId>;
  nodesById: Record<NodeId, ChartNode>;
  portPositions: PortPositions;
  runningNodeIdSet: ReadonlySet<NodeId>;
  visibleNodeIdSet: ReadonlySet<NodeId>;
  viewportClientRect: LineClipRect;
}): NodeConnection[] {
  const stableRenderableWiresRef = useRef<NodeConnection[] | undefined>(undefined);
  const candidateConnections = useMemo(
    () =>
      getRenderableWireCandidates({
        connections,
        draggingNode,
        draggingWire,
        highlightedNodes,
        highlightedPort,
        nearViewportNodeIdSet,
        runningNodeIdSet,
        visibleNodeIdSet,
      }),
    [
      connections,
      draggingNode,
      draggingWire,
      highlightedNodes,
      highlightedPort,
      nearViewportNodeIdSet,
      runningNodeIdSet,
      visibleNodeIdSet,
    ],
  );
  return useMemo(() => {
    markCanvasPerfStart('WireLayer:recalculateRenderableWires');

    const nextRenderableWires = candidateConnections.filter((connection) => {
      const inputNode = nodesById[connection.inputNodeId];
      const outputNode = nodesById[connection.outputNodeId];

      if (!inputNode || !outputNode) {
        return false;
      }

      const [outputCacheKey, inputCacheKey] = getConnectionCacheKeys(connection);
      const start = getNodePortPosition(outputNode, connection.outputId, outputCacheKey, portPositions);
      const end = getNodePortPosition(inputNode, connection.inputId, inputCacheKey, portPositions);
      const wireSegments = connection.bendPoint
        ? [
            { start, end: connection.bendPoint },
            { start: connection.bendPoint, end },
          ]
        : [{ start, end }];

      return wireSegments.some((segment) =>
        lineCrossesViewport(
          canvasToClientPosition(segment.start.x, segment.start.y),
          canvasToClientPosition(segment.end.x, segment.end.y),
          viewportClientRect,
        ),
      );
    });

    setCanvasPerf('WireLayer:renderableWireCount', nextRenderableWires.length);
    markCanvasPerfEnd('WireLayer:recalculateRenderableWires');

    const stableRenderableWires =
      stableRenderableWiresRef.current && areConnectionListsEqual(stableRenderableWiresRef.current, nextRenderableWires)
        ? stableRenderableWiresRef.current
        : nextRenderableWires;

    stableRenderableWiresRef.current = stableRenderableWires;
    return stableRenderableWires;
  }, [
    canvasToClientPosition,
    candidateConnections,
    nodesById,
    portPositions,
    viewportClientRect,
  ]);
}

function areConnectionListsEqual(previous: NodeConnection[], next: NodeConnection[]): boolean {
  return previous.length === next.length && previous.every((connection, index) => connection === next[index]);
}

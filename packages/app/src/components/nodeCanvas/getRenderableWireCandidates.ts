import {
  getProjectConnectionComparisonKey,
  type NodeConnection,
  type ChartNode,
  type NodeId,
} from '@valerypopoff/rivet2-core';
import { getConnectionCacheKeys, getNodePortPosition, type PortPositions } from './wireEndpoints.js';
import { getWirePathBounds, getWireSegments, type WirePathBounds } from './wireGeometry.js';
import { markCanvasPerfEnd, markCanvasPerfStart, setCanvasPerf } from './canvasPerfDebug.js';

type WireVisibilityEntry = { connection: NodeConnection; bounds: WirePathBounds[] };
const WIRE_CLIENT_GUTTER_PX = 16;
const WIRE_DECORATION_GUTTER = 16;

/** Independent of the viewport: reuse these envelopes throughout pan/zoom. */
export function prepareWireVisibility(
  connections: readonly NodeConnection[],
  nodesById: Record<NodeId, ChartNode>,
  portPositions: PortPositions,
): WireVisibilityEntry[] {
  const entries: WireVisibilityEntry[] = [];
  for (const connection of connections) {
    const inputNode = nodesById[connection.inputNodeId];
    const outputNode = nodesById[connection.outputNodeId];
    if (!inputNode || !outputNode) continue;
    const [outputKey, inputKey] = getConnectionCacheKeys(connection);
    const start = getNodePortPosition(outputNode, connection.outputId, outputKey, portPositions);
    const end = getNodePortPosition(inputNode, connection.inputId, inputKey, portPositions);
    entries.push({
      connection,
      bounds: getWireSegments({ start, end, bendPoint: connection.bendPoint }).map((segment) =>
        getWirePathBounds({ sx: segment.start.x, sy: segment.start.y, ex: segment.end.x, ey: segment.end.y }),
      ),
    });
  }
  return entries;
}

/** Client-space allowance covers the wide hit path; canvas-space allowance covers paired lanes/markers. */
export function getWireViewportBounds(
  clientRect: WirePathBounds,
  clientToCanvasPosition: (x: number, y: number) => { x: number; y: number },
): WirePathBounds {
  const start = clientToCanvasPosition(clientRect.left - WIRE_CLIENT_GUTTER_PX, clientRect.top - WIRE_CLIENT_GUTTER_PX);
  const end = clientToCanvasPosition(
    clientRect.right + WIRE_CLIENT_GUTTER_PX,
    clientRect.bottom + WIRE_CLIENT_GUTTER_PX,
  );
  return {
    left: start.x - WIRE_DECORATION_GUTTER,
    top: start.y - WIRE_DECORATION_GUTTER,
    right: end.x + WIRE_DECORATION_GUTTER,
    bottom: end.y + WIRE_DECORATION_GUTTER,
  };
}

export function getRenderableWireCandidates({
  entries,
  viewportBounds,
  forceRenderableConnectionKeySet,
}: {
  entries: readonly WireVisibilityEntry[];
  viewportBounds: WirePathBounds;
  forceRenderableConnectionKeySet?: ReadonlySet<string>;
}): NodeConnection[] {
  markCanvasPerfStart('getRenderableWireCandidates');
  const candidates: NodeConnection[] = [];
  for (const { connection, bounds } of entries) {
    if (
      (forceRenderableConnectionKeySet?.size &&
        forceRenderableConnectionKeySet.has(getProjectConnectionComparisonKey(connection))) ||
      bounds.some(
        (bound) =>
          !(
            bound.right < viewportBounds.left ||
            bound.left > viewportBounds.right ||
            bound.bottom < viewportBounds.top ||
            bound.top > viewportBounds.bottom
          ),
      )
    )
      candidates.push(connection);
  }

  setCanvasPerf('getRenderableWireCandidates:size', candidates.length);
  markCanvasPerfEnd('getRenderableWireCandidates');

  return candidates;
}

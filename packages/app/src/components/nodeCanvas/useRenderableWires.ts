import { useMemo, useRef } from 'react';
import { type ChartNode, type NodeConnection, type NodeId } from '@valerypopoff/rivet2-core';
import type { PortPositions } from './wireEndpoints.js';
import type { WirePathBounds } from './wireGeometry.js';
import { markCanvasPerfEnd, markCanvasPerfStart, setCanvasPerf } from './canvasPerfDebug.js';
import {
  getRenderableWireCandidates,
  getWireViewportBounds,
  prepareWireVisibility,
} from './getRenderableWireCandidates.js';

type CanvasPositionConverter = (x: number, y: number) => { x: number; y: number };

export function useRenderableWires({
  clientToCanvasPosition,
  connections,
  forceRenderableConnectionKeySet,
  nodesById,
  portPositions,
  viewportClientRect,
}: {
  clientToCanvasPosition: CanvasPositionConverter;
  connections: NodeConnection[];
  forceRenderableConnectionKeySet?: ReadonlySet<string>;
  nodesById: Record<NodeId, ChartNode>;
  portPositions: PortPositions;
  viewportClientRect: WirePathBounds;
}): NodeConnection[] {
  const stableRenderableWiresRef = useRef<NodeConnection[] | undefined>(undefined);
  const entries = useMemo(
    () => prepareWireVisibility(connections, nodesById, portPositions),
    [connections, nodesById, portPositions],
  );
  return useMemo(() => {
    markCanvasPerfStart('WireLayer:recalculateRenderableWires');

    const nextRenderableWires = getRenderableWireCandidates({
      entries,
      viewportBounds: getWireViewportBounds(viewportClientRect, clientToCanvasPosition),
      forceRenderableConnectionKeySet,
    });

    setCanvasPerf('WireLayer:renderableWireCount', nextRenderableWires.length);
    markCanvasPerfEnd('WireLayer:recalculateRenderableWires');

    const stableRenderableWires =
      stableRenderableWiresRef.current && areConnectionListsEqual(stableRenderableWiresRef.current, nextRenderableWires)
        ? stableRenderableWiresRef.current
        : nextRenderableWires;

    stableRenderableWiresRef.current = stableRenderableWires;
    return stableRenderableWires;
  }, [clientToCanvasPosition, entries, forceRenderableConnectionKeySet, viewportClientRect]);
}

function areConnectionListsEqual(previous: NodeConnection[], next: NodeConnection[]): boolean {
  return previous.length === next.length && previous.every((connection, index) => connection === next[index]);
}

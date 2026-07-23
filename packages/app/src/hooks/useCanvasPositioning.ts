import { useAtomValue } from 'jotai';
import { canvasPositionState } from '../state/graphBuilder.js';
import { useCallback, useMemo } from 'react';
import { dataBusFullRowCountState, uiFontSizeState } from '../state/ui.js';
import { getUiFontScale } from '../utils/uiFontSize.js';
import { getDataBusFullRowsHeight } from '../components/nodeCanvas/dataBusRailLayout.js';

export type CanvasClientOffset = {
  x: number;
  y: number;
};

const NO_CANVAS_CLIENT_OFFSET: CanvasClientOffset = { x: 0, y: 0 };

export const canvasToClientPosition =
  (
    canvasPosition: { x: number; y: number; zoom: number },
    clientOffset: CanvasClientOffset = NO_CANVAS_CLIENT_OFFSET,
  ) =>
  (x: number, y: number) => {
    const clientX = clientOffset.x + (x + canvasPosition.x) * canvasPosition.zoom;
    const clientY = clientOffset.y + (y + canvasPosition.y) * canvasPosition.zoom;
    return { x: clientX, y: clientY };
  };

export const clientToCanvasPosition =
  (
    canvasPosition: { x: number; y: number; zoom: number },
    clientOffset: CanvasClientOffset = NO_CANVAS_CLIENT_OFFSET,
  ) =>
  (x: number, y: number) => {
    const canvasX = (x - clientOffset.x) / canvasPosition.zoom - canvasPosition.x;
    const canvasY = (y - clientOffset.y) / canvasPosition.zoom - canvasPosition.y;
    return { x: canvasX, y: canvasY };
  };

export function getCanvasPositionForZoomAtClientPoint(options: {
  canvasPosition: { x: number; y: number; zoom: number };
  clientOffset?: CanvasClientOffset;
  clientPoint: { x: number; y: number };
  newZoom: number;
}): { x: number; y: number; zoom: number } {
  const clientOffset = options.clientOffset ?? NO_CANVAS_CLIENT_OFFSET;
  const canvasPoint = clientToCanvasPosition(options.canvasPosition, clientOffset)(
    options.clientPoint.x,
    options.clientPoint.y,
  );

  return {
    x: (options.clientPoint.x - clientOffset.x) / options.newZoom - canvasPoint.x,
    y: (options.clientPoint.y - clientOffset.y) / options.newZoom - canvasPoint.y,
    zoom: options.newZoom,
  };
}

export function useCanvasPositioning() {
  const canvasPosition = useAtomValue(canvasPositionState);
  const dataBusFullRowCount = useAtomValue(dataBusFullRowCountState);
  const uiFontSize = useAtomValue(uiFontSizeState);
  const canvasClientOffset = useMemo<CanvasClientOffset>(
    () => ({
      x: 0,
      y: getDataBusFullRowsHeight({
        rowCount: dataBusFullRowCount,
        uiFontScale: getUiFontScale(uiFontSize),
      }),
    }),
    [dataBusFullRowCount, uiFontSize],
  );

  const canvasToClientPositionLocal = useCallback(
    (x: number, y: number) => canvasToClientPosition(canvasPosition, canvasClientOffset)(x, y),
    [canvasClientOffset, canvasPosition],
  );

  const clientToCanvasPositionLocal = useCallback(
    (x: number, y: number) => clientToCanvasPosition(canvasPosition, canvasClientOffset)(x, y),
    [canvasClientOffset, canvasPosition],
  );

  const getCanvasPositionForZoomAtClientPointLocal = useCallback(
    (newZoom: number, clientX: number, clientY: number) =>
      getCanvasPositionForZoomAtClientPoint({
        canvasPosition,
        clientOffset: canvasClientOffset,
        clientPoint: { x: clientX, y: clientY },
        newZoom,
      }),
    [canvasClientOffset, canvasPosition],
  );

  return {
    canvasClientOffset,
    canvasPosition,
    canvasToClientPosition: canvasToClientPositionLocal,
    clientToCanvasPosition: clientToCanvasPositionLocal,
    getCanvasPositionForZoomAtClientPoint: getCanvasPositionForZoomAtClientPointLocal,
  };
}

import { type NodeId } from '@valerypopoff/rivet2-core';
import { useStableCallback } from './useStableCallback';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { canvasPositionState } from '../state/graphBuilder';
import { graphState } from '../state/graph';
import { fitBoundsToViewport } from './useViewportBounds';
import { useCanvasPositioning } from './useCanvasPositioning.js';

export function useFocusOnNodes() {
  const setPosition = useSetAtom(canvasPositionState);
  const graph = useAtomValue(graphState);
  const { canvasClientOffset } = useCanvasPositioning();

  return useStableCallback((nodeIds: NodeId[]) => {
    const node = graph.nodes.filter((n) => nodeIds.includes(n.id))!;

    const bounds = {
      left: Math.min(...node.map((n) => n.visualData.x)) - 300,
      right: Math.max(...node.map((n) => n.visualData.x + (n.visualData.width ?? 300))) + 300,
      top: Math.min(...node.map((n) => n.visualData.y)),
      bottom: Math.max(...node.map((n) => n.visualData.y + 300)),
    };

    const boundsXY = {
      x: bounds.left,
      y: bounds.top,
      width: bounds.right - bounds.left,
      height: bounds.bottom - bounds.top,
    };

    const newBounds = fitBoundsToViewport(boundsXY, { topInset: canvasClientOffset.y });

    setPosition(newBounds);
  });
}

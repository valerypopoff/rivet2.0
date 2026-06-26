import { type ChartNode, type NodeGraph } from '@valerypopoff/rivet2-core';
import { canvasPositionState, sidebarOpenState } from '../state/graphBuilder';
import { useSetAtom, useAtomValue } from 'jotai';
import { fitBoundsToViewport } from './useViewportBounds';

export function getCanvasPositionForNodes(nodes: readonly ChartNode[], sidebarOpen: boolean) {
  if (nodes.length === 0) {
    return { x: 0, y: 0, zoom: 1 };
  }

  const minNodeX = Math.min(...nodes.map((n) => n.visualData.x));
  const maxNodeX = Math.max(...nodes.map((n) => n.visualData.x + (n.visualData.width ?? 300)));
  const minNodeY = Math.min(...nodes.map((n) => n.visualData.y));
  const maxNodeY = Math.max(...nodes.map((n) => n.visualData.y + 300));

  return fitBoundsToViewport(
    {
      x: minNodeX - 100,
      y: minNodeY - 100,
      width: maxNodeX - minNodeX + 200,
      height: maxNodeY - minNodeY + 200,
    },
    { sidebarOpen },
  );
}

export function useCenterViewOnGraph() {
  const sidebarOpen = useAtomValue(sidebarOpenState);
  const setPosition = useSetAtom(canvasPositionState);

  return (graph: NodeGraph) => {
    setPosition(getCanvasPositionForNodes(graph.nodes, sidebarOpen));
  };
}

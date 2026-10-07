import { clipboardState } from '../state/clipboard';
import { type ChartNode, type NodeConnection } from '@valerypopoff/rivet2-core';
import { useCanvasPositioning } from './useCanvasPositioning';
import { useAtomValue } from 'jotai';
import { usePasteNodesCommand } from '../commands/pasteNodesCommand.js';

export function usePasteNodes() {
  const clipboard = useAtomValue(clipboardState);
  const { clientToCanvasPosition } = useCanvasPositioning();
  const pasteNodesCommand = usePasteNodesCommand();

  const pasteNodes = (mousePosition: { x: number; y: number }) => {
    if (clipboard?.type !== 'nodes' || clipboard.nodes.length === 0) {
      return;
    }

    const canvasPosition = clientToCanvasPosition(mousePosition.x, mousePosition.y);

    pasteNodesCommand({
      nodes: clipboard.nodes as ChartNode[],
      connections: clipboard.connections as NodeConnection[],
      position: canvasPosition,
    });
  };

  return pasteNodes;
}

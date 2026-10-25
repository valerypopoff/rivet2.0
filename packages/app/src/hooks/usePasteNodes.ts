import { clipboardState } from '../state/clipboard';
import { clientToCanvasPosition, getCanvasClientOffset } from './useCanvasPositioning';
import { useStore } from 'jotai';
import { usePasteNodesCommand } from '../commands/pasteNodesCommand.js';
import { canvasPositionState } from '../state/graphBuilder.js';
import { dataBusFullRowCountState, uiFontSizeState } from '../state/ui.js';

export function usePasteNodes() {
  const store = useStore();
  const pasteNodesCommand = usePasteNodesCommand();

  const pasteNodes = (mousePosition: { x: number; y: number }) => {
    const clipboard = store.get(clipboardState);
    if (clipboard?.type !== 'nodes' || clipboard.nodes.length === 0) {
      return;
    }

    const canvasPosition = clientToCanvasPosition(
      store.get(canvasPositionState),
      getCanvasClientOffset(store.get(dataBusFullRowCountState), store.get(uiFontSizeState)),
    )(mousePosition.x, mousePosition.y);

    pasteNodesCommand({
      nodes: clipboard.nodes,
      connections: clipboard.connections,
      position: canvasPosition,
    });
  };

  return pasteNodes;
}

// Override for packages/app/src/hooks/useCopyNodesHotkeys.ts
// Keeps hosted clipboard behavior in the Studio Server host layer so the
// shared Rivet hook remains free of hosted-only behavior.

import { getDefaultStore } from 'jotai';
import {
  editingNodeState,
  hoveringNodeState,
  lastMousePositionState,
  selectedNodesState,
  canvasPositionState,
} from '../../../app/src/state/graphBuilder';
import { useEffect } from 'react';
import { connectionsState, nodesByIdState } from '../../../app/src/state/graph';
import { clipboardState } from '../../../app/src/state/clipboard';
import { clientToCanvasPosition } from '../../../app/src/hooks/useCanvasPositioning';
import { isNotNull } from '../../../app/src/utils/genericUtilFunctions';
import { useDeleteNodesCommand } from '../../../app/src/commands/deleteNodeCommand';
import { type NodeId } from '@valerypopoff/rivet2-core';
import { usePasteNodesCommand } from '../../../app/src/commands/pasteNodesCommand.js';
import { useDuplicateNodeCommand } from '../../../app/src/commands/duplicateNodeCommand.js';

type DeleteNodes = (args: { nodeIds: NodeId[] }) => void;

const matchesShortcutKey = (event: KeyboardEvent, code: string, key: string) =>
  event.code === code || event.key.toLowerCase() === key;

const isEditableElement = (element: Element | null | undefined) => {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  return ['input', 'textarea', 'select'].includes(element.tagName.toLowerCase());
};

function readCopyPasteState() {
  const store = getDefaultStore();
  return {
    selectedNodeIds: store.get(selectedNodesState),
    editingNodeId: store.get(editingNodeState),
    hoveringNodeId: store.get(hoveringNodeState),
    mousePosition: store.get(lastMousePositionState),
    canvasPosition: store.get(canvasPositionState),
    nodesById: store.get(nodesByIdState),
    connections: store.get(connectionsState),
    clipboard: store.get(clipboardState),
  };
}

function handleCopy(event: Event) {
  const store = getDefaultStore();
  const { selectedNodeIds, editingNodeId, hoveringNodeId, nodesById, connections } = readCopyPasteState();

  const fallbackNodeId = selectedNodeIds.length === 0 ? hoveringNodeId : undefined;
  if ((!fallbackNodeId && selectedNodeIds.length === 0) || editingNodeId) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const nodeIds = (
    selectedNodeIds.length > 0 ? [...new Set([...selectedNodeIds, fallbackNodeId])] : [fallbackNodeId]
  ).filter(isNotNull);

  const copiedConnections = connections.filter(
    (connection) => nodeIds.includes(connection.inputNodeId) && nodeIds.includes(connection.outputNodeId),
  );

  store.set(clipboardState, {
    type: 'nodes',
    nodes: nodeIds.map((id) => nodesById[id]).filter(isNotNull),
    connections: copiedConnections,
  });
}

function handleCut(event: Event, deleteNodes: DeleteNodes) {
  const { selectedNodeIds, editingNodeId } = readCopyPasteState();

  if (selectedNodeIds.length === 0 || editingNodeId) {
    return;
  }

  handleCopy(event);
  deleteNodes({ nodeIds: selectedNodeIds });
}

function handlePaste(event: Event, pasteNodes: ReturnType<typeof usePasteNodesCommand>) {
  const { editingNodeId, mousePosition, canvasPosition, clipboard } = readCopyPasteState();

  if (editingNodeId || clipboard?.type !== 'nodes' || clipboard.nodes.length === 0) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const toCanvas = clientToCanvasPosition(canvasPosition);
  const canvasPos = toCanvas(mousePosition.x, mousePosition.y);

  pasteNodes({ nodes: clipboard.nodes, connections: clipboard.connections, position: canvasPos });
}

export function useCopyNodesHotkeys() {
  const deleteNodes = useDeleteNodesCommand();
  const pasteNodes = usePasteNodesCommand();
  const duplicateNode = useDuplicateNodeCommand();

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        isEditableElement(document.activeElement) ||
        isEditableElement(event.target as Element | null)
      ) {
        return;
      }

      const isCopy = matchesShortcutKey(event, 'KeyC', 'c') && (event.metaKey || event.ctrlKey) && !event.shiftKey;
      if (isCopy) {
        handleCopy(event);
        return;
      }

      const isCut = matchesShortcutKey(event, 'KeyX', 'x') && (event.metaKey || event.ctrlKey) && !event.shiftKey;
      if (isCut) {
        handleCut(event, deleteNodes);
        return;
      }

      const isPaste = matchesShortcutKey(event, 'KeyV', 'v') && (event.metaKey || event.ctrlKey) && !event.shiftKey;
      if (isPaste) {
        handlePaste(event, pasteNodes);
        return;
      }

      const isDuplicate = matchesShortcutKey(event, 'KeyD', 'd') && (event.metaKey || event.ctrlKey) && !event.shiftKey;
      if (isDuplicate) {
        const { selectedNodeIds, editingNodeId, hoveringNodeId } = readCopyPasteState();
        const duplicateNodeId =
          selectedNodeIds.length === 1 ? selectedNodeIds[0] : selectedNodeIds.length === 0 ? hoveringNodeId : undefined;

        if (duplicateNodeId && !editingNodeId) {
          event.preventDefault();
          event.stopPropagation();
          duplicateNode({ nodeId: duplicateNodeId });
        }
      }
    };

    const copyListener = (event: ClipboardEvent) => {
      if (isEditableElement(document.activeElement) || isEditableElement(event.target as Element | null)) {
        return;
      }

      handleCopy(event);
    };

    const cutListener = (event: ClipboardEvent) => {
      if (isEditableElement(document.activeElement) || isEditableElement(event.target as Element | null)) {
        return;
      }

      handleCut(event, deleteNodes);
    };

    const pasteListener = (event: ClipboardEvent) => {
      if (isEditableElement(document.activeElement) || isEditableElement(event.target as Element | null)) {
        return;
      }

      handlePaste(event, pasteNodes);
    };

    window.addEventListener('keydown', listener, true);
    document.addEventListener('keydown', listener, true);
    window.addEventListener('copy', copyListener, true);
    document.addEventListener('copy', copyListener, true);
    window.addEventListener('cut', cutListener, true);
    document.addEventListener('cut', cutListener, true);
    window.addEventListener('paste', pasteListener, true);
    document.addEventListener('paste', pasteListener, true);

    return () => {
      window.removeEventListener('keydown', listener, true);
      document.removeEventListener('keydown', listener, true);
      window.removeEventListener('copy', copyListener, true);
      document.removeEventListener('copy', copyListener, true);
      window.removeEventListener('cut', cutListener, true);
      document.removeEventListener('cut', cutListener, true);
      window.removeEventListener('paste', pasteListener, true);
      document.removeEventListener('paste', pasteListener, true);
    };
  }, [deleteNodes, pasteNodes, duplicateNode]);
}

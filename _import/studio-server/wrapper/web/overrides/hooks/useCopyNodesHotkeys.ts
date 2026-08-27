// Override for rivet/packages/app/src/hooks/useCopyNodesHotkeys.ts
// Keeps hosted clipboard behavior in tracked wrapper code so prod image builds
// do not depend on local edits inside the ignored rivet/ tree.

import { getDefaultStore } from 'jotai';
import {
  editingNodeState,
  hoveringNodeState,
  lastMousePositionState,
  selectedNodesState,
  canvasPositionState,
} from '../../../../rivet/packages/app/src/state/graphBuilder';
import { useEffect } from 'react';
import { connectionsState, nodesByIdState, nodesState } from '../../../../rivet/packages/app/src/state/graph';
import { clipboardState } from '../../../../rivet/packages/app/src/state/clipboard';
import { clientToCanvasPosition } from '../../../../rivet/packages/app/src/hooks/useCanvasPositioning';
import { isNotNull } from '../../../../rivet/packages/app/src/utils/genericUtilFunctions';
import { useDeleteNodesCommand } from '../../../../rivet/packages/app/src/commands/deleteNodeCommand';
import { type NodeId, type NodeConnection, newId, globalRivetNodeRegistry } from '@valerypopoff/rivet2-core';
import { produce } from 'immer';

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
    selectedNodeIds.length > 0
      ? [...new Set([...selectedNodeIds, fallbackNodeId])]
      : [fallbackNodeId]
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

function handlePaste(event: Event) {
  const store = getDefaultStore();
  const { editingNodeId, mousePosition, canvasPosition, clipboard } = readCopyPasteState();

  if (editingNodeId || clipboard?.type !== 'nodes') {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const toCanvas = clientToCanvasPosition(canvasPosition);
  const canvasPos = toCanvas(mousePosition.x, mousePosition.y);

  const boundingBoxOfCopiedNodes = clipboard.nodes.reduce(
    (accumulator, node) => ({
      minX: Math.min(accumulator.minX, node.visualData.x),
      minY: Math.min(accumulator.minY, node.visualData.y),
      maxX: Math.max(accumulator.maxX, node.visualData.x + (node.visualData.width ?? 200)),
      maxY: Math.max(accumulator.maxY, node.visualData.y + 200),
    }),
    {
      minX: Number.MAX_SAFE_INTEGER,
      minY: Number.MAX_SAFE_INTEGER,
      maxX: Number.MIN_SAFE_INTEGER,
      maxY: Number.MIN_SAFE_INTEGER,
    },
  );

  const oldNewNodeIdMap: Record<NodeId, NodeId> = {};

  const newNodes = clipboard.nodes.map((node) =>
    produce(node, (draft) => {
      const newNodeId = newId<NodeId>();
      oldNewNodeIdMap[node.id] = newNodeId;
      draft.id = newNodeId;
      draft.visualData.x = canvasPos.x + (node.visualData.x - boundingBoxOfCopiedNodes.minX);
      draft.visualData.y = canvasPos.y + (node.visualData.y - boundingBoxOfCopiedNodes.minY);
    }),
  );

  const newConnections: NodeConnection[] = clipboard.connections
    .map((connection): NodeConnection | undefined => {
      const inputNodeId = oldNewNodeIdMap[connection.inputNodeId];
      const outputNodeId = oldNewNodeIdMap[connection.outputNodeId];
      if (!inputNodeId || !outputNodeId) {
        return undefined;
      }

      return { ...connection, inputNodeId, outputNodeId };
    })
    .filter(isNotNull);

  store.set(nodesState, (previousNodes) => [...previousNodes, ...newNodes]);
  store.set(selectedNodesState, newNodes.map((node) => node.id));
  store.set(connectionsState, (previousConnections) => [...previousConnections, ...newConnections]);
}

function handleDuplicate(nodeId: NodeId) {
  const store = getDefaultStore();
  const { nodesById } = readCopyPasteState();
  const node = nodesById[nodeId];

  if (!node) {
    return;
  }

  const newNode = globalRivetNodeRegistry.createDynamic(node.type);
  newNode.data = { ...(node.data as object) };
  newNode.visualData = {
    ...node.visualData,
    x: node.visualData.x,
    y: node.visualData.y + 200,
  };
  newNode.title = node.title;
  newNode.description = node.description;
  newNode.isSplitRun = node.isSplitRun;
  newNode.splitRunMax = node.splitRunMax;

  store.set(nodesState, (previousNodes) => [...previousNodes, newNode]);
  store.set(connectionsState, (previousConnections) => {
    const oldNodeConnections = previousConnections.filter((connection) => connection.inputNodeId === nodeId);
    const newNodeConnections = oldNodeConnections.map((connection) => ({
      ...connection,
      inputNodeId: newNode.id,
    }));
    return [...previousConnections, ...newNodeConnections];
  });
}

export function useCopyNodesHotkeys() {
  const deleteNodes = useDeleteNodesCommand();

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (isEditableElement(document.activeElement) || isEditableElement(event.target as Element | null)) {
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
        handlePaste(event);
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
          handleDuplicate(duplicateNodeId);
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

      handlePaste(event);
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
  }, [deleteNodes]);
}

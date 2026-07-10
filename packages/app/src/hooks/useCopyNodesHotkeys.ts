import { useAtomValue } from 'jotai';
import { editingNodeState, lastMousePositionState, selectedNodesState } from '../state/graphBuilder';
import { useLatest } from 'ahooks';
import { useEffect } from 'react';
import { useCopyNodes } from './useCopyNodes';
import { usePasteNodes } from './usePasteNodes';
import { useDuplicateNode } from './useDuplicateNode';
import { useDeleteNodesCommand } from '../commands/deleteNodeCommand';

function isNodeClipboardShortcutBlocked() {
  const activeElement = document.activeElement;

  if (!(activeElement instanceof HTMLElement)) {
    return false;
  }

  return ['INPUT', 'TEXTAREA'].includes(activeElement.tagName) || activeElement.isContentEditable;
}

function isNodeClipboardShortcut(e: KeyboardEvent, key: string) {
  return e.key.toLowerCase() === key && (e.metaKey || e.ctrlKey) && !e.shiftKey;
}

export function useCopyNodesHotkeys() {
  const selectedNodeIds = useAtomValue(selectedNodesState);
  const editingNodeId = useAtomValue(editingNodeState);

  const mousePosition = useAtomValue(lastMousePositionState);

  const copyNodes = useCopyNodes();
  const pasteNodes = usePasteNodes();
  const duplicateNode = useDuplicateNode();
  const deleteNodes = useDeleteNodesCommand();

  const latestListener = useLatest((e: KeyboardEvent) => {
    if (isNodeClipboardShortcutBlocked()) {
      return;
    }

    const isCopy = isNodeClipboardShortcut(e, 'c');
    if (isCopy && selectedNodeIds.length > 0 && !editingNodeId) {
      e.preventDefault();
      e.stopPropagation();

      copyNodes();
    }

    const isCut = isNodeClipboardShortcut(e, 'x');
    if (isCut && selectedNodeIds.length > 0 && !editingNodeId) {
      e.preventDefault();
      e.stopPropagation();

      copyNodes();
      deleteNodes({ nodeIds: selectedNodeIds });
    }

    const isPaste = isNodeClipboardShortcut(e, 'v');
    if (isPaste && !editingNodeId) {
      e.preventDefault();
      e.stopPropagation();

      pasteNodes({ x: mousePosition.x, y: mousePosition.y });
    }

    const isDuplicate = isNodeClipboardShortcut(e, 'd');
    if (isDuplicate && selectedNodeIds.length === 1 && !editingNodeId) {
      e.preventDefault();
      e.stopPropagation();

      const nodeId = selectedNodeIds[0]!;
      duplicateNode(nodeId);
    }
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      latestListener.current?.(e);
    };
    window.addEventListener('keydown', listener);

    return () => {
      window.removeEventListener('keydown', listener);
    };
  }, [latestListener]);
}

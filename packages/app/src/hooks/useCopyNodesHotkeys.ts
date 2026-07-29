import { useAtomValue } from 'jotai';
import { editingNodeState, lastMousePositionState, selectedNodesState } from '../state/graphBuilder';
import { useLatest } from 'ahooks';
import { useEffect } from 'react';
import { useCopyNodes } from './useCopyNodes';
import { usePasteNodes } from './usePasteNodes';
import { useDuplicateNode } from './useDuplicateNode';
import { useDeleteNodesCommand } from '../commands/deleteNodeCommand';
import { matchesKeyboardShortcut, type KeyboardShortcutEvent } from '../utils/keyboardShortcutMatcher.js';

export type NodeClipboardShortcut = 'copy' | 'cut' | 'duplicate' | 'paste';

function isNodeClipboardShortcutBlocked() {
  const activeElement = document.activeElement;

  if (!(activeElement instanceof HTMLElement)) {
    return false;
  }

  return ['INPUT', 'TEXTAREA'].includes(activeElement.tagName) || activeElement.isContentEditable;
}

const NODE_CLIPBOARD_SHORTCUTS = {
  copy: { altKey: false, codes: ['KeyC'], commandModifier: 'any-command' as const, keys: ['c'], shiftKey: false },
  cut: { altKey: false, codes: ['KeyX'], commandModifier: 'any-command' as const, keys: ['x'], shiftKey: false },
  duplicate: { altKey: false, codes: ['KeyD'], commandModifier: 'any-command' as const, keys: ['d'], shiftKey: false },
  paste: { altKey: false, codes: ['KeyV'], commandModifier: 'any-command' as const, keys: ['v'], shiftKey: false },
};

export function getNodeClipboardShortcut(event: KeyboardShortcutEvent): NodeClipboardShortcut | undefined {
  return (Object.keys(NODE_CLIPBOARD_SHORTCUTS) as NodeClipboardShortcut[]).find((shortcut) =>
    matchesKeyboardShortcut(event, NODE_CLIPBOARD_SHORTCUTS[shortcut]),
  );
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

    const shortcut = getNodeClipboardShortcut(e);
    if (shortcut === 'copy' && selectedNodeIds.length > 0 && !editingNodeId) {
      e.preventDefault();
      e.stopPropagation();

      copyNodes();
    }

    if (shortcut === 'cut' && selectedNodeIds.length > 0 && !editingNodeId) {
      e.preventDefault();
      e.stopPropagation();

      copyNodes();
      deleteNodes({ nodeIds: selectedNodeIds });
    }

    if (shortcut === 'paste' && !editingNodeId) {
      e.preventDefault();
      e.stopPropagation();

      pasteNodes({ x: mousePosition.x, y: mousePosition.y });
    }

    if (shortcut === 'duplicate' && selectedNodeIds.length === 1 && !editingNodeId) {
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

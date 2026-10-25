import { useStore } from 'jotai';
import { editingNodeState, hoveringNodeState, lastMousePositionState, selectedNodesState } from '../state/graphBuilder';
import { useLatest } from 'ahooks';
import { useEffect } from 'react';
import { useCopyNodes } from './useCopyNodes';
import { usePasteNodes } from './usePasteNodes';
import { useDuplicateNode } from './useDuplicateNode';
import { useDeleteNodesCommand } from '../commands/deleteNodeCommand';
import { clipboardState } from '../state/clipboard.js';
import { nodesState } from '../state/graph.js';
import { matchesKeyboardShortcut, type KeyboardShortcutEvent } from '../utils/keyboardShortcutMatcher.js';
import { useRivetAppHostUiConfig } from '../providers/HostUiConfigContext.js';
import { overlayOpenState } from '../state/ui.js';
import { isEditorInputLocked } from '../utils/editorInputLock.js';

export type NodeClipboardShortcut = 'copy' | 'cut' | 'duplicate' | 'paste';

function isClipboardControl(element: EventTarget | null, owner: Document) {
  const ElementType = owner.defaultView?.HTMLElement;
  if (!ElementType || !(element instanceof ElementType)) return false;
  return (
    element.isContentEditable ||
    !!element.closest('input, textarea, select, [role="textbox"], [role="dialog"], [role="alertdialog"], dialog[open]')
  );
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
  const store = useStore();
  const { nodeClipboard: policy } = useRivetAppHostUiConfig();
  const copyNodes = useCopyNodes();
  const pasteNodes = usePasteNodes();
  const duplicateNode = useDuplicateNode();
  const deleteNodes = useDeleteNodesCommand();

  const latestListener = useLatest((e: KeyboardEvent | ClipboardEvent, shortcut: NodeClipboardShortcut | undefined) => {
    const owner = document;
    if (
      !shortcut ||
      e.defaultPrevented ||
      ('isComposing' in e && e.isComposing) ||
      isEditorInputLocked(owner) ||
      store.get(overlayOpenState) !== undefined ||
      isClipboardControl(owner.activeElement, owner) ||
      e.composedPath().some((target) => isClipboardControl(target, owner))
    ) {
      return;
    }
    if (store.get(editingNodeState)) return;

    // All state is read from this editor's provider store at event time. A copy
    // followed by paste need not wait for React, and cannot use another host's store.
    const currentNodeIds = new Set(store.get(nodesState).map((node) => node.id));
    const selectedNodeIds = store.get(selectedNodesState).filter((id) => currentNodeIds.has(id));
    const hoveredNodeId = store.get(hoveringNodeState);
    const fallbackNodeId =
      policy?.useHoveredNodeFallback && hoveredNodeId && currentNodeIds.has(hoveredNodeId) ? hoveredNodeId : undefined;
    const nodeId =
      selectedNodeIds.length === 1 ? selectedNodeIds[0] : selectedNodeIds.length === 0 ? fallbackNodeId : undefined;
    const clipboard = store.get(clipboardState);
    const canHandle = {
      copy: selectedNodeIds.length > 0 || !!fallbackNodeId,
      cut: selectedNodeIds.length > 0,
      duplicate: !!nodeId,
      paste: clipboard?.type === 'nodes' && clipboard.nodes.length > 0,
    }[shortcut];
    if (!canHandle) return;

    e.preventDefault();
    e.stopPropagation();
    switch (shortcut) {
      case 'copy':
        copyNodes(selectedNodeIds.length === 0 ? fallbackNodeId : undefined);
        break;
      case 'cut':
        copyNodes();
        deleteNodes({ nodeIds: selectedNodeIds });
        break;
      case 'paste':
        pasteNodes(store.get(lastMousePositionState));
        break;
      case 'duplicate':
        duplicateNode(nodeId!);
        break;
    }
  });

  useEffect(() => {
    const capture = policy?.nativeEvents === true;
    const listener = (e: KeyboardEvent) => latestListener.current?.(e, getNodeClipboardShortcut(e));
    const copy = (e: ClipboardEvent) => latestListener.current?.(e, 'copy');
    const cut = (e: ClipboardEvent) => latestListener.current?.(e, 'cut');
    const paste = (e: ClipboardEvent) => latestListener.current?.(e, 'paste');
    // One window listener per event. Registering on document as well can apply
    // the same modifying command twice; no second dispatch or write replay.
    window.addEventListener('keydown', listener, capture);
    if (capture) {
      window.addEventListener('copy', copy, true);
      window.addEventListener('cut', cut, true);
      window.addEventListener('paste', paste, true);
    }

    return () => {
      window.removeEventListener('keydown', listener, capture);
      window.removeEventListener('copy', copy, true);
      window.removeEventListener('cut', cut, true);
      window.removeEventListener('paste', paste, true);
    };
  }, [latestListener, policy?.nativeEvents]);
}

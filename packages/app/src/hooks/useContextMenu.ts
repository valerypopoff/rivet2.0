import { useFloating, autoUpdate, shift, useMergeRefs } from '@floating-ui/react';
import { useRef, useState, useCallback, useEffect } from 'react';

export type ContextMenuData = {
  x: number;
  y: number;
  data: {
    type: string;
    element: HTMLElement;
  } | null;
};

export const createContextMenuVirtualElement = (x: number, y: number) => ({
  getBoundingClientRect: () => {
    const rect = {
      bottom: y,
      height: 0,
      left: x,
      right: x,
      top: y,
      width: 0,
      x,
      y,
      toJSON: () => rect,
    };

    return rect;
  },
});

export const useContextMenu = () => {
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuData, setContextMenuData] = useState<ContextMenuData>({ x: -3000, y: 0, data: null });

  const { refs, floatingStyles, update } = useFloating({
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [shift({ crossAxis: true })],
  });

  const handleContextMenu = useCallback(
    (event: Pick<React.MouseEvent<HTMLDivElement>, 'clientX' | 'clientY' | 'target'>) => {
      const data = getContextMenuDataFromTarget(event.target);
      refs.setReference(createContextMenuVirtualElement(event.clientX, event.clientY));

      setContextMenuData({ x: event.clientX, y: event.clientY, data });
      setShowContextMenu(true);
    },
    [refs],
  );

  useEffect(() => {
    update();
  }, [update, contextMenuData.x, contextMenuData.y]);

  useEffect(() => {
    const handleWindowMouseDown = (event: MouseEvent) => {
      // Close context menu as soon as the next outside click starts.
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setShowContextMenu(false);
      }
    };

    const handleEscapePress = (event: KeyboardEvent) => {
      // Close context menu if escape key is pressed
      if (event.key === 'Escape') {
        setShowContextMenu(false);
      }
    };

    window.addEventListener('mousedown', handleWindowMouseDown, true);
    window.addEventListener('keydown', handleEscapePress);
    return () => {
      window.removeEventListener('mousedown', handleWindowMouseDown, true);
      window.removeEventListener('keydown', handleEscapePress);
    };
  }, [contextMenuRef]);

  const setReference = useMergeRefs([refs.setReference, contextMenuRef]);
  const setFloatingMenu = useMergeRefs([refs.setFloating, contextMenuRef]);

  return {
    contextMenuRef,
    showContextMenu,
    contextMenuData,
    handleContextMenu,
    setContextMenuData,
    setShowContextMenu,
    refs: {
      ...refs,
      setReference,
    },
    setFloatingMenu,
    floatingStyles,
    update,
  };
};

type ContextMenuDomNode = {
  dataset?: {
    contextmenutype?: string;
  };
  parentElement?: ContextMenuDomNode | null;
};

const MAX_CONTEXT_MENU_TARGET_ANCESTORS = 256;

const isContextMenuDomNode = (target: unknown): target is ContextMenuDomNode =>
  target != null && typeof target === 'object' && ('dataset' in target || 'parentElement' in target);

export const getContextMenuDataFromTarget = (target: EventTarget | null): ContextMenuData['data'] | null => {
  let element: ContextMenuDomNode | null = isContextMenuDomNode(target) ? target : null;
  const visited = new Set<ContextMenuDomNode>();
  let depth = 0;

  while (element && !element.dataset?.contextmenutype) {
    if (visited.has(element) || depth >= MAX_CONTEXT_MENU_TARGET_ANCESTORS) {
      return null;
    }

    visited.add(element);
    depth += 1;
    element = element.parentElement ?? null;
  }

  return element?.dataset?.contextmenutype
    ? { type: element.dataset.contextmenutype, element: element as HTMLElement }
    : null;
};

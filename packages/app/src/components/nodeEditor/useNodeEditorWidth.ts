import { useAtom } from 'jotai';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { nodeEditorWidthState } from '../../state/ui.js';

type ResizeHandleMouseEvent = globalThis.MouseEvent;

export const DEFAULT_WIDTH_RATIO = 0.45;
export const MIN_WIDTH = 500;
export const MAX_WIDTH_RATIO = 0.5;

export function isValidWidth(width: number | null | undefined): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0;
}

export function clampNodeEditorWidth(width: number, viewportWidth: number): number {
  const maxWidth = Math.max(1, Math.round(viewportWidth * MAX_WIDTH_RATIO));
  const minWidth = Math.min(MIN_WIDTH, maxWidth);
  return Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
}

export function resolveNodeEditorWidth({
  persistedWidth,
  viewportWidth,
}: {
  persistedWidth: number | null | undefined;
  viewportWidth: number;
}): number {
  const preferredWidth = isValidWidth(persistedWidth) ? persistedWidth : viewportWidth * DEFAULT_WIDTH_RATIO;
  return clampNodeEditorWidth(preferredWidth, viewportWidth);
}

export function dragNodeEditorWidth({
  startWidth,
  startClientX,
  currentClientX,
  viewportWidth,
}: {
  startWidth: number;
  startClientX: number;
  currentClientX: number;
  viewportWidth: number;
}): number {
  return clampNodeEditorWidth(startWidth + (startClientX - currentClientX), viewportWidth);
}

export function useNodeEditorWidth() {
  const [persistedWidth, setPersistedWidth] = useAtom(nodeEditorWidthState);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartWidth = useRef<number | undefined>(undefined);
  const dragStartClientX = useRef(0);
  const viewportWidthRef = useRef(viewportWidth);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const pendingPanelWidthRef = useRef<number | undefined>(undefined);
  const resolvedWidth = resolveNodeEditorWidth({ persistedWidth, viewportWidth });
  const [panelWidth, setPanelWidth] = useState(resolvedWidth);
  const currentPanelWidthRef = useRef(panelWidth);

  currentPanelWidthRef.current = panelWidth;
  viewportWidthRef.current = viewportWidth;

  // Update the live drag width through a CSS variable so the full node editor tree
  // does not rerender on every mousemove.
  const applyPanelWidth = (width: number) => {
    containerRef.current?.style.setProperty('--node-editor-panel-width', `${width}px`);
  };

  const schedulePanelWidth = (width: number) => {
    pendingPanelWidthRef.current = width;

    if (animationFrameRef.current != null) {
      return;
    }

    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = undefined;

      if (pendingPanelWidthRef.current == null) {
        return;
      }

      applyPanelWidth(pendingPanelWidthRef.current);
      pendingPanelWidthRef.current = undefined;
    });
  };

  useLayoutEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth);
    };

    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    applyPanelWidth(resolvedWidth);
    setPanelWidth(resolvedWidth);
  }, [resolvedWidth]);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current != null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const onResizeStart = (event: ResizeHandleMouseEvent) => {
    event.preventDefault();
    dragStartWidth.current = panelWidth;
    dragStartClientX.current = event.clientX;
    setIsResizing(true);
  };

  const onResizeMove = (event: ResizeHandleMouseEvent) => {
    event.preventDefault();

    if (dragStartWidth.current == null) {
      return;
    }

    const nextPanelWidth = dragNodeEditorWidth({
      startWidth: dragStartWidth.current,
      startClientX: dragStartClientX.current,
      currentClientX: event.clientX,
      viewportWidth: viewportWidthRef.current,
    });

    currentPanelWidthRef.current = nextPanelWidth;
    schedulePanelWidth(nextPanelWidth);
  };

  const onResizeEnd = (event: ResizeHandleMouseEvent) => {
    event.preventDefault();

    const dragStart = dragStartWidth.current;
    const finalPanelWidth =
      dragStart == null
        ? currentPanelWidthRef.current
        : dragNodeEditorWidth({
            startWidth: dragStart,
            startClientX: dragStartClientX.current,
            currentClientX: event.clientX,
            viewportWidth: viewportWidthRef.current,
          });

    if (animationFrameRef.current != null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = undefined;
    }

    pendingPanelWidthRef.current = undefined;
    currentPanelWidthRef.current = finalPanelWidth;
    applyPanelWidth(finalPanelWidth);
    setPanelWidth(finalPanelWidth);
    setIsResizing(false);
    dragStartWidth.current = undefined;

    if (persistedWidth === finalPanelWidth) {
      return;
    }

    setPersistedWidth(finalPanelWidth);
  };

  return {
    containerRef,
    isResizing,
    panelWidth,
    resizeHandleProps: {
      onResizeStart,
      onResizeMove,
      onResizeEnd,
    },
  };
}

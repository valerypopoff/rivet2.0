import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TransitionEvent,
} from 'react';

const SIDEBAR_REVEAL_FALLBACK_MS = 240;
const SIDEBAR_DRAG_COLLAPSE_THRESHOLD_RATIO = 0.5;

type UseDashboardSidebarOptions = {
  maxWidth: number;
  minWidth: number;
};

export function useDashboardSidebar(options: UseDashboardSidebarOptions) {
  const {
    maxWidth,
    minWidth,
  } = options;
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarContentVisible, setSidebarContentVisible] = useState(true);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const revealTimeoutRef = useRef<number | undefined>();
  const resizeFrameRef = useRef<number | undefined>();
  const pendingResizeClientXRef = useRef<number | null>(null);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  const stopResizeRef = useRef<(() => void) | null>(null);

  const clearRevealTimeout = useCallback(() => {
    if (revealTimeoutRef.current === undefined) {
      return;
    }

    window.clearTimeout(revealTimeoutRef.current);
    revealTimeoutRef.current = undefined;
  }, []);

  const revealSidebarContent = useCallback(() => {
    clearRevealTimeout();
    setSidebarContentVisible(true);
  }, [clearRevealTimeout]);

  const scheduleSidebarContentReveal = useCallback(() => {
    clearRevealTimeout();
    revealTimeoutRef.current = window.setTimeout(revealSidebarContent, SIDEBAR_REVEAL_FALLBACK_MS);
  }, [clearRevealTimeout, revealSidebarContent]);

  const setSidebarCollapsedState = useCallback((nextCollapsed: boolean) => {
    sidebarCollapsedRef.current = nextCollapsed;
    setSidebarCollapsed(nextCollapsed);
  }, []);

  const applyResizeClientX = useCallback((clientX: number) => {
    const collapseThreshold = minWidth * SIDEBAR_DRAG_COLLAPSE_THRESHOLD_RATIO;

    if (clientX <= collapseThreshold) {
      clearRevealTimeout();
      setSidebarContentVisible(false);
      setSidebarCollapsedState(true);
      return;
    }

    setSidebarWidth(Math.min(maxWidth, Math.max(minWidth, clientX)));

    if (sidebarCollapsedRef.current) {
      clearRevealTimeout();
      setSidebarContentVisible(true);
      setSidebarCollapsedState(false);
    }
  }, [clearRevealTimeout, maxWidth, minWidth, setSidebarCollapsedState]);

  const flushPendingResize = useCallback(() => {
    if (resizeFrameRef.current !== undefined) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = undefined;
    }

    const clientX = pendingResizeClientXRef.current;
    pendingResizeClientXRef.current = null;

    if (clientX != null) {
      applyResizeClientX(clientX);
    }
  }, [applyResizeClientX]);

  const scheduleResize = useCallback((clientX: number) => {
    pendingResizeClientXRef.current = clientX;

    if (resizeFrameRef.current !== undefined) {
      return;
    }

    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = undefined;
      flushPendingResize();
    });
  }, [flushPendingResize]);

  useEffect(() => {
    sidebarCollapsedRef.current = sidebarCollapsed;
  }, [sidebarCollapsed]);

  useEffect(() => () => {
    clearRevealTimeout();
    stopResizeRef.current?.();
    if (resizeFrameRef.current !== undefined) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = undefined;
    }
  }, [clearRevealTimeout]);

  const handleSidebarTransitionEnd = useCallback((event: TransitionEvent<HTMLElement>) => {
    if (event.currentTarget !== event.target || sidebarCollapsed) {
      return;
    }

    if (event.propertyName !== 'width' && event.propertyName !== 'flex-basis') {
      return;
    }

    revealSidebarContent();
  }, [revealSidebarContent, sidebarCollapsed]);

  const handleToggleSidebar = useCallback(() => {
    if (sidebarCollapsed) {
      setSidebarContentVisible(false);
      setSidebarCollapsedState(false);
      scheduleSidebarContentReveal();
      return;
    }

    clearRevealTimeout();
    setSidebarContentVisible(false);
    setSidebarCollapsedState(true);
  }, [clearRevealTimeout, scheduleSidebarContentReveal, setSidebarCollapsedState, sidebarCollapsed]);

  const finishResize = useCallback(() => {
    flushPendingResize();
    setSidebarResizing(false);

    if (!sidebarCollapsedRef.current) {
      setSidebarContentVisible(true);
    }
  }, [flushPendingResize]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    stopResizeRef.current?.();

    const pointerId = event.pointerId;
    const resizeTarget = event.currentTarget;
    const ownerWindow = resizeTarget.ownerDocument.defaultView ?? window;
    let stopped = false;

    const cleanup = () => {
      ownerWindow.removeEventListener('pointermove', handlePointerMove);
      ownerWindow.removeEventListener('pointerup', handlePointerEnd);
      ownerWindow.removeEventListener('pointercancel', handlePointerEnd);
      ownerWindow.removeEventListener('blur', stopResize);
      if (resizeTarget.hasPointerCapture(pointerId)) {
        resizeTarget.releasePointerCapture(pointerId);
      }
      stopResizeRef.current = null;
    };

    const stopResize = () => {
      if (stopped) {
        return;
      }

      stopped = true;
      cleanup();
      finishResize();
    };

    function handlePointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      moveEvent.preventDefault();
      scheduleResize(moveEvent.clientX);
    }

    function handlePointerEnd(endEvent: PointerEvent) {
      if (endEvent.pointerId !== pointerId) {
        return;
      }

      endEvent.preventDefault();
      stopResize();
    }

    stopResizeRef.current = stopResize;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSidebarResizing(true);
    scheduleResize(event.clientX);
    ownerWindow.addEventListener('pointermove', handlePointerMove);
    ownerWindow.addEventListener('pointerup', handlePointerEnd);
    ownerWindow.addEventListener('pointercancel', handlePointerEnd);
    ownerWindow.addEventListener('blur', stopResize);
  }, [finishResize, scheduleResize]);

  const handleResizeMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || stopResizeRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const ownerWindow = event.currentTarget.ownerDocument.defaultView ?? window;
    let stopped = false;

    const cleanup = () => {
      ownerWindow.removeEventListener('mousemove', handleMouseMove);
      ownerWindow.removeEventListener('mouseup', handleMouseEnd);
      ownerWindow.removeEventListener('blur', stopResize);
      stopResizeRef.current = null;
    };

    const stopResize = () => {
      if (stopped) {
        return;
      }

      stopped = true;
      cleanup();
      finishResize();
    };

    function handleMouseMove(moveEvent: MouseEvent) {
      moveEvent.preventDefault();
      scheduleResize(moveEvent.clientX);
    }

    function handleMouseEnd(endEvent: MouseEvent) {
      endEvent.preventDefault();
      stopResize();
    }

    stopResizeRef.current = stopResize;
    setSidebarResizing(true);
    scheduleResize(event.clientX);
    ownerWindow.addEventListener('mousemove', handleMouseMove);
    ownerWindow.addEventListener('mouseup', handleMouseEnd);
    ownerWindow.addEventListener('blur', stopResize);
  }, [finishResize, scheduleResize]);

  return {
    handleResizeMouseDown,
    handleResizePointerDown,
    handleSidebarTransitionEnd,
    handleToggleSidebar,
    sidebarCollapsed,
    sidebarContentVisible,
    sidebarResizing,
    sidebarWidth,
  };
}

import { type RefObject, useLayoutEffect, useMemo, useState } from 'react';
import { useCanvasPositioning } from './useCanvasPositioning.js';
import { type CanvasPosition } from '../state/graphBuilder.js';
import type { CanvasClientOffset } from './useCanvasPositioning.js';

interface ViewportClientRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  clientRect: ViewportClientRect;
}

export const MAX_AUTO_FIT_ZOOM = 1;

function areViewportClientRectsEqual(previous: ViewportClientRect, next: ViewportClientRect): boolean {
  return (
    previous.left === next.left &&
    previous.top === next.top &&
    previous.right === next.right &&
    previous.bottom === next.bottom
  );
}

function getDocumentViewportRect(canvasClientOffset: CanvasClientOffset): ViewportClientRect {
  const width =
    typeof document !== 'undefined' && document.documentElement.clientWidth > 0
      ? document.documentElement.clientWidth
      : typeof window !== 'undefined'
        ? window.innerWidth
        : 0;
  const height =
    typeof document !== 'undefined' && document.documentElement.clientHeight > 0
      ? document.documentElement.clientHeight
      : typeof window !== 'undefined'
        ? window.innerHeight
        : 0;

  return {
    left: canvasClientOffset.x,
    top: canvasClientOffset.y,
    right: width,
    bottom: height,
  };
}

function getViewportClientRect(
  element: HTMLElement | null | undefined,
  canvasClientOffset: CanvasClientOffset,
): ViewportClientRect {
  if (element) {
    const bounds = element.getBoundingClientRect();
    const width = element.clientWidth || bounds.width;
    const height = element.clientHeight || bounds.height;

    if (width > 0 && height > 0) {
      return {
        left: bounds.left,
        top: bounds.top,
        right: bounds.left + width,
        bottom: bounds.top + height,
      };
    }
  }

  return getDocumentViewportRect(canvasClientOffset);
}

export function useViewportBounds(viewportRootRef?: RefObject<HTMLElement | null>): ViewportBounds {
  const { canvasClientOffset, clientToCanvasPosition } = useCanvasPositioning();

  const [clientRect, setClientRect] = useState(() =>
    getViewportClientRect(viewportRootRef?.current, canvasClientOffset),
  );

  useLayoutEffect(() => {
    let animationFrame: number | undefined;
    let resizeObserver: ResizeObserver | undefined;

    const readAndStoreClientRect = () => {
      animationFrame = undefined;
      const nextClientRect = getViewportClientRect(viewportRootRef?.current, canvasClientOffset);

      setClientRect((previousClientRect) =>
        areViewportClientRectsEqual(previousClientRect, nextClientRect) ? previousClientRect : nextClientRect,
      );
    };

    const scheduleRead = () => {
      if (animationFrame !== undefined) {
        return;
      }

      animationFrame = window.requestAnimationFrame(readAndStoreClientRect);
    };

    scheduleRead();
    window.addEventListener('resize', scheduleRead);
    window.visualViewport?.addEventListener('resize', scheduleRead);

    if (typeof ResizeObserver !== 'undefined') {
      const observedElement = viewportRootRef?.current ?? document.documentElement;
      resizeObserver = new ResizeObserver(scheduleRead);
      resizeObserver.observe(observedElement);
    }

    return () => {
      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
      }

      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleRead);
      window.visualViewport?.removeEventListener('resize', scheduleRead);
    };
  }, [canvasClientOffset, viewportRootRef]);

  const bounds = useMemo(() => {
    const topLeft = clientToCanvasPosition(clientRect.left, clientRect.top);
    const bottomRight = clientToCanvasPosition(clientRect.right, clientRect.bottom);

    return {
      left: topLeft.x,
      top: topLeft.y,
      right: bottomRight.x,
      bottom: bottomRight.y,
      clientRect,
    };
  }, [clientRect, clientToCanvasPosition]);

  return bounds;
}

export function fitBoundsToViewport(
  nodeBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  },
  options: { sidebarOpen?: boolean; topInset?: number } = {},
): CanvasPosition {
  const viewportWidth = options.sidebarOpen ? window.innerWidth - 300 : window.innerWidth;
  const viewportHeight = Math.max(1, window.innerHeight - Math.max(0, options.topInset ?? 0));

  // Calculate the required zoom level
  const zoomX = viewportWidth / nodeBounds.width;
  const zoomY = viewportHeight / nodeBounds.height;
  const zoom = Math.min(zoomX, zoomY, MAX_AUTO_FIT_ZOOM);

  // Calculate the required position
  let x = -nodeBounds.x + (viewportWidth - nodeBounds.width * zoom) / (2 * zoom);
  const y = -nodeBounds.y + (viewportHeight - nodeBounds.height * zoom) / (2 * zoom);

  if (options.sidebarOpen) {
    x += 300 / zoom;
  }

  return { x, y, zoom };
}

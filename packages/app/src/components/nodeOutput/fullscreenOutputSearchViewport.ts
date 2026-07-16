export type FullscreenOutputSearchVisibilityMetrics = {
  targetTop: number;
  targetBottom: number;
  viewportTop: number;
  viewportBottom: number;
};

/** Centers an out-of-view target without chasing oversized content. */
export function getFullscreenOutputSearchScrollDelta(metrics: FullscreenOutputSearchVisibilityMetrics): number {
  const viewportHeight = metrics.viewportBottom - metrics.viewportTop;
  if (viewportHeight <= 0) {
    return 0;
  }

  if (metrics.targetBottom - metrics.targetTop >= viewportHeight) {
    return metrics.targetTop - metrics.viewportTop;
  }

  const targetIsOutsideViewport =
    metrics.targetTop < metrics.viewportTop || metrics.targetBottom > metrics.viewportBottom;
  if (!targetIsOutsideViewport) {
    return 0;
  }

  const targetCenter = (metrics.targetTop + metrics.targetBottom) / 2;
  const viewportCenter = (metrics.viewportTop + metrics.viewportBottom) / 2;
  return targetCenter - viewportCenter;
}

/**
 * Re-run after layout and Monaco's internal scroll have settled. A single frame
 * is not enough when decorations trigger a Monaco relayout before the modal's
 * scroll container receives its final target coordinates.
 */
export function scheduleFullscreenOutputSearchTargetReveal(getTarget: () => HTMLElement | null): () => void {
  const initialTarget = getTarget();
  const ownerWindow = initialTarget?.ownerDocument.defaultView ?? (typeof window === 'undefined' ? undefined : window);

  if (!ownerWindow) {
    if (initialTarget) {
      ensureFullscreenOutputSearchTargetVisible(initialTarget);
    }
    return () => undefined;
  }

  let cancelled = false;
  let secondFrame: number | undefined;

  const reveal = () => {
    if (cancelled) {
      return;
    }

    const target = getTarget();
    if (target) {
      ensureFullscreenOutputSearchTargetVisible(target);
    }
  };

  const firstFrame = ownerWindow.requestAnimationFrame(() => {
    secondFrame = ownerWindow.requestAnimationFrame(reveal);
  });

  return () => {
    cancelled = true;
    if (firstFrame !== undefined) {
      ownerWindow.cancelAnimationFrame(firstFrame);
    }
    if (secondFrame !== undefined) {
      ownerWindow.cancelAnimationFrame(secondFrame);
    }
  };
}

export function ensureFullscreenOutputSearchTargetVisible(target: HTMLElement): void {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) {
    return;
  }

  const scrollContainer = findFullscreenOutputScrollContainer(target);
  const containerRect = getScrollContainerRect(scrollContainer, ownerWindow);
  const stickyHeader = findFullscreenOutputStickyHeader(target);
  const stickyHeaderRect = stickyHeader?.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (containerRect.height <= 0 || (targetRect.width === 0 && targetRect.height === 0)) {
    return;
  }

  const viewportTop = Math.max(
    containerRect.top,
    stickyHeaderRect && stickyHeaderRect.bottom > containerRect.top ? stickyHeaderRect.bottom : containerRect.top,
  );
  const delta = getFullscreenOutputSearchScrollDelta({
    targetTop: targetRect.top,
    targetBottom: targetRect.bottom,
    viewportTop,
    viewportBottom: containerRect.bottom,
  });

  if (delta === 0) {
    return;
  }

  if (isWindowScrollContainer(scrollContainer, ownerWindow)) {
    const currentScrollTop = getWindowScrollTop(ownerWindow);
    const maxScrollTop = Math.max(0, ownerWindow.document.documentElement.scrollHeight - ownerWindow.innerHeight);
    ownerWindow.scrollTo({
      top: Math.min(maxScrollTop, Math.max(0, currentScrollTop + delta)),
      behavior: 'auto',
    });
    return;
  }

  const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
  scrollContainer.scrollTop = Math.min(maxScrollTop, Math.max(0, scrollContainer.scrollTop + delta));
}

export function findFullscreenOutputScrollContainer(element: HTMLElement): HTMLElement | Window {
  const documentBody = element.ownerDocument.body;
  let current = element.parentElement;

  while (current && current !== documentBody) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(current);
    if (style && isScrollableOverflow(style.overflowY)) {
      return current;
    }

    current = current.parentElement;
  }

  return element.ownerDocument.defaultView ?? element;
}

function findFullscreenOutputStickyHeader(element: HTMLElement): HTMLElement | undefined {
  const outputBody = element.closest<HTMLElement>('.fullscreen-output-body');
  const outputRoot = outputBody?.parentElement;
  if (!outputRoot) {
    return undefined;
  }

  return Array.from(outputRoot.children).find((child) => child.classList.contains('fullscreen-header')) as
    | HTMLElement
    | undefined;
}

function getScrollContainerRect(scrollContainer: HTMLElement | Window, ownerWindow: Window): DOMRect {
  if (isWindowScrollContainer(scrollContainer, ownerWindow)) {
    return new DOMRect(0, 0, ownerWindow.innerWidth, ownerWindow.innerHeight);
  }

  return scrollContainer.getBoundingClientRect();
}

function isWindowScrollContainer(
  scrollContainer: HTMLElement | Window,
  ownerWindow: Window,
): scrollContainer is Window {
  return scrollContainer === ownerWindow;
}

function getWindowScrollTop(ownerWindow: Window): number {
  return (
    ownerWindow.scrollY || ownerWindow.document.documentElement.scrollTop || ownerWindow.document.body.scrollTop || 0
  );
}

function isScrollableOverflow(overflowValue: string): boolean {
  return overflowValue === 'auto' || overflowValue === 'scroll' || overflowValue === 'overlay';
}

import { type RefObject, useEffect, useRef } from 'react';
import { OUTPUT_NAVIGATION_ITEM_SELECTOR } from '../renderDataValue/outputNavigationItems.js';
import { findFullscreenOutputScrollContainer } from './fullscreenOutputSearchViewport.js';

export type FullscreenOutputScrollKey = 'PageDown' | 'PageUp' | 'Home' | 'End';

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

export type FullscreenOutputKeyboardScrollTargetOptions = {
  key: FullscreenOutputScrollKey;
  itemTopOffsets: readonly number[];
  currentScrollTop: number;
  maxScrollTop: number;
  stickyHeaderHeight: number;
};

type FullscreenOutputScrollContainerMetrics = {
  top: number;
  scrollTop: number;
  maxScrollTop: number;
};

const KEYBOARD_SCROLL_ANIMATION_DURATION_MS = 180;

type FullscreenOutputScrollAnimator = {
  cancel: () => void;
  getIntendedScrollTop: (currentScrollTop: number, maxScrollTop: number) => number;
  scrollTo: (targetScrollTop: number, currentScrollTop: number) => void;
};

type FullscreenOutputKeyboardNavigationBinding = {
  outputBody: HTMLElement;
  navigationRoot: HTMLElement;
  dispose: () => void;
};

/**
 * Resolves a keyboard scroll target without depending on DOM layout. PgUp and
 * PgDn select only semantic response boundaries: they never fall back to
 * browser-sized pixel scrolling or jump to a boundary when no next item exists.
 */
export function getFullscreenOutputKeyboardScrollTarget({
  key,
  itemTopOffsets,
  currentScrollTop,
  maxScrollTop,
  stickyHeaderHeight,
}: FullscreenOutputKeyboardScrollTargetOptions): number {
  const boundedMaxScrollTop = Math.max(0, maxScrollTop);
  const boundedCurrentScrollTop = clampScrollTop(currentScrollTop, boundedMaxScrollTop);

  if (key === 'Home') {
    return 0;
  }

  if (key === 'End') {
    return boundedMaxScrollTop;
  }

  const visibleContentTop = boundedCurrentScrollTop + Math.max(0, stickyHeaderHeight);
  const sortedItemTopOffsets = [...new Set(itemTopOffsets.filter(Number.isFinite))].sort((left, right) => left - right);

  if (key === 'PageDown') {
    const nextItemTopOffset = sortedItemTopOffsets.find((itemTopOffset) => itemTopOffset > visibleContentTop + 1);
    return nextItemTopOffset === undefined
      ? boundedCurrentScrollTop
      : clampScrollTop(nextItemTopOffset - stickyHeaderHeight, boundedMaxScrollTop);
  }

  const previousItemTopOffset = sortedItemTopOffsets.findLast(
    (itemTopOffset) => itemTopOffset < visibleContentTop - 1,
  );
  return previousItemTopOffset === undefined
    ? boundedCurrentScrollTop
    : clampScrollTop(previousItemTopOffset - stickyHeaderHeight, boundedMaxScrollTop);
}

export function isFullscreenOutputScrollKey(key: string): key is FullscreenOutputScrollKey {
  return key === 'PageDown' || key === 'PageUp' || key === 'Home' || key === 'End';
}

/**
 * Captures keys from every fullscreen-modal control while keeping the real
 * modal scroll surface as the scroll owner. The sticky pager can hold focus,
 * so registering only on that scroll surface would make its keys intermittent.
 */
export function installFullscreenOutputKeyboardNavigation(
  outputBody: HTMLElement,
  navigationRoot: HTMLElement,
): () => void {
  const ownerWindow = outputBody.ownerDocument.defaultView;
  if (!ownerWindow) {
    return () => undefined;
  }

  const scrollContainer = findFullscreenOutputScrollContainer(outputBody);
  const scrollAnimator = createFullscreenOutputScrollAnimator(scrollContainer, ownerWindow);
  const handleKeyDown: EventListener = (event) => {
    if (!isKeyboardEvent(event) || !shouldHandleFullscreenOutputScrollKey(event)) {
      return;
    }

    const metrics = getScrollContainerMetrics(scrollContainer, ownerWindow);
    const currentScrollTop = scrollAnimator.getIntendedScrollTop(metrics.scrollTop, metrics.maxScrollTop);
    const targetScrollTop = getFullscreenOutputKeyboardScrollTarget({
      key: event.key,
      itemTopOffsets: getFullscreenOutputNavigationItemTopOffsets(outputBody, metrics),
      currentScrollTop,
      maxScrollTop: metrics.maxScrollTop,
      stickyHeaderHeight: getFullscreenOutputStickyHeaderHeight(outputBody, metrics.top),
    });

    event.preventDefault();
    event.stopPropagation();
    scrollAnimator.scrollTo(targetScrollTop, metrics.scrollTop);
  };

  const cancelScrollAnimation: EventListener = () => scrollAnimator.cancel();

  navigationRoot.addEventListener('keydown', handleKeyDown, true);
  navigationRoot.addEventListener('pointerdown', cancelScrollAnimation, true);
  navigationRoot.addEventListener('touchstart', cancelScrollAnimation, true);
  navigationRoot.addEventListener('wheel', cancelScrollAnimation, true);
  return () => {
    navigationRoot.removeEventListener('keydown', handleKeyDown, true);
    navigationRoot.removeEventListener('pointerdown', cancelScrollAnimation, true);
    navigationRoot.removeEventListener('touchstart', cancelScrollAnimation, true);
    navigationRoot.removeEventListener('wheel', cancelScrollAnimation, true);
    scrollAnimator.cancel();
  };
}

/** Focuses the modal root so keys work immediately after opening it. */
export function useFullscreenOutputKeyboardNavigation(
  outputBodyRef: RefObject<HTMLElement>,
  navigationRootRef: RefObject<HTMLElement>,
): void {
  const navigationBindingRef = useRef<FullscreenOutputKeyboardNavigationBinding | undefined>(undefined);
  const focusedNavigationRootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const outputBody = outputBodyRef.current;
    const navigationRoot = navigationRootRef.current;
    const existingBinding = navigationBindingRef.current;
    if (existingBinding?.outputBody === outputBody && existingBinding.navigationRoot === navigationRoot) {
      return undefined;
    }

    existingBinding?.dispose();
    navigationBindingRef.current =
      outputBody && navigationRoot
        ? {
            outputBody,
            navigationRoot,
            dispose: installFullscreenOutputKeyboardNavigation(outputBody, navigationRoot),
          }
        : undefined;
  });

  useEffect(
    () => () => {
      navigationBindingRef.current?.dispose();
      navigationBindingRef.current = undefined;
    },
    [],
  );

  useEffect(() => {
    const root = navigationRootRef.current;
    const ownerWindow = root?.ownerDocument.defaultView;
    if (!root) {
      focusedNavigationRootRef.current = null;
      return undefined;
    }

    if (!ownerWindow || root === focusedNavigationRootRef.current) {
      return undefined;
    }

    focusedNavigationRootRef.current = root;
    if (root.contains(root.ownerDocument.activeElement)) {
      return undefined;
    }

    // Do not cancel this frame during a normal effect refresh: React Strict
    // Mode deliberately replays effects, and a detached root is harmlessly
    // rejected below. The identity guard makes this a once-per-mount focus.
    ownerWindow.requestAnimationFrame(() => {
      if (root.isConnected && !root.contains(root.ownerDocument.activeElement)) {
        root.focus({ preventScroll: true });
      }
    });
  });
}

export function getFullscreenOutputNavigationItemTopOffsets(
  outputBody: HTMLElement,
  scrollContainerMetrics: Pick<FullscreenOutputScrollContainerMetrics, 'top' | 'scrollTop'>,
): number[] {
  const semanticItems = Array.from(outputBody.querySelectorAll<HTMLElement>(OUTPUT_NAVIGATION_ITEM_SELECTOR));
  const isVisibleInOutput = (item: HTMLElement) => isVisibleOutputItem(item, outputBody);
  const leafItems = semanticItems.filter(
    (item) => !Array.from(item.querySelectorAll<HTMLElement>(OUTPUT_NAVIGATION_ITEM_SELECTOR)).some(isVisibleInOutput),
  );
  const items = leafItems.filter(isVisibleInOutput);
  const fallbackItems =
    items.length > 0
      ? items
      : Array.from(outputBody.children).filter((child) => isVisibleInOutput(child as HTMLElement));

  return fallbackItems.map(
    (item) => scrollContainerMetrics.scrollTop + item.getBoundingClientRect().top - scrollContainerMetrics.top,
  );
}

function shouldHandleFullscreenOutputScrollKey(event: KeyboardEvent): event is KeyboardEvent & { key: FullscreenOutputScrollKey } {
  return (
    isFullscreenOutputScrollKey(event.key) &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.isComposing &&
    !isEditableOutputKeyboardTarget(event.target)
  );
}

function isEditableOutputKeyboardTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (typeof element?.closest !== 'function') {
    return false;
  }

  if (element.closest('textarea, select, [role="textbox"], .monaco-editor') != null) {
    return true;
  }

  const contentEditableHost = element.closest<HTMLElement>('[contenteditable]');
  if (contentEditableHost && contentEditableHost.getAttribute('contenteditable') !== 'false') {
    return true;
  }

  const input = element.closest<HTMLInputElement>('input');
  return input != null && !isNonTextInput(input);
}

function isNonTextInput(input: HTMLInputElement): boolean {
  return NON_TEXT_INPUT_TYPES.has(input.type);
}

/**
 * Treat a marker as unavailable only when the output itself hides it, such as
 * a closed collapsible section. App-shell viewport clipping is intentionally
 * outside this boundary: off-screen items are the PageUp/PageDown targets.
 */
function isVisibleOutputItem(item: HTMLElement, outputBody: HTMLElement): boolean {
  const rect = item.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) {
    return false;
  }

  const ownerWindow = item.ownerDocument.defaultView;
  for (let ancestor: HTMLElement | null = item; ancestor; ancestor = ancestor.parentElement) {
    const style = ownerWindow?.getComputedStyle(ancestor);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') {
      return false;
    }

    if (style && clipsVerticalOverflow(style.overflowY) && !rectanglesIntersect(rect, ancestor.getBoundingClientRect())) {
      return false;
    }

    if (ancestor === outputBody) {
      break;
    }
  }

  return true;
}

function getScrollContainerMetrics(
  scrollContainer: HTMLElement | Window,
  ownerWindow: Window,
): FullscreenOutputScrollContainerMetrics {
  if (isWindowScrollContainer(scrollContainer, ownerWindow)) {
    const documentElement = ownerWindow.document.documentElement;
    const scrollTop = ownerWindow.scrollY || documentElement.scrollTop || ownerWindow.document.body.scrollTop || 0;
    return {
      top: 0,
      scrollTop,
      maxScrollTop: Math.max(0, documentElement.scrollHeight - ownerWindow.innerHeight),
    };
  }

  return {
    top: scrollContainer.getBoundingClientRect().top,
    scrollTop: scrollContainer.scrollTop,
    maxScrollTop: Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight),
  };
}

function getFullscreenOutputStickyHeaderHeight(outputBody: HTMLElement, scrollContainerTop: number): number {
  const header = outputBody.parentElement?.querySelector<HTMLElement>(':scope > .fullscreen-header');
  return header ? Math.max(0, header.getBoundingClientRect().bottom - scrollContainerTop) : 0;
}

function createFullscreenOutputScrollAnimator(
  scrollContainer: HTMLElement | Window,
  ownerWindow: Window,
): FullscreenOutputScrollAnimator {
  let animationFrame: number | undefined;
  let animationId = 0;
  let intendedScrollTop: number | undefined;

  const cancel = () => {
    animationId += 1;
    if (animationFrame !== undefined) {
      ownerWindow.cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
    intendedScrollTop = undefined;
  };

  return {
    cancel,
    getIntendedScrollTop: (currentScrollTop, maxScrollTop) =>
      intendedScrollTop === undefined ? currentScrollTop : clampScrollTop(intendedScrollTop, maxScrollTop),
    scrollTo: (targetScrollTop, currentScrollTop) => {
      cancel();
      if (Math.abs(targetScrollTop - currentScrollTop) < 1 || typeof ownerWindow.requestAnimationFrame !== 'function') {
        setScrollTopImmediately(scrollContainer, ownerWindow, targetScrollTop);
        return;
      }

      intendedScrollTop = targetScrollTop;
      const currentAnimationId = animationId;
      let startedAt: number | undefined;
      const animate = (timestamp: number) => {
        if (animationId !== currentAnimationId) {
          return;
        }

        startedAt ??= timestamp;
        const progress = Math.min(1, (timestamp - startedAt) / KEYBOARD_SCROLL_ANIMATION_DURATION_MS);
        const easedProgress = 1 - (1 - progress) ** 3;
        setScrollTopImmediately(
          scrollContainer,
          ownerWindow,
          currentScrollTop + (targetScrollTop - currentScrollTop) * easedProgress,
        );

        if (progress < 1) {
          animationFrame = ownerWindow.requestAnimationFrame(animate);
          return;
        }

        animationFrame = undefined;
        intendedScrollTop = undefined;
      };

      animationFrame = ownerWindow.requestAnimationFrame(animate);
    },
  };
}

function setScrollTopImmediately(scrollContainer: HTMLElement | Window, ownerWindow: Window, targetScrollTop: number): void {
  if (isWindowScrollContainer(scrollContainer, ownerWindow)) {
    ownerWindow.scrollTo({ top: targetScrollTop, behavior: 'auto' });
    return;
  }

  scrollContainer.scrollTop = targetScrollTop;
}

function clampScrollTop(scrollTop: number, maxScrollTop: number): number {
  return Math.min(maxScrollTop, Math.max(0, scrollTop));
}

function isKeyboardEvent(event: Event): event is KeyboardEvent {
  return 'key' in event && typeof event.key === 'string';
}

function isWindowScrollContainer(
  scrollContainer: HTMLElement | Window,
  ownerWindow: Window,
): scrollContainer is Window {
  return scrollContainer === ownerWindow;
}

function clipsVerticalOverflow(overflowY: string): boolean {
  return overflowY === 'clip' || overflowY === 'hidden';
}

function rectanglesIntersect(first: DOMRect, second: DOMRect): boolean {
  return first.bottom > second.top && first.top < second.bottom;
}

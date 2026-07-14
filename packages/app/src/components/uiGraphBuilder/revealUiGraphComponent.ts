import type { UiComponentId } from '@valerypopoff/rivet2-core';

const COMPONENT_SELECTOR = '[data-ui-graph-component-id]';
const BUILDER_INTERACTION_SELECTOR = `${COMPONENT_SELECTOR}, [data-ui-graph-builder-owned-portal]`;
const REVEAL_PADDING = 16;

type UiGraphComponentRevealPosition = {
  componentHeight: number;
  componentTop: number;
  scrollTop: number;
  viewportHeight: number;
};

export function isUiGraphComponentEventTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return typeof element?.closest === 'function' && element.closest(BUILDER_INTERACTION_SELECTOR) != null;
}

export function getUiGraphComponentRevealScrollTop({
  componentHeight,
  componentTop,
  scrollTop,
  viewportHeight,
}: UiGraphComponentRevealPosition): number | undefined {
  const visibleTop = scrollTop + REVEAL_PADDING;
  const visibleBottom = scrollTop + viewportHeight - REVEAL_PADDING;

  if (componentHeight > viewportHeight - REVEAL_PADDING * 2) {
    return componentTop < visibleTop || componentTop > visibleBottom
      ? Math.max(0, componentTop - REVEAL_PADDING)
      : undefined;
  }

  if (componentTop < visibleTop) {
    return Math.max(0, componentTop - REVEAL_PADDING);
  }

  const componentBottom = componentTop + componentHeight;
  if (componentBottom > visibleBottom) {
    return Math.max(0, componentBottom - viewportHeight + REVEAL_PADDING);
  }

  return undefined;
}

export function revealUiGraphComponent(scrollContainer: HTMLElement | null, componentId: UiComponentId): void {
  if (!scrollContainer || scrollContainer.clientHeight <= 0) {
    return;
  }

  const component = Array.from(scrollContainer.querySelectorAll<HTMLElement>(COMPONENT_SELECTOR)).find(
    (element) => element.dataset.uiGraphComponentId === componentId,
  );
  if (!component) {
    return;
  }

  const containerRect = scrollContainer.getBoundingClientRect();
  const componentRect = component.getBoundingClientRect();
  const nextScrollTop = getUiGraphComponentRevealScrollTop({
    componentHeight: componentRect.height,
    componentTop: scrollContainer.scrollTop + componentRect.top - containerRect.top,
    scrollTop: scrollContainer.scrollTop,
    viewportHeight: scrollContainer.clientHeight,
  });

  if (nextScrollTop != null) {
    scrollContainer.scrollTop = nextScrollTop;
  }
}

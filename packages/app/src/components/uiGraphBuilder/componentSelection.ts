import type { UiComponentId } from '@valerypopoff/rivet2-core';

export type UiGraphComponentSelectionMode = 'replace' | 'toggle';

export type UiGraphComponentSelectionRectangle = {
  currentX: number;
  currentY: number;
  startX: number;
  startY: number;
};

type UiGraphComponentSelectionCandidate = {
  id: UiComponentId;
  rect: {
    bottom: number;
    left: number;
    right: number;
    top: number;
  };
};

export function selectUiGraphComponent(
  selectedComponentIds: readonly UiComponentId[],
  componentId: UiComponentId,
  mode: UiGraphComponentSelectionMode,
): UiComponentId[] {
  if (mode === 'replace') {
    return [componentId];
  }

  return selectedComponentIds.includes(componentId)
    ? selectedComponentIds.filter((id) => id !== componentId)
    : [...selectedComponentIds, componentId];
}

export function addUiGraphComponentsToSelection(
  selectedComponentIds: readonly UiComponentId[],
  componentIds: readonly UiComponentId[],
): readonly UiComponentId[] {
  const selectedIds = new Set(selectedComponentIds);
  const additions = componentIds.filter((componentId) => !selectedIds.has(componentId));

  return additions.length > 0 ? [...selectedComponentIds, ...additions] : selectedComponentIds;
}

export function getUiGraphComponentIdsInSelectionRectangle(
  rectangle: UiGraphComponentSelectionRectangle,
  components: readonly UiGraphComponentSelectionCandidate[],
): UiComponentId[] {
  const left = Math.min(rectangle.startX, rectangle.currentX);
  const right = Math.max(rectangle.startX, rectangle.currentX);
  const top = Math.min(rectangle.startY, rectangle.currentY);
  const bottom = Math.max(rectangle.startY, rectangle.currentY);

  return components
    .filter(({ rect }) => {
      const width = rect.right - rect.left;
      const height = rect.bottom - rect.top;
      const overlapWidth = Math.max(0, Math.min(rect.right, right) - Math.max(rect.left, left));
      const overlapHeight = Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top));

      return overlapWidth * overlapHeight >= (width * height) / 2;
    })
    .map(({ id }) => id);
}

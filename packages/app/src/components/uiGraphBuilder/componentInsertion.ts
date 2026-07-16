export type UiGraphComponentInsertionBoundary = {
  bottom: number;
  top: number;
};

export function getUiGraphComponentInsertionIndex(
  targetIndex: number,
  activeCenterY: number,
  targetBoundary: UiGraphComponentInsertionBoundary,
): number {
  return activeCenterY < targetBoundary.top + (targetBoundary.bottom - targetBoundary.top) / 2
    ? targetIndex
    : targetIndex + 1;
}

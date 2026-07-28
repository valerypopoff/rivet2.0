export const DATA_BUS_COMPACT_VIEWPORT_RATIO = 0.7;
export const DATA_BUS_COMPACT_MAX_WIDTH_PX = 760;
export const DATA_BUS_FULL_ROW_HEIGHT_PX = 50;

export function getDataBusFullRowsHeight(options: { rowCount: number; uiFontScale: number }): number {
  const rowCount = Number.isFinite(options.rowCount) ? Math.max(0, Math.floor(options.rowCount)) : 0;
  return rowCount * DATA_BUS_FULL_ROW_HEIGHT_PX * options.uiFontScale;
}

export function getDataBusCompactMaxWidth(options: { uiFontScale: number; viewportWidth: number }): number {
  return Math.min(
    options.viewportWidth * DATA_BUS_COMPACT_VIEWPORT_RATIO,
    DATA_BUS_COMPACT_MAX_WIDTH_PX * options.uiFontScale,
  );
}

export function shouldUseDataBusFullRow(options: {
  groupContentWidths: readonly number[];
  uiFontScale: number;
  viewportWidth: number;
}): boolean {
  const compactMaxWidth = getDataBusCompactMaxWidth(options);
  const groupGap = 6 * options.uiFontScale;
  const railHorizontalPadding = 12 * options.uiFontScale;
  const totalContentWidth =
    railHorizontalPadding +
    options.groupContentWidths.reduce((total, width) => total + width, 0) +
    Math.max(0, options.groupContentWidths.length - 1) * groupGap;

  return totalContentWidth > compactMaxWidth + 1;
}

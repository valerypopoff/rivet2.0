export const DATA_BUS_FULL_ROW_HEIGHT_PX = 50;

export function getDataBusFullRowsHeight(options: { rowCount: number; uiFontScale: number }): number {
  const rowCount = Number.isFinite(options.rowCount) ? Math.max(0, Math.floor(options.rowCount)) : 0;
  return rowCount * DATA_BUS_FULL_ROW_HEIGHT_PX * options.uiFontScale;
}

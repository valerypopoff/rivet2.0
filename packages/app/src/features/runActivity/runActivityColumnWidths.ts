/**
 * User-local desktop column preferences for Run Activity. These values are
 * presentation only: no execution event, project, or recording depends on
 * them. Keep the bounded numeric contract here so stale local-storage values
 * cannot make the activity table unusable.
 */
export const RUN_ACTIVITY_COLUMN_WIDTH_KEYS = ['nodeName', 'graphName', 'nodeType'] as const;

export type RunActivityColumnWidthKey = (typeof RUN_ACTIVITY_COLUMN_WIDTH_KEYS)[number];

export type RunActivityColumnWidths = Record<RunActivityColumnWidthKey, number>;

type RunActivityColumnWidthDefinition = {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
};

const COLUMN_WIDTH_DEFINITIONS: Record<RunActivityColumnWidthKey, RunActivityColumnWidthDefinition> = {
  nodeName: { defaultWidth: 230, minWidth: 150, maxWidth: 560 },
  graphName: { defaultWidth: 180, minWidth: 130, maxWidth: 440 },
  nodeType: { defaultWidth: 150, minWidth: 120, maxWidth: 380 },
};

export const DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS: RunActivityColumnWidths = Object.fromEntries(
  RUN_ACTIVITY_COLUMN_WIDTH_KEYS.map((key) => [key, COLUMN_WIDTH_DEFINITIONS[key].defaultWidth]),
) as RunActivityColumnWidths;

/** Returns a complete, bounded layout even when storage contains stale data. */
export function normalizeRunActivityColumnWidths(value: unknown): RunActivityColumnWidths {
  const candidate = isRecord(value) ? value : {};

  return Object.fromEntries(
    RUN_ACTIVITY_COLUMN_WIDTH_KEYS.map((key) => [key, clampRunActivityColumnWidth(key, candidate[key])]),
  ) as RunActivityColumnWidths;
}

export function clampRunActivityColumnWidth(key: RunActivityColumnWidthKey, value: unknown): number {
  const definition = COLUMN_WIDTH_DEFINITIONS[key];
  const numericValue = typeof value === 'number' && Number.isFinite(value) ? value : definition.defaultWidth;
  return Math.round(Math.min(definition.maxWidth, Math.max(definition.minWidth, numericValue)));
}

export function getRunActivityColumnWidthBounds(
  key: RunActivityColumnWidthKey,
): Pick<RunActivityColumnWidthDefinition, 'minWidth' | 'maxWidth'> {
  const { minWidth, maxWidth } = COLUMN_WIDTH_DEFINITIONS[key];
  return { minWidth, maxWidth };
}

export function areRunActivityColumnWidthsEqual(left: unknown, right: RunActivityColumnWidths): boolean {
  return (
    isRecord(left) &&
    Object.keys(left).length === RUN_ACTIVITY_COLUMN_WIDTH_KEYS.length &&
    RUN_ACTIVITY_COLUMN_WIDTH_KEYS.every((key) => left[key] === right[key])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

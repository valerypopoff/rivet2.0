import { atomWithStorage } from 'jotai/utils';
import { createHybridStorage } from './storage.js';

const { storage } = createHybridStorage('ui');

export const DEFAULT_JSON_STRING_PREVIEW_POPOVER_WIDTH = 420;
export const MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH = 260;
export const MAX_JSON_STRING_PREVIEW_POPOVER_WIDTH = 800;
export const DEFAULT_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT = 280;
export const MIN_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT = 120;
export const MAX_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT = 720;

export type JsonStringEditModalSize = {
  height: number;
  width: number;
};

export const DEFAULT_JSON_STRING_EDIT_MODAL_SIZE: JsonStringEditModalSize = {
  height: 720,
  width: 960,
};

export function clampJsonStringPreviewPopoverWidth(value: unknown): number {
  return clampStoredNumber(
    value,
    DEFAULT_JSON_STRING_PREVIEW_POPOVER_WIDTH,
    MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH,
    MAX_JSON_STRING_PREVIEW_POPOVER_WIDTH,
  );
}

export function clampJsonStringPreviewPopoverMaxHeight(value: unknown): number {
  return clampStoredNumber(
    value,
    DEFAULT_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
    MIN_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
    MAX_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
  );
}

export const jsonStringPreviewPopoverWidthState = atomWithStorage<number>(
  'jsonStringPreviewPopoverWidthState',
  DEFAULT_JSON_STRING_PREVIEW_POPOVER_WIDTH,
  storage,
);

export const jsonStringPreviewPopoverMaxHeightState = atomWithStorage<number>(
  'jsonStringPreviewPopoverMaxHeightState',
  DEFAULT_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
  storage,
);

export const jsonStringEditModalSizeState = atomWithStorage<JsonStringEditModalSize>(
  'jsonStringEditModalSizeState',
  DEFAULT_JSON_STRING_EDIT_MODAL_SIZE,
  storage,
);

function clampStoredNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

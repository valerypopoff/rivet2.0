import type { JsonStringEditModalSize } from '../../../state/editorPreferences.js';
import {
  clampJsonStringPreviewPopoverMaxHeight,
  clampJsonStringPreviewPopoverWidth,
  MIN_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
  MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH,
} from '../../../state/editorPreferences.js';

export const JSON_STRING_PREVIEW_POPOVER_GAP = 8;
export const JSON_STRING_PREVIEW_VIEWPORT_PADDING = 12;
export const JSON_STRING_PREVIEW_HEADER_ESTIMATED_HEIGHT = 43;
export const JSON_STRING_PREVIEW_MIN_VISIBLE_BODY_HEIGHT = 48;
export const JSON_STRING_EDIT_MODAL_VIEWPORT_GAP = 24;
export const JSON_STRING_EDIT_MODAL_MIN_WIDTH = 560;
export const JSON_STRING_EDIT_MODAL_MIN_HEIGHT = 520;

export type ViewportSize = { height: number; width: number };
export type JsonStringPreviewAnchorRect = { bottom: number; left: number };
export type JsonStringPreviewPosition = { left: number; top: number };

export function calculateJsonStringPreviewPopoverPosition(
  anchor: JsonStringPreviewAnchorRect,
  requestedWidth: number,
  viewport: ViewportSize,
): JsonStringPreviewPosition {
  const effectiveWidth = Math.min(
    requestedWidth,
    Math.max(MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH, viewport.width - 2 * JSON_STRING_PREVIEW_VIEWPORT_PADDING),
  );
  const maxLeft = Math.max(
    JSON_STRING_PREVIEW_VIEWPORT_PADDING,
    viewport.width - effectiveWidth - JSON_STRING_PREVIEW_VIEWPORT_PADDING,
  );
  const maxTop = Math.max(
    JSON_STRING_PREVIEW_VIEWPORT_PADDING,
    viewport.height -
      JSON_STRING_PREVIEW_VIEWPORT_PADDING -
      JSON_STRING_PREVIEW_HEADER_ESTIMATED_HEIGHT -
      JSON_STRING_PREVIEW_MIN_VISIBLE_BODY_HEIGHT,
  );

  return {
    left: Math.min(Math.max(anchor.left, JSON_STRING_PREVIEW_VIEWPORT_PADDING), maxLeft),
    top: Math.max(
      JSON_STRING_PREVIEW_VIEWPORT_PADDING,
      Math.min(anchor.bottom + JSON_STRING_PREVIEW_POPOVER_GAP, maxTop),
    ),
  };
}

export function getLeftResizePopoverWidth(width: number, rightEdge: number): number {
  return Math.min(
    clampJsonStringPreviewPopoverWidth(width),
    Math.max(MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH, rightEdge - JSON_STRING_PREVIEW_VIEWPORT_PADDING),
  );
}

export function getVisibleJsonStringEditModalSize(
  size: JsonStringEditModalSize,
  viewport: ViewportSize,
): JsonStringEditModalSize {
  const maxWidth = Math.max(1, viewport.width - JSON_STRING_EDIT_MODAL_VIEWPORT_GAP);
  const maxHeight = Math.max(1, viewport.height - JSON_STRING_EDIT_MODAL_VIEWPORT_GAP);
  const minWidth = Math.min(JSON_STRING_EDIT_MODAL_MIN_WIDTH, maxWidth);
  const minHeight = Math.min(JSON_STRING_EDIT_MODAL_MIN_HEIGHT, maxHeight);
  const width = Number.isFinite(size.width) ? size.width : minWidth;
  const height = Number.isFinite(size.height) ? size.height : minHeight;

  return {
    height: Math.min(maxHeight, Math.max(minHeight, Math.round(height))),
    width: Math.min(maxWidth, Math.max(minWidth, Math.round(width))),
  };
}

export function getVisibleJsonStringPreviewPopoverWidth(
  width: number,
  left: number | undefined,
  viewportWidth: number,
): number {
  const clampedWidth = clampJsonStringPreviewPopoverWidth(width);
  return left == null
    ? clampedWidth
    : Math.min(
        clampedWidth,
        Math.max(MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH, viewportWidth - left - JSON_STRING_PREVIEW_VIEWPORT_PADDING),
      );
}

export function getVisibleJsonStringPreviewPopoverMaxHeight(
  maxHeight: number,
  top: number | undefined,
  viewportHeight: number,
): number {
  const clampedMaxHeight = clampJsonStringPreviewPopoverMaxHeight(maxHeight);
  if (top == null) {
    return clampedMaxHeight;
  }

  const availableHeight =
    viewportHeight - top - JSON_STRING_PREVIEW_HEADER_ESTIMATED_HEIGHT - JSON_STRING_PREVIEW_VIEWPORT_PADDING;
  return Math.min(clampedMaxHeight, Math.max(JSON_STRING_PREVIEW_MIN_VISIBLE_BODY_HEIGHT, availableHeight));
}

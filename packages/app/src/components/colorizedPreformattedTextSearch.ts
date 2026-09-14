import {
  applyHighlightsToTextSegments,
  clearHighlights,
  collectHighlightTextSegments,
  type SearchMatchRange,
} from './nodeOutput/fullscreenOutputSearch.js';

/**
 * Colorized output replaces its complete DOM after Monaco tokenization. Keep an
 * active fullscreen-search mark as an explicit rendering step so that rewrite
 * cannot silently discard it.
 */
export function applyColorizedPreformattedTextSearchHighlight(
  element: HTMLElement,
  activeMatchRange: SearchMatchRange | null,
): HTMLElement | null {
  clearHighlights(element);

  if (!activeMatchRange) {
    return null;
  }

  return applyHighlightsToTextSegments({
    textSegments: collectHighlightTextSegments(element, { includeLineBreakElements: true }),
    matchRanges: [activeMatchRange],
    matchIndices: [0],
    activeMatchIndex: 0,
    includeMatchIndexAttribute: false,
  });
}

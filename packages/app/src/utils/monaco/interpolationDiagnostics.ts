import { scanInterpolationTokenSpans } from '@valerypopoff/rivet2-core/interpolation-syntax';

export const JS_VALUE_INTERPOLATION_MARKER_OWNERS = ['javascript', 'typescript'] as const;
export const JSON_TEMPLATE_INTERPOLATION_MARKER_OWNERS = ['json'] as const;

export type EditorInterpolationSyntax = 'js-value' | 'json-template';

export type OffsetRange = {
  start: number;
  end: number;
};

export type TextMarkerRange = {
  start: number;
  end: number;
};

function normalizeOffsetRange(range: OffsetRange): OffsetRange {
  if (range.end > range.start) {
    return range;
  }

  return {
    start: range.start,
    end: range.start + 1,
  };
}

export function rangesOverlap(a: OffsetRange, b: OffsetRange): boolean {
  const normalizedA = normalizeOffsetRange(a);
  const normalizedB = normalizeOffsetRange(b);

  return normalizedA.start < normalizedB.end && normalizedB.start < normalizedA.end;
}

export function getActiveInterpolationOffsetRanges(text: string): OffsetRange[] {
  return scanInterpolationTokenSpans(text).map(({ start, end }) => ({ start, end }));
}

export function shouldSuppressMarkerForInterpolation(
  markerRange: TextMarkerRange,
  interpolationRanges: readonly OffsetRange[],
): boolean {
  return interpolationRanges.some((range) => rangesOverlap(markerRange, range));
}

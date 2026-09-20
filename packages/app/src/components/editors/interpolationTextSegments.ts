import { scanInterpolationTokenSpans } from '@valerypopoff/rivet2-core/interpolation-syntax';

export type InterpolationTextSegment = {
  text: string;
  isInterpolation: boolean;
};

/**
 * Produces a visual-only representation of a one-line interpolation template.
 * Core owns token scanning so malformed and escaped tokens look exactly like
 * their execution semantics: escaped triple-brace text remains ordinary text.
 */
export function getInterpolationTextSegments(value: string): InterpolationTextSegment[] {
  const segments: InterpolationTextSegment[] = [];
  let cursor = 0;

  for (const { start, end } of scanInterpolationTokenSpans(value)) {
    if (start > cursor) {
      segments.push({ text: value.slice(cursor, start), isInterpolation: false });
    }

    segments.push({ text: value.slice(start, end), isInterpolation: true });
    cursor = end;
  }

  if (cursor < value.length || segments.length === 0) {
    segments.push({ text: value.slice(cursor), isInterpolation: false });
  }

  return segments;
}

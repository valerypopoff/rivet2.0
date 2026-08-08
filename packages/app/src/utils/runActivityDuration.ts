import prettyMs from 'pretty-ms';

/** Formats every Run Activity duration with one compact, human-readable policy. */
export function formatRunActivityDuration(durationMs: number): string {
  return prettyMs(Math.max(0, durationMs), {
    keepDecimalsOnWholeSeconds: true,
    secondsDecimalDigits: 2,
  });
}

import stableStringify from 'safe-stable-stringify';
import type { ProjectNodeFieldComparison } from '../projectComparison.js';

export function areComparisonValuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

export function getChangedValueComparisons(
  path: string[],
  before: unknown,
  after: unknown,
): ProjectNodeFieldComparison[] {
  if (areComparisonValuesEqual(before, after)) {
    return [];
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    return Array.from({ length: Math.max(before.length, after.length) }).flatMap((_value, index) =>
      getChangedValueComparisons([...path, String(index)], before[index], after[index]),
    );
  }

  if (isComparisonRecord(before) && isComparisonRecord(after)) {
    return unionKeys(before, after).flatMap((key) =>
      getChangedValueComparisons([...path, key], before[key], after[key]),
    );
  }

  return [
    {
      after,
      before,
      field: formatComparisonPath(path),
      path,
    },
  ];
}

export function isComparisonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

export function unionKeys(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
}

function formatComparisonPath(path: readonly string[]): string {
  return path.reduce((formatted, segment) => {
    if (/^\d+$/.test(segment)) {
      return `${formatted}[${segment}]`;
    }

    if (formatted.length === 0) {
      return segment;
    }

    return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${formatted}.${segment}` : `${formatted}[${JSON.stringify(segment)}]`;
  }, '');
}

import { getActiveInterpolationOffsetRanges, type OffsetRange } from './interpolationDiagnostics.js';

export const JSON_TEMPLATE_VALIDATION_MARKER_OWNER = 'rivet-json-template-validation';

export type JsonTemplateValidationDiagnostic = {
  message: string;
  start: number;
  end: number;
};

function isEscapedCharacter(value: string, index: number): boolean {
  let backslashCount = 0;

  for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) {
    backslashCount++;
  }

  return backslashCount % 2 === 1;
}

function isUnescapedQuoteAt(value: string, index: number): boolean {
  return index >= 0 && index < value.length && value[index] === '"' && !isEscapedCharacter(value, index);
}

function isInsideJsonString(value: string, index: number): boolean {
  let insideString = false;

  for (let i = 0; i < index; i++) {
    if (isUnescapedQuoteAt(value, i)) {
      insideString = !insideString;
    }
  }

  return insideString;
}

function getNextNonWhitespaceCharacter(value: string, index: number): string | undefined {
  for (let i = index; i < value.length; i++) {
    const char = value[i];

    if (char && !/\s/.test(char)) {
      return char;
    }
  }

  return undefined;
}

function getTokenReplacement(value: string, range: OffsetRange): string {
  if (isInsideJsonString(value, range.start)) {
    return 'rivet';
  }

  if (getNextNonWhitespaceCharacter(value, range.end) === ':') {
    return '"rivetKey"';
  }

  return 'null';
}

function appendMappedText(parts: string[], sourceMap: number[], value: string, startOffset: number): void {
  parts.push(value);

  for (let i = 0; i < value.length; i++) {
    sourceMap.push(startOffset + i);
  }
}

function appendMappedReplacement(parts: string[], sourceMap: number[], value: string, sourceOffset: number): void {
  parts.push(value);

  for (let i = 0; i < value.length; i++) {
    sourceMap.push(sourceOffset);
  }
}

export function createJsonTemplateValidationProjection(value: string): { projectedText: string; sourceMap: number[] } {
  const interpolationRanges = getActiveInterpolationOffsetRanges(value);
  const parts: string[] = [];
  const sourceMap: number[] = [];
  let cursor = 0;

  for (const range of interpolationRanges) {
    appendMappedText(parts, sourceMap, value.slice(cursor, range.start), cursor);
    appendMappedReplacement(parts, sourceMap, getTokenReplacement(value, range), range.start);
    cursor = range.end;
  }

  appendMappedText(parts, sourceMap, value.slice(cursor), cursor);

  return {
    projectedText: parts.join(''),
    sourceMap,
  };
}

function getJsonParseErrorPosition(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\bposition\s+(\d+)\b/.exec(message);

  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function mapProjectedOffsetToSourceOffset(sourceMap: readonly number[], projectedOffset: number, sourceLength: number) {
  if (projectedOffset >= sourceMap.length) {
    return sourceLength;
  }

  return sourceMap[Math.max(0, projectedOffset)] ?? 0;
}

export function validateJsonTemplate(value: string): JsonTemplateValidationDiagnostic[] {
  const { projectedText, sourceMap } = createJsonTemplateValidationProjection(value);

  try {
    JSON.parse(projectedText);
    return [];
  } catch (error) {
    const parsePosition = getJsonParseErrorPosition(error) ?? projectedText.length;
    const start = mapProjectedOffsetToSourceOffset(sourceMap, parsePosition, value.length);
    const end = start < value.length ? start + 1 : start;
    const message = error instanceof Error ? error.message : String(error);

    return [
      {
        message: `Invalid JSON template: ${message}`,
        start,
        end,
      },
    ];
  }
}

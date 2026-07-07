export const DEFAULT_JSON_STRING_PREVIEW_MIN_LENGTH = 50;

export type JsonStringPreviewRange = {
  decodedValue: string;
  endOffset: number;
  endLine: number;
  id: string;
  startOffset: number;
  startLine: number;
};

type JsonStringPreviewRangeOptions = {
  minDecodedLength?: number;
};

export function getJsonStringPreviewRanges(
  text: string,
  options: JsonStringPreviewRangeOptions = {},
): JsonStringPreviewRange[] {
  const minDecodedLength = options.minDecodedLength ?? DEFAULT_JSON_STRING_PREVIEW_MIN_LENGTH;
  const lineStarts = getLineStarts(text);
  const ranges: JsonStringPreviewRange[] = [];
  let index = 0;

  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }

    const startOffset = index;
    let hasEscape = false;
    index += 1;

    while (index < text.length) {
      const char = text[index];

      if (char === '\\') {
        hasEscape = true;
        index += 2;
        continue;
      }

      if (char === '"') {
        const endOffset = index + 1;
        const rawLiteral = text.slice(startOffset, endOffset);

        if (!isObjectKeyLiteral(text, endOffset)) {
          const decodedValue = decodeJsonStringLiteral(rawLiteral);

          if (decodedValue != null && isUsefulStringPreview(decodedValue, hasEscape, minDecodedLength)) {
            ranges.push({
              decodedValue,
              endOffset,
              endLine: getLineNumberAtOffset(lineStarts, endOffset),
              id: `${startOffset}:${endOffset}`,
              startOffset,
              startLine: getLineNumberAtOffset(lineStarts, startOffset),
            });
          }
        }

        index = endOffset;
        break;
      }

      index += 1;
    }

    if (index >= text.length) {
      break;
    }
  }

  return ranges;
}

export function findJsonStringPreviewRangeAtOffset(
  ranges: readonly JsonStringPreviewRange[],
  offset: number,
): JsonStringPreviewRange | undefined {
  return ranges.find((range) => offset >= range.startOffset && offset <= range.endOffset);
}

export function findJsonStringPreviewRangeAtPosition(
  ranges: readonly JsonStringPreviewRange[],
  offset: number,
  lineNumber: number,
): JsonStringPreviewRange | undefined {
  const exactRange = findJsonStringPreviewRangeAtOffset(ranges, offset);

  if (exactRange) {
    return exactRange;
  }

  let closestRange: JsonStringPreviewRange | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const range of ranges) {
    if (lineNumber < range.startLine || lineNumber > range.endLine) {
      continue;
    }

    const distance = getOffsetDistance(range, offset);

    if (distance < closestDistance) {
      closestRange = range;
      closestDistance = distance;
    }
  }

  return closestRange;
}

function decodeJsonStringLiteral(rawLiteral: string): string | undefined {
  try {
    const decoded = JSON.parse(rawLiteral);
    return typeof decoded === 'string' ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isObjectKeyLiteral(text: string, endOffset: number): boolean {
  let index = endOffset;

  while (index < text.length && /\s/.test(text[index]!)) {
    index += 1;
  }

  return text[index] === ':';
}

function isUsefulStringPreview(decodedValue: string, hasEscape: boolean, minDecodedLength: number): boolean {
  return hasEscape || decodedValue.length >= minDecodedLength || /[\n\r\t]/.test(decodedValue);
}

function getLineStarts(text: string): number[] {
  const lineStarts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function getLineNumberAtOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle]!;
    const nextLineStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (offset < lineStart) {
      high = middle - 1;
    } else if (offset >= nextLineStart) {
      low = middle + 1;
    } else {
      return middle + 1;
    }
  }

  return lineStarts.length;
}

function getOffsetDistance(range: JsonStringPreviewRange, offset: number): number {
  if (offset < range.startOffset) {
    return range.startOffset - offset;
  }

  if (offset > range.endOffset) {
    return offset - range.endOffset;
  }

  return 0;
}

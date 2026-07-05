export const DEFAULT_JSON_STRING_PREVIEW_MIN_LENGTH = 120;

export type JsonStringPreviewRange = {
  decodedValue: string;
  endOffset: number;
  id: string;
  startOffset: number;
};

type JsonStringPreviewRangeOptions = {
  minDecodedLength?: number;
};

export function getJsonStringPreviewRanges(
  text: string,
  options: JsonStringPreviewRangeOptions = {},
): JsonStringPreviewRange[] {
  const minDecodedLength = options.minDecodedLength ?? DEFAULT_JSON_STRING_PREVIEW_MIN_LENGTH;
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
              id: `${startOffset}:${endOffset}`,
              startOffset,
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

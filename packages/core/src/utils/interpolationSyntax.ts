export type InterpolationTokenSpan = {
  start: number;
  end: number;
  rawInner: string;
};

const REGEX_LITERAL_PREFIX_CHARACTERS = new Set([
  '(',
  '[',
  '{',
  ':',
  ';',
  ',',
  '=',
  '!',
  '~',
  '?',
  '&',
  '|',
  '+',
  '-',
  '*',
  '%',
  '^',
  '<',
  '>',
]);

export function isInterpolationSyntaxCharacterEscaped(value: string, index: number): boolean {
  let backslashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }

  return backslashCount % 2 === 1;
}

/**
 * JSONPath filters can contain JavaScript regex literals. Treat their contents
 * as opaque while looking for an interpolation terminator or processor pipe;
 * otherwise a `]` or `|` inside the regex can be mistaken for JSONPath syntax.
 */
export function isInterpolationRegexLiteralStart(value: string, index: number): boolean {
  if (value[index] !== '/') {
    return false;
  }

  let previousIndex = index - 1;
  while (previousIndex >= 0 && /\s/.test(value[previousIndex]!)) {
    previousIndex -= 1;
  }

  return previousIndex < 0 || REGEX_LITERAL_PREFIX_CHARACTERS.has(value[previousIndex]!);
}

function getEscapedTripleTokenEnd(template: string, start: number): number | undefined {
  for (let cursor = start + 3; cursor < template.length - 2; cursor += 1) {
    if (template[cursor] === '}' && template[cursor + 1] === '}' && template[cursor + 2] === '}') {
      return cursor + 3;
    }
  }

  return undefined;
}

type TokenScanResult = { kind: 'closed'; end: number } | { kind: 'nested'; start: number } | { kind: 'unclosed' };

/** Finds a matching `}}` while allowing JSONPath filters, quotes, and braces. */
function scanInterpolationToken(template: string, start: number): TokenScanResult {
  let quote: '"' | "'" | '`' | undefined;
  let regex = false;
  let regexCharacterClass = false;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let braceDepth = 0;

  for (let cursor = start + 2; cursor < template.length; cursor += 1) {
    const character = template[cursor]!;

    if (regex) {
      if (character === '[' && !isInterpolationSyntaxCharacterEscaped(template, cursor)) {
        regexCharacterClass = true;
      } else if (character === ']' && !isInterpolationSyntaxCharacterEscaped(template, cursor)) {
        regexCharacterClass = false;
      } else if (character === '/' && !regexCharacterClass && !isInterpolationSyntaxCharacterEscaped(template, cursor)) {
        regex = false;
      }
      continue;
    }

    if (quote) {
      if (character === quote && !isInterpolationSyntaxCharacterEscaped(template, cursor)) {
        quote = undefined;
      }
      continue;
    }

    if (character === '/' && isInterpolationRegexLiteralStart(template, cursor)) {
      regex = true;
      regexCharacterClass = false;
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }

    // A second opener always starts recovery outside quoted or regex syntax.
    // JSONPath object literals use single `{` characters; a literal `{{` is
    // not valid JSONPath syntax and should not swallow a later valid token.
    if (character === '{' && template[cursor + 1] === '{') {
      return { kind: 'nested', start: cursor };
    }

    if (character === '[') {
      bracketDepth += 1;
      continue;
    }

    if (character === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }

    if (character === '(') {
      parenthesisDepth += 1;
      continue;
    }

    if (character === ')' && parenthesisDepth > 0) {
      parenthesisDepth -= 1;
      continue;
    }

    if (character === '{') {
      braceDepth += 1;
      continue;
    }

    if (character === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1;
        continue;
      }

      if (template[cursor + 1] === '}' && bracketDepth === 0 && parenthesisDepth === 0) {
        return { kind: 'closed', end: cursor + 2 };
      }
    }
  }

  return { kind: 'unclosed' };
}

/**
 * Scans token boundaries without parsing expressions or resolving values.
 *
 * This deliberately has no evaluator dependencies, so editor-only surfaces
 * can share Core's malformed-token recovery rules without loading JSONPath or
 * the rest of the execution runtime. The returned spans are fresh data and
 * exclude escaped triple-brace tokens.
 */
export function scanInterpolationTokenSpans(template: string): InterpolationTokenSpan[] {
  const spans: InterpolationTokenSpan[] = [];
  let searchIndex = 0;

  while (searchIndex < template.length) {
    const start = template.indexOf('{{', searchIndex);

    if (start === -1) {
      break;
    }

    if (template[start + 2] === '{') {
      const escapedEnd = getEscapedTripleTokenEnd(template, start);
      if (escapedEnd !== undefined) {
        searchIndex = escapedEnd;
        continue;
      }
    }

    const scanResult = scanInterpolationToken(template, start);

    if (scanResult.kind === 'nested') {
      searchIndex = scanResult.start;
      continue;
    }

    if (scanResult.kind === 'unclosed') {
      // A malformed outer token can leave the scanner inside an unterminated
      // quote or filter. Resume at a later opener so a valid following token
      // is still discovered. Properly closed outer tokens return above, so
      // valid quoted `{{` content remains part of that outer token.
      const nextStart = template.indexOf('{{', start + 2);
      if (nextStart === -1) {
        break;
      }
      searchIndex = nextStart;
      continue;
    }

    spans.push({
      start,
      end: scanResult.end,
      rawInner: template.slice(start + 2, scanResult.end - 2),
    });
    searchIndex = scanResult.end;
  }

  return spans;
}

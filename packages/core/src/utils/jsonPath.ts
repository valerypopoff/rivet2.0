import { JSONPath } from 'jsonpath-plus';
import { isInterpolationRegexLiteralStart, isInterpolationSyntaxCharacterEscaped } from './interpolationSyntax.js';

function getNextNonWhitespaceCharacter(value: string, index: number): string | undefined {
  for (let cursor = index; cursor < value.length; cursor++) {
    if (!/\s/.test(value[cursor]!)) {
      return value[cursor];
    }
  }

  return undefined;
}

function getWhitespaceRunEnd(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length && /\s/.test(value[cursor]!)) {
    cursor += 1;
  }
  return cursor;
}

/**
 * Normalizes Rivet's historically accepted convenience whitespace around
 * JSONPath structural separators. Quoted values, regular expressions, filter
 * expressions, and object literals keep their authored contents unchanged.
 *
 * All runtime JSONPath consumers must pass through this helper so stored node
 * paths and interpolation suffixes accept the same path language.
 */
export function normalizeJsonPathExpression(path: string): string {
  const trimmedPath = path.trim();
  if (!/\s/.test(trimmedPath)) {
    return trimmedPath;
  }

  const result: string[] = [];
  let lastResultCharacter: string | undefined;
  let quote: '"' | "'" | '`' | undefined;
  let regex = false;
  let regexCharacterClass = false;
  const filterBrackets: boolean[] = [];
  let filterDepth = 0;

  const append = (value: string): void => {
    if (value === '') {
      return;
    }

    result.push(value);
    lastResultCharacter = value.at(-1);
  };

  for (let cursor = 0; cursor < trimmedPath.length; cursor++) {
    const character = trimmedPath[cursor]!;

    if (regex) {
      if (character === '[' && !isInterpolationSyntaxCharacterEscaped(trimmedPath, cursor)) {
        regexCharacterClass = true;
      } else if (character === ']' && !isInterpolationSyntaxCharacterEscaped(trimmedPath, cursor)) {
        regexCharacterClass = false;
      } else if (
        character === '/' &&
        !regexCharacterClass &&
        !isInterpolationSyntaxCharacterEscaped(trimmedPath, cursor)
      ) {
        regex = false;
      }
      append(character);
      continue;
    }

    if (quote) {
      if (character === quote && !isInterpolationSyntaxCharacterEscaped(trimmedPath, cursor)) {
        quote = undefined;
      }
      append(character);
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      append(character);
      continue;
    }

    if (character === '/' && isInterpolationRegexLiteralStart(trimmedPath, cursor)) {
      regex = true;
      regexCharacterClass = false;
      append(character);
      continue;
    }

    const insideFilter = filterDepth > 0;

    if (/\s/.test(character)) {
      const whitespaceEnd = getWhitespaceRunEnd(trimmedPath, cursor);
      const previousCharacter = lastResultCharacter;
      const nextCharacter = trimmedPath[whitespaceEnd];
      // jsonpath-plus rejects whitespace immediately inside either bracket.
      // Preserve other filter whitespace because it may separate JavaScript
      // tokens or be meaningful inside filter expressions.
      const shouldRemoveWhitespace =
        previousCharacter === '[' ||
        nextCharacter === ']' ||
        nextCharacter === '[' ||
        (!insideFilter && (previousCharacter === '.' || previousCharacter === ']' || nextCharacter === '.'));

      if (!shouldRemoveWhitespace) {
        append(trimmedPath.slice(cursor, whitespaceEnd));
      }
      cursor = whitespaceEnd - 1;
      continue;
    }

    if (character === '[') {
      const opensFilter = getNextNonWhitespaceCharacter(trimmedPath, cursor + 1) === '?';
      filterBrackets.push(opensFilter);
      if (opensFilter) {
        filterDepth += 1;
      }
      append(character);
      continue;
    }

    if (character === ']') {
      if (filterBrackets.pop()) {
        filterDepth -= 1;
      }
      append(character);
      continue;
    }

    append(character);
  }

  return result.join('').trim();
}

/**
 * Evaluates a JSONPath expression with the same engine and options used by the
 * object-path nodes. Callers retain ownership of their no-match and error
 * policy; this helper deliberately lets JSONPath errors propagate.
 */
export function evaluateJsonPath<T = unknown>(value: unknown, path: string, wrap = false): T | T[] | undefined {
  return JSONPath<T>({
    json: value ?? null,
    path: normalizeJsonPathExpression(path),
    wrap,
  });
}

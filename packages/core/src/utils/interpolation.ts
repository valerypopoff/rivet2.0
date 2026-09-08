import { dataTypes, type DataValue } from '../model/DataValue.js';
import { coerceTypeOptional } from './coerceType.js';
import { evaluateJsonPath, normalizeJsonPathExpression } from './jsonPath.js';
import { dedent } from './misc.js';
import {
  isInterpolationRegexLiteralStart,
  isInterpolationSyntaxCharacterEscaped,
  scanInterpolationTokenSpans,
  type InterpolationTokenSpan,
} from './interpolationSyntax.js';

export const ESCAPED_TOKEN_REGEX = /\{\{\{([^}]+?)\}\}\}/g;
export const ESCAPED_ESCAPED_TOKEN_REGEX = /\\\{\\\{([^}]+?)\\\}\\\}/g;

const INTERPOLATION_TEMPLATE_CACHE_MAX_ENTRIES = 2048;
const INTERPOLATION_TEMPLATE_CACHE_MAX_TEMPLATE_LENGTH = 64 * 1024;
const INTERPOLATION_TEMPLATE_CACHE_MAX_TEMPLATE_CHARS = 1024 * 1024;
const INTERPOLATION_TEMPLATE_CACHE_MAX_STORAGE_CHARS = 2 * 1024 * 1024;
// JavaScript list callbacks can resolve the same expression for every item.
// Keep this syntax-only cache deliberately smaller than the template cache:
// values, contexts, and DataValues must never be retained here.
const INTERPOLATION_EXPRESSION_CACHE_MAX_ENTRIES = 512;
const INTERPOLATION_EXPRESSION_CACHE_MAX_EXPRESSION_LENGTH = 4 * 1024;
const INTERPOLATION_EXPRESSION_CACHE_MAX_CHARS = 128 * 1024;
export type { InterpolationTokenSpan } from './interpolationSyntax.js';

export type InterpolationReferenceSource = 'variable' | 'graphInputs' | 'context';

/** A base value and, optionally, a JSONPath evaluated against that value. */
export type ParsedInterpolationExpression = {
  source: InterpolationReferenceSource;
  baseName: string;
  /** A JSONPath beginning with `$`, evaluated with `wrap: false`. */
  jsonPath: string | undefined;
};

export type ParsedInterpolationToken = {
  span: InterpolationTokenSpan;
  rawInner: string;
  /** The interpolation expression before its optional processor chain. */
  tokenName: string | undefined;
  processingChain: string | undefined;
  reference: ParsedInterpolationExpression | undefined;
};

export type ParsedInterpolationTemplate = {
  template: string;
  tokens: readonly ParsedInterpolationToken[];
};

export type InterpolationVariableReference = {
  baseName: string;
  /** True when any occurrence of this input navigates into its value with JSONPath. */
  hasPath: boolean;
};

export type InterpolationTokenReplacementInfo = {
  rawInner: string;
  span: InterpolationTokenSpan;
  tokenName: string | undefined;
  processingChain: string | undefined;
  reference: ParsedInterpolationExpression | undefined;
};

export type ReplaceInterpolationTokensOptions = {
  trim?: boolean;
};

export type InterpolateOptions = {
  /** Set false when ordinary interpolation variables are raw JSON. */
  unwrapVariableDataValues?: boolean;
  /**
   * Use the historical text-template DataValue coercion for bare ordinary
   * variables. Paths still select raw JSON and use JSON serialization.
   */
  coerceBareVariableDataValues?: boolean;
};

export type InterpolationValueSources = {
  variables?: Record<string, unknown>;
  graphInputValues?: Record<string, unknown>;
  contextValues?: Record<string, unknown>;
  /** Set false when `variables` are already raw JSON rather than DataValues. */
  unwrapVariableDataValues?: boolean;
};

type CachedInterpolationTemplate = {
  templateChars: number;
  storageChars: number;
  parsed: ParsedInterpolationTemplate;
};

const interpolationTemplateCache = new Map<string, CachedInterpolationTemplate>();
let cachedInterpolationTemplateChars = 0;
let cachedInterpolationTemplateStorageChars = 0;
let lastUncachedInterpolationTemplate: string | undefined;
const interpolationExpressionCache = new Map<string, ParsedInterpolationExpression | undefined>();
let cachedInterpolationExpressionChars = 0;
const dataValueTypeSet = new Set<string>(dataTypes);

type ProcessingFunction = (input: string, param?: number) => string;

const processingFunctions: Record<string, ProcessingFunction> = {
  indent: (input: string, spaces: number = 0) => {
    const indent = ' '.repeat(spaces);
    return input
      .split('\n')
      .map((line) => `${indent}${line}`)
      .join('\n');
  },

  quote: (input: string, level: number = 1) => {
    const quotePrefix = '> '.repeat(level);
    return input
      .split('\n')
      .map((line) => `${quotePrefix}${line}`)
      .join('\n');
  },

  uppercase: (input: string) => input.toUpperCase(),
  lowercase: (input: string) => input.toLowerCase(),
  trim: (input: string) => input.trim(),

  truncate: (input: string, length: number = 50) => {
    if (input.length <= length) return input;
    return input.slice(0, length) + '...';
  },

  list: (input: string, level: number = 1) => {
    const indent = '  '.repeat(level - 1);
    return input
      .split('\n')
      .map((line) => `${indent}- ${line}`)
      .join('\n');
  },

  sort: (input: string) => input.split('\n').sort().join('\n'),
  dedent: (input: string) => dedent(input),

  wrap: (input: string, width: number = 80) => {
    const words = input.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= width) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines.join('\n');
  },
};

/**
 * Unwrap a Rivet DataValue at an interpolation source boundary. Callers must
 * not recursively apply this to selected JSON properties: an ordinary object
 * inside the value may legitimately have `type` and `value` properties.
 */
export function unwrapPotentialDataValue(value: unknown): unknown {
  if (isRivetDataValue(value)) {
    return (value as { value: unknown }).value;
  }

  return value;
}

function isRivetDataValue(value: unknown): value is DataValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    dataValueTypeSet.has((value as { type: string }).type) &&
    Object.prototype.hasOwnProperty.call(value, 'value')
  );
}

/**
 * Renders a whole interpolation input with the legacy generic interpolation
 * behavior. Text-oriented callers can opt into DataValue string coercion.
 */
export function stringifyInterpolationSourceValue(
  value: unknown,
  {
    coerceDataValueToString = false,
    unwrapDataValue = true,
  }: { coerceDataValueToString?: boolean; unwrapDataValue?: boolean } = {},
): string {
  try {
    if (coerceDataValueToString && unwrapDataValue && isRivetDataValue(value)) {
      return coerceTypeOptional(value, 'string') ?? '';
    }

    return String((unwrapDataValue ? unwrapPotentialDataValue(value) : value) ?? '');
  } catch {
    // Keep interpolation usable for cyclic values and custom objects whose
    // string conversion throws, matching the prior object fallback.
    return '[object Object]';
  }
}

function findTopLevelProcessorSeparator(rawInner: string): number | undefined {
  let quote: '"' | "'" | '`' | undefined;
  let regex = false;
  let regexCharacterClass = false;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let braceDepth = 0;

  for (let cursor = 0; cursor < rawInner.length; cursor++) {
    const character = rawInner[cursor]!;

    if (regex) {
      if (character === '[' && !isInterpolationSyntaxCharacterEscaped(rawInner, cursor)) {
        regexCharacterClass = true;
      } else if (character === ']' && !isInterpolationSyntaxCharacterEscaped(rawInner, cursor)) {
        regexCharacterClass = false;
      } else if (
        character === '/' &&
        !regexCharacterClass &&
        !isInterpolationSyntaxCharacterEscaped(rawInner, cursor)
      ) {
        regex = false;
      }
      continue;
    }

    if (quote) {
      if (character === quote && !isInterpolationSyntaxCharacterEscaped(rawInner, cursor)) {
        quote = undefined;
      }
      continue;
    }

    if (character === '/' && isInterpolationRegexLiteralStart(rawInner, cursor)) {
      regex = true;
      regexCharacterClass = false;
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
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

    if (character === '}' && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }

    if (character === '|' && bracketDepth === 0 && parenthesisDepth === 0 && braceDepth === 0) {
      return cursor;
    }
  }

  return undefined;
}

function findQuotedStringEnd(value: string, start: number): number | undefined {
  const quote = value[start];

  for (let cursor = start + 1; cursor < value.length; cursor++) {
    if (value[cursor] === quote && !isInterpolationSyntaxCharacterEscaped(value, cursor)) {
      return cursor;
    }
  }

  return undefined;
}

function parseQuotedBaseReference(expression: string): { baseName: string; suffix: string | undefined } | undefined {
  if (expression[0] !== '[') {
    return undefined;
  }

  let cursor = 1;
  while (expression[cursor] === ' ') {
    cursor += 1;
  }

  const quote = expression[cursor];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }

  const quoteEnd = findQuotedStringEnd(expression, cursor);
  if (quoteEnd === undefined) {
    return undefined;
  }

  // JSONPath-plus retains the raw content of a bracket-property literal. Use
  // escaping only to find its closing quote, then keep its key untouched so
  // a `\\u` sequence names the same input it would name in JSONPath-plus.
  const baseName = expression.slice(cursor + 1, quoteEnd);
  if (!baseName) {
    return undefined;
  }

  cursor = quoteEnd + 1;
  while (expression[cursor] === ' ') {
    cursor += 1;
  }

  if (expression[cursor] !== ']') {
    return undefined;
  }

  const suffix = expression.slice(cursor + 1).trimStart();
  if (suffix !== '' && !suffix.startsWith('.') && !suffix.startsWith('[')) {
    return undefined;
  }

  return { baseName, suffix: suffix || undefined };
}

function parseBaseReference(
  expression: string,
  source: InterpolationReferenceSource,
): ParsedInterpolationExpression | undefined {
  const trimmedExpression = expression.trim();
  if (!trimmedExpression) {
    return undefined;
  }

  const quotedReference = parseQuotedBaseReference(trimmedExpression);
  if (quotedReference) {
    return {
      source,
      baseName: quotedReference.baseName,
      jsonPath: quotedReference.suffix ? normalizeJsonPathExpression(`$${quotedReference.suffix}`) : undefined,
    };
  }

  let suffixStart = -1;
  for (let cursor = 0; cursor < trimmedExpression.length; cursor++) {
    const character = trimmedExpression[cursor];
    if (character === '.' || character === '[') {
      suffixStart = cursor;
      break;
    }
  }

  if (suffixStart === -1) {
    return {
      source,
      baseName: trimmedExpression,
      jsonPath: undefined,
    };
  }

  const baseName = trimmedExpression.slice(0, suffixStart).trim();
  const suffix = normalizeJsonPathExpression(trimmedExpression.slice(suffixStart));

  if (!baseName || (!suffix.startsWith('.') && !suffix.startsWith('['))) {
    return undefined;
  }

  return {
    source,
    baseName,
    jsonPath: `$${suffix}`,
  };
}

/**
 * Parses the authored portion of an interpolation token. Paths are always
 * rooted at the selected base value, so `foo.items[0]` becomes input `foo`
 * plus JSONPath `$.items[0]`.
 */
function parseInterpolationExpressionUncached(trimmedExpression: string): ParsedInterpolationExpression | undefined {
  for (const [prefix, source] of [
    ['@graphInputs', 'graphInputs'],
    ['@context', 'context'],
  ] as const) {
    if (trimmedExpression.startsWith(`${prefix}.`)) {
      return parseBaseReference(trimmedExpression.slice(prefix.length + 1), source);
    }

    if (trimmedExpression.startsWith(`${prefix}[`)) {
      return parseBaseReference(trimmedExpression.slice(prefix.length), source);
    }
  }

  return parseBaseReference(trimmedExpression, 'variable');
}

/**
 * Returns an immutable syntax record for internal resolution. This cache is
 * intentionally keyed only by expression text; resolved values are always
 * read from the current invocation's sources.
 */
function getCachedInterpolationExpression(expression: string): ParsedInterpolationExpression | undefined {
  const trimmedExpression = expression.trim();
  if (interpolationExpressionCache.has(trimmedExpression)) {
    return interpolationExpressionCache.get(trimmedExpression);
  }

  const parsed = parseInterpolationExpressionUncached(trimmedExpression);
  if (trimmedExpression.length > INTERPOLATION_EXPRESSION_CACHE_MAX_EXPRESSION_LENGTH) {
    return parsed;
  }

  if (
    interpolationExpressionCache.size >= INTERPOLATION_EXPRESSION_CACHE_MAX_ENTRIES ||
    cachedInterpolationExpressionChars + trimmedExpression.length > INTERPOLATION_EXPRESSION_CACHE_MAX_CHARS
  ) {
    interpolationExpressionCache.clear();
    cachedInterpolationExpressionChars = 0;
  }

  const immutableParsed = parsed ? (Object.freeze({ ...parsed }) as ParsedInterpolationExpression) : undefined;
  interpolationExpressionCache.set(trimmedExpression, immutableParsed);
  cachedInterpolationExpressionChars += trimmedExpression.length;
  return immutableParsed;
}

/**
 * Parses a public interpolation expression. Return a fresh record so callers
 * can safely mutate it without corrupting the internal syntax cache.
 */
export function parseInterpolationExpression(expression: string): ParsedInterpolationExpression | undefined {
  const parsed = getCachedInterpolationExpression(expression);
  return parsed ? { ...parsed } : undefined;
}

/** Splits an interpolation token into its expression, processor chain, and parsed reference. */
export function parseInterpolationToken(rawInner: string): Omit<ParsedInterpolationToken, 'span'> {
  const processorSeparator = findTopLevelProcessorSeparator(rawInner);
  const tokenName =
    (processorSeparator === undefined ? rawInner : rawInner.slice(0, processorSeparator)).trim() || undefined;
  const processingChain =
    processorSeparator === undefined ? undefined : rawInner.slice(processorSeparator + 1).trim() || undefined;

  return {
    rawInner,
    tokenName,
    processingChain,
    reference: tokenName ? parseInterpolationExpression(tokenName) : undefined,
  };
}

function freezeReference(
  reference: ParsedInterpolationExpression | undefined,
): ParsedInterpolationExpression | undefined {
  return reference ? Object.freeze({ ...reference }) : undefined;
}

function parseInterpolationTemplateUncached(template: string): ParsedInterpolationTemplate {
  const tokens = scanInterpolationTokenSpans(template).map((span) => {
    const parsedToken = parseInterpolationToken(span.rawInner);
    return Object.freeze({
      ...parsedToken,
      span: Object.freeze({ ...span }),
      reference: freezeReference(parsedToken.reference),
    });
  });

  return Object.freeze({
    template,
    tokens: Object.freeze(tokens),
  });
}

function getTemplateStorageChars(template: string, parsed: ParsedInterpolationTemplate): number {
  return (
    template.length +
    parsed.tokens.reduce(
      (total, token) => total + token.rawInner.length + (token.tokenName?.length ?? 0),
      parsed.tokens.length * 48,
    )
  );
}

function cacheInterpolationTemplate(template: string, parsed: ParsedInterpolationTemplate): void {
  if (template.length > INTERPOLATION_TEMPLATE_CACHE_MAX_TEMPLATE_LENGTH) {
    return;
  }

  const storageChars = getTemplateStorageChars(template, parsed);
  const reachesCapacity =
    interpolationTemplateCache.size >= INTERPOLATION_TEMPLATE_CACHE_MAX_ENTRIES ||
    cachedInterpolationTemplateChars + template.length > INTERPOLATION_TEMPLATE_CACHE_MAX_TEMPLATE_CHARS ||
    cachedInterpolationTemplateStorageChars + storageChars > INTERPOLATION_TEMPLATE_CACHE_MAX_STORAGE_CHARS;

  if (reachesCapacity) {
    // Avoid miss-by-miss eviction churn. A repeated miss proves this template is hot.
    if (lastUncachedInterpolationTemplate !== template) {
      lastUncachedInterpolationTemplate = template;
      return;
    }

    interpolationTemplateCache.clear();
    cachedInterpolationTemplateChars = 0;
    cachedInterpolationTemplateStorageChars = 0;
  }

  lastUncachedInterpolationTemplate = undefined;
  interpolationTemplateCache.set(template, {
    templateChars: template.length,
    storageChars,
    parsed,
  });
  cachedInterpolationTemplateChars += template.length;
  cachedInterpolationTemplateStorageChars += storageChars;
}

/** Returns an immutable, cached syntax representation. It never evaluates values. */
export function parseInterpolationTemplate(template: string): ParsedInterpolationTemplate {
  const cached = interpolationTemplateCache.get(template);
  if (cached) {
    return cached.parsed;
  }

  const parsed = parseInterpolationTemplateUncached(template);
  if (template.includes('{{')) {
    cacheInterpolationTemplate(template, parsed);
  }
  return parsed;
}

export function protectEscapedInterpolationTokens(template: string): string {
  return template.replace(ESCAPED_TOKEN_REGEX, (_match, expression) => `\\{\\{${expression}\\}\\}`);
}

export function restoreEscapedInterpolationTokens(template: string): string {
  return template
    .replace(ESCAPED_ESCAPED_TOKEN_REGEX, (_match, expression) => `{{${expression}}}`)
    .replace(ESCAPED_TOKEN_REGEX, (_match, expression) => `{{${expression}}}`);
}

export function findInterpolationTokenSpans(template: string): InterpolationTokenSpan[] {
  return parseInterpolationTemplate(template).tokens.map((token) => ({ ...token.span }));
}

/** Returns the pre-processor expression, retaining its authored path syntax. */
export function getInterpolationTokenName(rawInner: string): string | undefined {
  return parseInterpolationToken(rawInner).tokenName;
}

export function getInterpolationTokenReference(rawInner: string): ParsedInterpolationExpression | undefined {
  return parseInterpolationToken(rawInner).reference;
}

export function replaceInterpolationTokens(
  template: string,
  getReplacement: (token: InterpolationTokenReplacementInfo) => string,
  options: ReplaceInterpolationTokensOptions = {},
): string {
  const parsedTemplate = parseInterpolationTemplate(template);

  if (parsedTemplate.tokens.length === 0) {
    const restoredTemplate = restoreEscapedInterpolationTokens(template);
    return options.trim ? restoredTemplate.trim() : restoredTemplate;
  }

  let result = '';
  let cursor = 0;

  for (const token of parsedTemplate.tokens) {
    // Restore escaped delimiters only from authored template text. A
    // replacement may deliberately contain `{{{...}}}` or `\\{\\{...\\}\\}` and
    // must be returned unchanged rather than interpreted as template syntax.
    result += restoreEscapedInterpolationTokens(template.slice(cursor, token.span.start));
    result += getReplacement({
      rawInner: token.rawInner,
      span: { ...token.span },
      tokenName: token.tokenName,
      processingChain: token.processingChain,
      reference: token.reference ? { ...token.reference } : undefined,
    });
    cursor = token.span.end;
  }

  result += restoreEscapedInterpolationTokens(template.slice(cursor));
  return options.trim ? result.trim() : result;
}

/**
 * Discovers connectable interpolation bases in first-occurrence order. Special
 * graph/context references are intentionally omitted because they do not make ports.
 */
export function extractInterpolationVariableReferences(template: string): InterpolationVariableReference[] {
  if (!template.includes('{{')) {
    return [];
  }

  const discovered = new Map<string, InterpolationVariableReference>();

  for (const token of parseInterpolationTemplate(template).tokens) {
    const reference = token.reference;
    if (!reference || reference.source !== 'variable') {
      continue;
    }

    const existing = discovered.get(reference.baseName);
    if (existing) {
      existing.hasPath ||= reference.jsonPath !== undefined;
      continue;
    }

    discovered.set(reference.baseName, {
      baseName: reference.baseName,
      hasPath: reference.jsonPath !== undefined,
    });
  }

  return Array.from(discovered.values(), (reference) => ({ ...reference }));
}

/** Extracts base port names only. Prefer `extractInterpolationVariableReferences` when type selection matters. */
export function extractInterpolationVariables(template: string): string[] {
  return extractInterpolationVariableReferences(template).map((reference) => reference.baseName);
}

function getInterpolationSource(
  reference: ParsedInterpolationExpression,
  sources: InterpolationValueSources,
): Record<string, unknown> | undefined {
  switch (reference.source) {
    case 'variable':
      return sources.variables;
    case 'graphInputs':
      return sources.graphInputValues;
    case 'context':
      return sources.contextValues;
  }
}

/**
 * Resolves one parsed interpolation expression from raw values. JSONPath uses
 * `wrap: false`, matching Destructure exactly; callers decide how to render a
 * missing value or a selected object.
 */
export function resolveInterpolationExpressionRawValue(
  expression: string | ParsedInterpolationExpression,
  sources: InterpolationValueSources,
): unknown | undefined {
  const reference = typeof expression === 'string' ? getCachedInterpolationExpression(expression) : expression;
  if (!reference) {
    return undefined;
  }

  const source = getInterpolationSource(reference, sources);
  if (!source || !Object.prototype.hasOwnProperty.call(source, reference.baseName)) {
    return undefined;
  }

  const shouldUnwrapDataValue = reference.source !== 'variable' || sources.unwrapVariableDataValues !== false;
  const baseValue = shouldUnwrapDataValue
    ? unwrapPotentialDataValue(source[reference.baseName])
    : source[reference.baseName];
  if (reference.jsonPath === undefined) {
    return baseValue;
  }

  try {
    return evaluateJsonPath(baseValue, reference.jsonPath, false);
  } catch {
    return undefined;
  }
}

export function resolveInterpolationTokenRawValue(
  rawInner: string,
  sources: InterpolationValueSources,
): unknown | undefined {
  const reference = parseInterpolationToken(rawInner).reference;
  return reference ? resolveInterpolationExpressionRawValue(reference, sources) : undefined;
}

/** Backward-compatible special-reference resolver used by existing nodes. */
export function resolveExpressionRawValue(
  source: Record<string, unknown> | undefined,
  expression: string,
  sourceType: 'graphInputs' | 'context',
): unknown | undefined {
  return resolveInterpolationExpressionRawValue(`@${sourceType}.${expression}`, {
    graphInputValues: sourceType === 'graphInputs' ? source : undefined,
    contextValues: sourceType === 'context' ? source : undefined,
  });
}

function stringifyInterpolationValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      console.warn('Error stringifying an interpolation value:', error);
      return '[object Object]';
    }
  }

  return String(value);
}

export function resolveExpressionToString(
  source: Record<string, unknown> | undefined,
  expression: string,
  sourceType: 'graphInputs' | 'context',
): string | undefined {
  const finalValue = resolveExpressionRawValue(source, expression, sourceType);
  return finalValue === undefined ? undefined : stringifyInterpolationValue(finalValue);
}

function parseProcessing(instruction: string): { func: string; param?: number } {
  const parts = instruction.trim().split(/\s+/);
  return {
    func: parts[0]!,
    param: parts[1] ? Number.parseInt(parts[1], 10) : undefined,
  };
}

function applyProcessing(value: string, processingChain: string): string {
  const instructions = processingChain
    .split('|')
    .map((instruction) => instruction.trim())
    .filter((instruction) => instruction !== '');

  return instructions.reduce((result, instruction) => {
    const { func, param } = parseProcessing(instruction);
    const processingFunc = processingFunctions[func];

    if (!processingFunc) {
      console.warn(`Unknown processing function: ${func}`);
      return result;
    }

    return processingFunc(result, param);
  }, value);
}

/**
 * Resolves text interpolation. Bare ordinary variables keep the historical
 * string coercion; path-bearing references select raw data first and serialize
 * selected objects/arrays as JSON.
 */
export function interpolate(
  template: string,
  variables: Record<string, unknown>,
  graphInputValues?: Record<string, DataValue>,
  contextValues?: Record<string, DataValue>,
  options: InterpolateOptions = {},
): string {
  return replaceInterpolationTokens(template, (token) => {
    if (!token.reference) {
      return '';
    }

    const resolvedValue = resolveInterpolationExpressionRawValue(token.reference, {
      variables,
      graphInputValues,
      contextValues,
      unwrapVariableDataValues: options.unwrapVariableDataValues,
    });

    if (resolvedValue === undefined) {
      console.warn(`Interpolation variable or path "${token.tokenName}" not found or resolved to undefined.`);
      return '';
    }

    const isBareOrdinaryVariable = token.reference.source === 'variable' && token.reference.jsonPath === undefined;
    const stringValue = isBareOrdinaryVariable
      ? stringifyInterpolationSourceValue(variables[token.reference.baseName], {
          coerceDataValueToString: options.coerceBareVariableDataValues,
          unwrapDataValue: options.unwrapVariableDataValues !== false,
        })
      : stringifyInterpolationValue(resolvedValue);
    return token.processingChain ? applyProcessing(stringValue, token.processingChain) : stringValue;
  });
}

/** Runtime helper injected into JavaScript runners without exposing the whole Rivet API. */
export function resolveCodeInterpolationExpression(
  inputs: Record<string, DataValue | undefined>,
  expression: string,
  graphInputValues?: Record<string, DataValue>,
  contextValues?: Record<string, DataValue>,
): unknown | undefined {
  return resolveInterpolationExpressionRawValue(expression, {
    variables: inputs,
    graphInputValues,
    contextValues,
  });
}

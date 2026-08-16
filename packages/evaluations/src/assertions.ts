import { assertPortableJson, canonicalStringify } from './canonical.js';
import type { EvaluationAssertion, EvaluationDatasetCase, EvaluationObservation, PortableJson } from './types.js';

function readQuotedPathKey(source: string, start: number): { key: string; cursor: number } | undefined {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return undefined;
  let cursor = start + 1;
  let key = '';
  while (cursor < source.length) {
    const character = source[cursor++]!;
    if (character === quote) return { key, cursor };
    if (character !== '\\') {
      key += character;
      continue;
    }
    const escaped = source[cursor++];
    if (escaped === undefined) return undefined;
    if (escaped === 'u') {
      const hex = source.slice(cursor, cursor + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      key += String.fromCharCode(Number.parseInt(hex, 16));
      cursor += 4;
      continue;
    }
    const escapes: Record<string, string> = {
      '"': '"',
      "'": "'",
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (!(escaped in escapes)) return undefined;
    key += escapes[escaped]!;
  }
  return undefined;
}

type EvaluationOutputPathSegment = { kind: 'property'; key: string } | { kind: 'index'; index: number };

function parseEvaluationOutputPath(path: string): EvaluationOutputPathSegment[] | undefined {
  const source = path.trim();
  if (source === '$') return [];
  if (!source.startsWith('$') || source.length === 1) return undefined;
  let cursor = 1;
  const segments: EvaluationOutputPathSegment[] = [];
  // Validate every character. A partially parsed selector could otherwise
  // assert against a different output than the author wrote (for example
  // `$.answer!`). Dot notation intentionally remains identifier-only; quoted
  // bracket notation covers output names containing spaces, dots, or dashes.
  while (cursor < source.length) {
    if (source[cursor] === '.') {
      cursor += 1;
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
      const identifier = /^[A-Za-z_$][\w$]*/u.exec(source.slice(cursor));
      if (!identifier) return undefined;
      segments.push({ kind: 'property', key: identifier[0] });
      cursor += identifier[0].length;
    } else if (source[cursor] === '[') {
      cursor += 1;
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
      const quoted = readQuotedPathKey(source, cursor);
      if (quoted) {
        segments.push({ kind: 'property', key: quoted.key });
        cursor = quoted.cursor;
      } else {
        const index = /^\d+/u.exec(source.slice(cursor));
        if (!index) return undefined;
        segments.push({ kind: 'index', index: Number(index[0]) });
        cursor += index[0].length;
      }
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
      if (source[cursor] !== ']') return undefined;
      cursor += 1;
    } else {
      return undefined;
    }
  }
  return segments;
}

/**
 * Validates the exact JSON-path subset supported by evaluation assertions.
 * UI authoring and runtime execution intentionally share this parser so a
 * path cannot pass preflight and then resolve with different grammar.
 */
export function isEvaluationOutputPathSyntaxValid(path: string): boolean {
  return parseEvaluationOutputPath(path) !== undefined;
}

function getPath(value: PortableJson, path: string): PortableJson | undefined {
  const segments = parseEvaluationOutputPath(path);
  if (!segments) return undefined;
  let current: PortableJson | undefined = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (segment.kind !== 'index') return undefined;
      const index = segment.index;
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (segment.kind !== 'property') return undefined;
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment.key)) return undefined;
    current = current[segment.key];
  }
  return current;
}

function expectedValue(assertion: EvaluationAssertion, testCase: EvaluationDatasetCase): PortableJson {
  if (assertion.expected.kind === 'literal') return assertion.expected.value;
  const value = testCase.values[assertion.expected.fieldId];
  if (value === undefined) throw new Error(`Expected dataset field "${assertion.expected.fieldId}" is missing.`);
  return value;
}

function typeMatches(actual: PortableJson | undefined, expected: PortableJson): boolean {
  if (typeof expected !== 'string') return false;
  if (actual === undefined) return false;
  if (expected === 'array') return Array.isArray(actual);
  if (expected === 'null') return actual === null;
  if (expected === 'object') return actual !== null && typeof actual === 'object' && !Array.isArray(actual);
  return typeof actual === expected;
}

function expectedTextList(assertion: EvaluationAssertion, expected: PortableJson): string[] {
  if (!Array.isArray(expected) || expected.length === 0 || expected.some((value) => typeof value !== 'string')) {
    throw new Error(`Quality check "${assertion.name}" requires a non-empty array of expected text values.`);
  }
  return expected as string[];
}

function assertionConfigurationError(assertion: EvaluationAssertion, message: string): never {
  throw new Error(`Quality check "${assertion.name}" ${message}`);
}

const ASSERTION_TYPE_NAMES = new Set(['array', 'boolean', 'null', 'number', 'object', 'string']);

function expectedTypeName(assertion: EvaluationAssertion, expected: PortableJson): string {
  if (typeof expected !== 'string' || !ASSERTION_TYPE_NAMES.has(expected)) {
    assertionConfigurationError(
      assertion,
      'requires one of these expected type names: array, boolean, null, number, object, or string.',
    );
  }
  return expected;
}

function expectedString(assertion: EvaluationAssertion, expected: PortableJson, description: string): string {
  if (typeof expected !== 'string') {
    assertionConfigurationError(assertion, `requires ${description} to be a string.`);
  }
  return expected;
}

function expectedFiniteNumber(assertion: EvaluationAssertion, expected: PortableJson, description: string): number {
  if (typeof expected !== 'number' || !Number.isFinite(expected)) {
    assertionConfigurationError(assertion, `requires ${description} to be a finite number.`);
  }
  return expected;
}

function expectedNumberRange(assertion: EvaluationAssertion, expected: PortableJson): [number, number] {
  if (
    !Array.isArray(expected) ||
    expected.length !== 2 ||
    typeof expected[0] !== 'number' ||
    !Number.isFinite(expected[0]) ||
    typeof expected[1] !== 'number' ||
    !Number.isFinite(expected[1])
  ) {
    assertionConfigurationError(assertion, 'requires an expected range containing exactly two finite numbers.');
  }
  if (expected[0] > expected[1]) {
    assertionConfigurationError(assertion, 'requires its expected range minimum to be no greater than its maximum.');
  }
  return expected as [number, number];
}

function expectedSet(assertion: EvaluationAssertion, expected: PortableJson): PortableJson[] {
  if (!Array.isArray(expected)) assertionConfigurationError(assertion, 'requires the expected set to be an array.');
  return expected;
}

function operatorDescription(operator: EvaluationAssertion['operator']): string {
  switch (operator) {
    case 'equals':
      return 'equals';
    case 'not-equals':
      return 'does not equal';
    case 'contains':
      return 'contains the expected text';
    case 'matches-regex':
      return 'matches the regular expression';
    case 'type-is':
      return 'has the expected type';
    case 'json-schema':
      return 'matches the JSON Schema';
    case 'number-at-least':
      return 'is at least the expected value';
    case 'number-at-most':
      return 'is at most the expected value';
    case 'number-between':
      return 'is inside the expected range';
    case 'array-includes':
      return 'includes the expected value';
    case 'set-overlaps':
      return 'overlaps the expected set';
    case 'contains-any':
      return 'contains any expected text';
    case 'contains-all':
      return 'contains every expected text';
  }
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'type',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'items',
  'required',
  'properties',
  'additionalProperties',
]);
const SUPPORTED_SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);

function schemaRecord(
  assertion: EvaluationAssertion,
  schema: PortableJson,
  path: string,
): Record<string, PortableJson> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    assertionConfigurationError(assertion, `requires the JSON Schema at ${path} to be an object.`);
  }
  return schema as Record<string, PortableJson>;
}

function assertNonNegativeInteger(
  assertion: EvaluationAssertion,
  value: PortableJson,
  path: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    assertionConfigurationError(assertion, `requires ${path} to be a non-negative safe integer.`);
  }
}

/**
 * Validates the exact JSON Schema subset implemented below. Rejecting unknown
 * constraints is essential: silently ignoring one can turn a schema that
 * appears strict into a false quality pass.
 */
function assertSupportedJsonSchema(
  assertion: EvaluationAssertion,
  schema: PortableJson,
  path = '$',
): asserts schema is Record<string, PortableJson> {
  const objectSchema = schemaRecord(assertion, schema, path);
  for (const keyword of Object.keys(objectSchema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      assertionConfigurationError(assertion, `uses unsupported JSON Schema keyword "${keyword}" at ${path}.`);
    }
  }

  if (objectSchema.type !== undefined) {
    if (typeof objectSchema.type !== 'string' || !SUPPORTED_SCHEMA_TYPES.has(objectSchema.type)) {
      assertionConfigurationError(
        assertion,
        `requires ${path}.type to be one of: array, boolean, integer, null, number, object, or string.`,
      );
    }
  }
  if (objectSchema.enum !== undefined && (!Array.isArray(objectSchema.enum) || objectSchema.enum.length === 0)) {
    assertionConfigurationError(assertion, `requires ${path}.enum to be a non-empty array.`);
  }

  for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (objectSchema[keyword] !== undefined)
      assertNonNegativeInteger(assertion, objectSchema[keyword], `${path}.${keyword}`);
  }
  if (
    typeof objectSchema.minLength === 'number' &&
    typeof objectSchema.maxLength === 'number' &&
    objectSchema.minLength > objectSchema.maxLength
  ) {
    assertionConfigurationError(assertion, `requires ${path}.minLength to be no greater than ${path}.maxLength.`);
  }
  if (
    typeof objectSchema.minItems === 'number' &&
    typeof objectSchema.maxItems === 'number' &&
    objectSchema.minItems > objectSchema.maxItems
  ) {
    assertionConfigurationError(assertion, `requires ${path}.minItems to be no greater than ${path}.maxItems.`);
  }

  for (const keyword of ['minimum', 'maximum'] as const) {
    const value = objectSchema[keyword];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      assertionConfigurationError(assertion, `requires ${path}.${keyword} to be a finite number.`);
    }
  }
  if (
    typeof objectSchema.minimum === 'number' &&
    typeof objectSchema.maximum === 'number' &&
    objectSchema.minimum > objectSchema.maximum
  ) {
    assertionConfigurationError(assertion, `requires ${path}.minimum to be no greater than ${path}.maximum.`);
  }

  if (objectSchema.pattern !== undefined) {
    if (typeof objectSchema.pattern !== 'string') {
      assertionConfigurationError(assertion, `requires ${path}.pattern to be a string.`);
    }
    try {
      new RegExp(objectSchema.pattern);
    } catch {
      assertionConfigurationError(assertion, `contains an invalid regular expression at ${path}.pattern.`);
    }
  }
  if (objectSchema.required !== undefined) {
    if (
      !Array.isArray(objectSchema.required) ||
      objectSchema.required.some((key) => typeof key !== 'string' || key.length === 0) ||
      new Set(objectSchema.required).size !== objectSchema.required.length
    ) {
      assertionConfigurationError(assertion, `requires ${path}.required to contain unique, non-empty strings.`);
    }
  }
  if (objectSchema.additionalProperties !== undefined && typeof objectSchema.additionalProperties !== 'boolean') {
    assertionConfigurationError(assertion, `supports only a boolean ${path}.additionalProperties value.`);
  }
  if (objectSchema.items !== undefined) {
    assertSupportedJsonSchema(assertion, objectSchema.items, `${path}.items`);
  }
  if (objectSchema.properties !== undefined) {
    const properties = schemaRecord(assertion, objectSchema.properties, `${path}.properties`);
    for (const [key, childSchema] of Object.entries(properties)) {
      assertSupportedJsonSchema(assertion, childSchema, `${path}.properties[${JSON.stringify(key)}]`);
    }
  }
}

function schemaTypeMatches(actual: PortableJson, expected: string): boolean {
  if (expected === 'integer') return typeof actual === 'number' && Number.isInteger(actual);
  return typeMatches(actual, expected);
}

/** Evaluate the validated, deliberately portable JSON Schema subset. */
function matchesSchema(actual: PortableJson | undefined, schema: PortableJson): boolean {
  if (actual === undefined) return false;
  const objectSchema = schema as Record<string, PortableJson>;
  const declaredType = objectSchema.type;
  if (typeof declaredType === 'string' && !schemaTypeMatches(actual, declaredType)) return false;
  if (
    Array.isArray(objectSchema.enum) &&
    !objectSchema.enum.some((candidate) => canonicalStringify(candidate) === canonicalStringify(actual ?? null))
  )
    return false;
  if (
    Object.hasOwn(objectSchema, 'const') &&
    canonicalStringify(objectSchema.const) !== canonicalStringify(actual ?? null)
  )
    return false;

  if (typeof actual === 'string') {
    if (typeof objectSchema.minLength === 'number' && actual.length < objectSchema.minLength) return false;
    if (typeof objectSchema.maxLength === 'number' && actual.length > objectSchema.maxLength) return false;
    if (typeof objectSchema.pattern === 'string') {
      if (!new RegExp(objectSchema.pattern).test(actual)) return false;
    }
  }
  if (typeof actual === 'number') {
    if (typeof objectSchema.minimum === 'number' && actual < objectSchema.minimum) return false;
    if (typeof objectSchema.maximum === 'number' && actual > objectSchema.maximum) return false;
  }
  if (Array.isArray(actual)) {
    if (typeof objectSchema.minItems === 'number' && actual.length < objectSchema.minItems) return false;
    if (typeof objectSchema.maxItems === 'number' && actual.length > objectSchema.maxItems) return false;
    if (objectSchema.items !== undefined && !actual.every((item) => matchesSchema(item, objectSchema.items!)))
      return false;
  }
  if (actual !== null && typeof actual === 'object' && !Array.isArray(actual)) {
    const record = actual as Record<string, PortableJson>;
    if (
      Array.isArray(objectSchema.required) &&
      !objectSchema.required.every((key) => typeof key === 'string' && Object.hasOwn(record, key))
    )
      return false;
    const properties = objectSchema.properties;
    if (properties !== undefined) {
      const propertySchemas = properties as Record<string, PortableJson>;
      for (const [key, childSchema] of Object.entries(propertySchemas)) {
        if (Object.hasOwn(record, key) && !matchesSchema(record[key], childSchema)) return false;
      }
    }
    if (objectSchema.additionalProperties === false) {
      const propertySchemas = (properties ?? {}) as Record<string, PortableJson>;
      if (Object.keys(record).some((key) => !Object.hasOwn(propertySchemas, key))) return false;
    }
  }
  return true;
}

export function evaluateAssertion(
  assertion: EvaluationAssertion,
  outputs: Record<string, PortableJson>,
  testCase: EvaluationDatasetCase,
): EvaluationObservation {
  const outputRoot: PortableJson = outputs;
  const actual = getPath(outputRoot, assertion.outputPath);
  const actualFound = actual !== undefined;
  const expected = expectedValue(assertion, testCase);
  assertPortableJson(expected);
  let passed = false;
  switch (assertion.operator) {
    case 'equals':
      passed = actual !== undefined && canonicalStringify(actual) === canonicalStringify(expected);
      break;
    case 'not-equals':
      // A configured path must resolve before any comparison can pass. Treating
      // a missing value as "not equal" would let a typo in an output path turn
      // into a false quality pass.
      passed = actual !== undefined && canonicalStringify(actual) !== canonicalStringify(expected);
      break;
    case 'contains':
      {
        const expectedText = expectedString(assertion, expected, 'its expected text');
        passed = typeof actual === 'string' && actual.includes(expectedText);
      }
      break;
    case 'matches-regex':
      // Invalid author-supplied expressions are evaluator configuration
      // errors. Let the runner report that quality could not be evaluated instead
      // of reporting a normal failed quality assertion.
      {
        const expectedPattern = expectedString(assertion, expected, 'its expected regular expression');
        let pattern: RegExp;
        try {
          pattern = new RegExp(expectedPattern);
        } catch {
          assertionConfigurationError(assertion, 'contains an invalid expected regular expression.');
        }
        passed = typeof actual === 'string' && pattern.test(actual);
      }
      break;
    case 'type-is':
      passed = typeMatches(actual, expectedTypeName(assertion, expected));
      break;
    case 'json-schema':
      assertSupportedJsonSchema(assertion, expected);
      passed = matchesSchema(actual, expected);
      break;
    case 'number-at-least':
      {
        const minimum = expectedFiniteNumber(assertion, expected, 'its expected minimum');
        passed = typeof actual === 'number' && actual >= minimum;
      }
      break;
    case 'number-at-most':
      {
        const maximum = expectedFiniteNumber(assertion, expected, 'its expected maximum');
        passed = typeof actual === 'number' && actual <= maximum;
      }
      break;
    case 'number-between':
      {
        const [minimum, maximum] = expectedNumberRange(assertion, expected);
        passed = typeof actual === 'number' && actual >= minimum && actual <= maximum;
      }
      break;
    case 'array-includes':
      passed =
        Array.isArray(actual) && actual.some((item) => canonicalStringify(item) === canonicalStringify(expected));
      break;
    case 'set-overlaps':
      {
        const candidates = expectedSet(assertion, expected);
        passed =
          Array.isArray(actual) &&
          candidates.some((candidate) =>
            actual.some((item) => canonicalStringify(item) === canonicalStringify(candidate)),
          );
      }
      break;
    case 'contains-any':
      {
        const expectedTexts = expectedTextList(assertion, expected);
        passed = typeof actual === 'string' && expectedTexts.some((candidate) => actual.includes(candidate));
      }
      break;
    case 'contains-all':
      {
        const expectedTexts = expectedTextList(assertion, expected);
        passed = typeof actual === 'string' && expectedTexts.every((candidate) => actual.includes(candidate));
      }
      break;
  }
  const requirement = operatorDescription(assertion.operator);
  return {
    id: assertion.id,
    kind: 'assertion',
    name: assertion.name,
    required: assertion.required !== false,
    status: passed ? 'passed' : 'failed',
    message: passed
      ? `Target output ${requirement}.`
      : actualFound
        ? `Target output does not satisfy the requirement: ${requirement}.`
        : `Target output path "${assertion.outputPath}" does not exist.`,
    evidence: {
      actual: actual ?? null,
      actualFound,
      expected,
      outputPath: assertion.outputPath,
      operator: assertion.operator,
      expectedSource: assertion.expected.kind,
      ...(assertion.expected.kind === 'dataset-field' ? { expectedFieldId: assertion.expected.fieldId } : {}),
    },
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateAssertion,
  isEvaluationOutputPathSyntaxValid,
  type EvaluationAssertion,
  type PortableJson,
} from '../src/index.js';

function assertion(overrides: Partial<EvaluationAssertion> = {}): EvaluationAssertion {
  return {
    id: 'assertion',
    name: 'Assertion',
    outputPath: '$',
    operator: 'equals',
    expected: { kind: 'literal', value: null },
    ...overrides,
  };
}

const testCase = { id: 'case', name: 'Case', values: {} };

test('supports object and array segments in output JSON paths', () => {
  const observation = evaluateAssertion(
    assertion({ outputPath: '$.choices[1].answer', expected: { kind: 'literal', value: 'second' } }),
    { choices: [{ answer: 'first' }, { answer: 'second' }] },
    testCase,
  );
  assert.equal(observation.status, 'passed');
});

test('exports the exact output-path syntax validator used by assertion execution', () => {
  for (const path of ['$', '$.answer', '$.choices[1].answer', '$["answer.with spaces"]', " $['quoted'] "]) {
    assert.equal(isEvaluationOutputPathSyntaxValid(path), true, path);
  }
  for (const path of ['', 'answer', '$.', '$.answer!', '$[missing]', '$["unterminated]']) {
    assert.equal(isEvaluationOutputPathSyntaxValid(path), false, path);
  }
});

test('does not treat a missing output path as a null output', () => {
  const observation = evaluateAssertion(
    assertion({ outputPath: '$.missing', expected: { kind: 'literal', value: null } }),
    { answer: 'present' },
    testCase,
  );
  assert.equal(observation.status, 'failed');
});

test('does not let not-equals pass when its configured output path is missing', () => {
  const observation = evaluateAssertion(
    assertion({
      outputPath: '$.missing',
      operator: 'not-equals',
      expected: { kind: 'literal', value: 'anything' },
    }),
    { answer: 'present' },
    testCase,
  );
  assert.equal(observation.status, 'failed');
});

test('rejects malformed output JSON paths as configuration errors instead of partially matching them', () => {
  assert.throws(
    () =>
      evaluateAssertion(
        assertion({ outputPath: '$.answer!', expected: { kind: 'literal', value: 'expected' } }),
        { answer: 'expected' },
        testCase,
      ),
    /invalid output path/,
  );
});

test('does not treat null or arrays as object values', () => {
  for (const value of [null, []] as const) {
    const observation = evaluateAssertion(
      assertion({ outputPath: '$.value', operator: 'type-is', expected: { kind: 'literal', value: 'object' } }),
      { value },
      testCase,
    );
    assert.equal(observation.status, 'failed');
  }
});

test('deep equality distinguishes equal values, unequal values, and different JSON types', () => {
  const equal = evaluateAssertion(
    assertion({ outputPath: '$.answer', expected: { kind: 'literal', value: ['singer'] } }),
    { answer: ['singer'] },
    testCase,
  );
  const unequal = evaluateAssertion(
    assertion({ outputPath: '$.answer', expected: { kind: 'literal', value: ['dancer'] } }),
    { answer: ['singer'] },
    testCase,
  );
  const differentType = evaluateAssertion(
    assertion({ outputPath: '$.answer', expected: { kind: 'literal', value: ['singer'] } }),
    { answer: 'singer' },
    testCase,
  );

  assert.equal(equal.status, 'passed');
  assert.equal(unequal.status, 'failed');
  assert.equal(differentType.status, 'failed');
});

test('contains-any and contains-all search exact expected text inside a target string', () => {
  const outputs = { answer: 'Michael Jackson was a singer and dancer.' };
  const any = evaluateAssertion(
    assertion({
      outputPath: '$.answer',
      operator: 'contains-any',
      expected: { kind: 'literal', value: ['astronaut', 'singer'] },
    }),
    outputs,
    testCase,
  );
  const all = evaluateAssertion(
    assertion({
      outputPath: '$.answer',
      operator: 'contains-all',
      expected: { kind: 'literal', value: ['singer', 'dancer'] },
    }),
    outputs,
    testCase,
  );
  const caseSensitiveMiss = evaluateAssertion(
    assertion({
      outputPath: '$.answer',
      operator: 'contains-any',
      expected: { kind: 'literal', value: ['Singer'] },
    }),
    outputs,
    testCase,
  );

  assert.equal(any.status, 'passed');
  assert.equal(all.status, 'passed');
  assert.equal(caseSensitiveMiss.status, 'failed');
});

test('contains-all fails when even one expected text is missing', () => {
  const observation = evaluateAssertion(
    assertion({
      outputPath: '$.answer',
      operator: 'contains-all',
      expected: { kind: 'literal', value: ['singer', 'astronaut'] },
    }),
    { answer: 'Michael Jackson was a singer and dancer.' },
    testCase,
  );
  assert.equal(observation.status, 'failed');
});

test('contains-any does not reinterpret an array output as searchable text', () => {
  const observation = evaluateAssertion(
    assertion({
      outputPath: '$.answer',
      operator: 'contains-any',
      expected: { kind: 'literal', value: ['singer'] },
    }),
    { answer: ['singer'] },
    testCase,
  );
  assert.equal(observation.status, 'failed');
});

test('contains-any and contains-all reject invalid or empty expected text lists', () => {
  const invalidExpectedValues: PortableJson[] = [[], ['valid', 1], 'singer'];
  for (const operator of ['contains-any', 'contains-all'] as const) {
    for (const expected of invalidExpectedValues) {
      assert.throws(
        () =>
          evaluateAssertion(
            assertion({ outputPath: '$.answer', operator, expected: { kind: 'literal', value: expected } }),
            { answer: 'singer' },
            testCase,
          ),
        /requires a non-empty array of expected text values/,
      );
    }
  }
});

test('supports quoted output keys without confusing dots or spaces for path separators', () => {
  const observation = evaluateAssertion(
    assertion({
      outputPath: '$["answer.with spaces"]',
      expected: { kind: 'literal', value: 'found' },
    }),
    { 'answer.with spaces': 'found' },
    testCase,
  );
  assert.equal(observation.status, 'passed');
});

test('JSON paths only traverse own properties', () => {
  const outputs = Object.create({ inherited: 'must not be visible' }) as Record<string, PortableJson>;
  outputs.answer = 'visible';

  const inherited = evaluateAssertion(
    assertion({ outputPath: '$.inherited', expected: { kind: 'literal', value: 'must not be visible' } }),
    outputs,
    testCase,
  );
  const own = evaluateAssertion(
    assertion({ outputPath: '$.answer', expected: { kind: 'literal', value: 'visible' } }),
    outputs,
    testCase,
  );
  const ownPrototypeNamedKey = evaluateAssertion(
    assertion({ outputPath: '$["__proto__"]', expected: { kind: 'literal', value: 'ordinary value' } }),
    JSON.parse('{"__proto__":"ordinary value"}') as Record<string, PortableJson>,
    testCase,
  );

  assert.equal(inherited.status, 'failed');
  assert.equal(own.status, 'passed');
  assert.equal(ownPrototypeNamedKey.status, 'passed');
});

test('validates the supported JSON Schema subset recursively', () => {
  const schema: PortableJson = {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['count'],
          properties: { count: { type: 'integer', minimum: 1 } },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  };
  const configuredAssertion = assertion({ operator: 'json-schema', expected: { kind: 'literal', value: schema } });

  assert.equal(evaluateAssertion(configuredAssertion, { items: [{ count: 2 }] }, testCase).status, 'passed');
  assert.equal(evaluateAssertion(configuredAssertion, { items: [{ count: 1.5 }] }, testCase).status, 'failed');
  assert.equal(
    evaluateAssertion(configuredAssertion, { items: [{ count: 2, ignored: true }] }, testCase).status,
    'failed',
  );
});

test('rejects unsupported JSON Schema keywords instead of silently ignoring them', () => {
  assert.throws(
    () =>
      evaluateAssertion(
        assertion({
          outputPath: '$.values',
          operator: 'json-schema',
          expected: {
            kind: 'literal',
            value: { type: 'array', items: { type: 'string', uniqueItems: true } },
          },
        }),
        { values: ['duplicate', 'duplicate'] },
        testCase,
      ),
    /unsupported JSON Schema keyword "uniqueItems"/,
  );
});

test('rejects malformed JSON Schema constraints as configuration errors', () => {
  const malformedSchemas: PortableJson[] = [
    { type: ['string', 'null'] },
    { enum: [] },
    { minItems: -1 },
    { minimum: 2, maximum: 1 },
    { pattern: '[' },
    { required: ['answer', 'answer'] },
    { additionalProperties: {} },
    { properties: { answer: 'not a schema' } },
  ];

  for (const schema of malformedSchemas) {
    assert.throws(() =>
      evaluateAssertion(
        assertion({ operator: 'json-schema', expected: { kind: 'literal', value: schema } }),
        { answer: 'value' },
        testCase,
      ),
    );
  }
});

test('rejects malformed operator expectations instead of reporting ordinary quality failures', () => {
  const invalidConfigurations: Array<Pick<EvaluationAssertion, 'operator' | 'expected'>> = [
    { operator: 'contains', expected: { kind: 'literal', value: ['text'] } },
    { operator: 'matches-regex', expected: { kind: 'literal', value: '[' } },
    { operator: 'type-is', expected: { kind: 'literal', value: 'integer' } },
    { operator: 'number-at-least', expected: { kind: 'literal', value: '1' } },
    { operator: 'number-at-most', expected: { kind: 'literal', value: null } },
    { operator: 'number-between', expected: { kind: 'literal', value: [2, 1] } },
    { operator: 'set-overlaps', expected: { kind: 'literal', value: 'value' } },
    { operator: 'contains-any', expected: { kind: 'literal', value: [] } },
  ];

  for (const configuration of invalidConfigurations) {
    assert.throws(() => evaluateAssertion(assertion({ outputPath: '$.missing', ...configuration }), {}, testCase));
  }
});

test('number-between includes both configured boundaries', () => {
  const configuredAssertion = assertion({
    outputPath: '$.value',
    operator: 'number-between',
    expected: { kind: 'literal', value: [1, 2] },
  });

  assert.equal(evaluateAssertion(configuredAssertion, { value: 1 }, testCase).status, 'passed');
  assert.equal(evaluateAssertion(configuredAssertion, { value: 2 }, testCase).status, 'passed');
  assert.equal(evaluateAssertion(configuredAssertion, { value: 2.01 }, testCase).status, 'failed');
});

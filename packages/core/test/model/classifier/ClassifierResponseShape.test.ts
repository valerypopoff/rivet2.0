import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  validateApiCompatibleClassifierResponse,
  ClassifierEvaluateNodeImpl,
  type ClassifierQuestionDefinition,
  type InternalProcessContext,
  type PortId,
} from '../../../src/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fixture() {
  const questions: ClassifierQuestionDefinition[] = [
    { questionId: 'choice', type: 'choice', instructions: 'Choose', criteria: { a: 'A', b: 'B' } },
    { questionId: 'score', type: 'score', instructions: 'Rate', criteria: ['low', 'high'] },
    { questionId: 'noul', type: 'noul', instructions: 'Decide' },
  ];
  const body = {
    model: 'jev-test',
    answers: {
      choice: { type: 'choice', choice: 'a', confidence: 2, probabilities: { a: -0.25, b: 4 } },
      score: {
        type: 'score',
        score: -12,
        confidence: -2,
        probabilities: { 0: 0.8, 1: 0.8 },
        legend: { 0: 'provider low', 1: 'provider high' },
      },
      noul: { type: 'noul', noul: 2.4 },
    },
    usage: { input_tokens: -0.5, output_tokens: Number.MAX_SAFE_INTEGER * 4 },
  };
  return { questions, body };
}

test('response validation trusts provider numbers and legend descriptions without modifying them', () => {
  const { questions, body } = fixture();
  const before = JSON.stringify(body);
  assert.equal(validateApiCompatibleClassifierResponse(body, questions), body);
  assert.equal(JSON.stringify(body), before);
});

test('response validation accepts zero, deficient and excessive probability totals unchanged', () => {
  for (const values of [
    [0, 0],
    [0.1, 0.1],
    [0.7, 0.7],
    [1, 1],
  ]) {
    const { questions, body } = fixture();
    body.answers.choice.probabilities = { a: values[0]!, b: values[1]! };
    assert.equal(validateApiCompatibleClassifierResponse(body, questions), body);
    assert.deepEqual(body.answers.choice.probabilities, { a: values[0], b: values[1] });
  }
});

test('response validation still rejects malformed envelopes, answer types and question mappings', () => {
  const { questions, body } = fixture();
  for (const invalid of [
    null,
    [],
    {},
    { ...body, model: null },
    { ...body, answers: [] },
    { ...body, usage: [] },
    { ...body, answers: {} },
    { ...body, answers: { ...body.answers, extra: body.answers.noul } },
    { ...body, answers: { ...body.answers, noul: { type: 'choice', noul: 0.5 } } },
  ]) {
    assert.throws(() => validateApiCompatibleClassifierResponse(invalid, questions));
  }
});

test('required response fields cannot be supplied by an inherited property', () => {
  const groups = [
    { name: 'envelope', fields: ['model', 'answers', 'usage'] },
    { name: 'choice', fields: ['type', 'choice', 'confidence', 'probabilities'] },
    { name: 'score', fields: ['type', 'score', 'confidence', 'probabilities', 'legend'] },
    { name: 'noul', fields: ['type', 'noul'] },
    { name: 'usage', fields: ['input_tokens', 'output_tokens'] },
  ] as const;
  for (const { name, fields } of groups) {
    for (const field of fields) {
      const { questions, body } = fixture();
      const record = (name === 'envelope' ? body : name === 'usage' ? body.usage : body.answers[name]) as Record<
        string,
        unknown
      >;
      const inherited = record[field];
      delete record[field];
      // Model a polluted prototype without mutating the global Object prototype.
      Object.setPrototypeOf(record, { [field]: inherited });
      assert.throws(
        () => validateApiCompatibleClassifierResponse(body, questions),
        /response/,
        `Inherited ${name}.${field} must not replace a required JSON field`,
      );
    }
  }
});

test('required response numbers cannot be missing, coerced from another type or non-finite', () => {
  for (const value of [undefined, null, '0.5', false, NaN, Infinity]) {
    const { questions, body } = fixture();
    const patches = [
      { ...body, usage: { ...body.usage, input_tokens: value } },
      { ...body, usage: { ...body.usage, output_tokens: value } },
      { ...body, answers: { ...body.answers, choice: { ...body.answers.choice, confidence: value } } },
      { ...body, answers: { ...body.answers, score: { ...body.answers.score, confidence: value } } },
      { ...body, answers: { ...body.answers, score: { ...body.answers.score, score: value } } },
      { ...body, answers: { ...body.answers, noul: { ...body.answers.noul, noul: value } } },
      {
        ...body,
        answers: { ...body.answers, choice: { ...body.answers.choice, probabilities: { a: value, b: 0.5 } } },
      },
      {
        ...body,
        answers: { ...body.answers, score: { ...body.answers.score, probabilities: { 0: value, 1: 0.5 } } },
      },
    ];
    const labels = [
      'usage.input_tokens',
      'usage.output_tokens',
      'choice.confidence',
      'score.confidence',
      'score.score',
      'noul.noul',
      'choice.probabilities.a',
      'score.probabilities.0',
    ];
    for (const [index, invalid] of patches.entries()) {
      assert.throws(() => validateApiCompatibleClassifierResponse(invalid, questions), {
        message: `Classifier provider response has invalid ${labels[index]}.`,
      });
    }
  }
});

test('probability and legend map shape remains tied to the sent option and level keys', () => {
  const { questions, body } = fixture();
  for (const probabilities of [null, [], { a: 0.5 }, { a: 0.5, c: 0.5 }, { a: 0.5, b: 0.5, c: 0 }]) {
    assert.throws(
      () =>
        validateApiCompatibleClassifierResponse(
          {
            ...body,
            answers: { ...body.answers, choice: { ...body.answers.choice, probabilities } },
          },
          questions,
        ),
      /probabilities/,
    );
  }
  for (const legend of [null, [], { 0: 'low' }, { 0: 'low', 2: 'high' }]) {
    assert.throws(
      () =>
        validateApiCompatibleClassifierResponse(
          {
            ...body,
            answers: { ...body.answers, score: { ...body.answers.score, legend } },
          },
          questions,
        ),
      /legend/,
    );
  }
});

test('shape validation preserves exact special question and option keys', () => {
  const questions: ClassifierQuestionDefinition[] = [
    {
      questionId: '__proto__',
      type: 'choice',
      instructions: 'Choose',
      criteria: JSON.parse('{"__proto__":null,"constructor":null,"01":null}'),
    },
  ];
  const body = JSON.parse(
    '{"model":"jev-test","answers":{"__proto__":{"type":"choice","choice":"constructor","confidence":2,"probabilities":{"01":0.25,"constructor":4,"__proto__":-0.25}}},"usage":{"input_tokens":1,"output_tokens":1}}',
  );
  assert.equal(validateApiCompatibleClassifierResponse(body, questions), body);
});

function evaluate(questions: ClassifierQuestionDefinition[], data: Partial<ClassifierEvaluateNodeImpl['data']>) {
  const node = ClassifierEvaluateNodeImpl.create();
  return new ClassifierEvaluateNodeImpl({ ...node, data: { ...node.data, ...data } }).process(
    { ['question1' as PortId]: { type: 'object[]', value: questions } },
    {
      executor: 'nodejs',
      signal: new AbortController().signal,
      settings: { classifierProviders: { jev: { apiKey: 'test-key' } } },
    } as InternalProcessContext,
  );
}

test('trusted provider numbers survive every output and failure-control combination, including a retry', async () => {
  for (let mask = 0; mask < 32; mask++) {
    const { questions, body } = fixture();
    const data = {
      catchRequestFailed: Boolean(mask & 1),
      errorOnNon200: Boolean(mask & 2),
      outputUsage: Boolean(mask & 4),
      outputRequestBody: Boolean(mask & 8),
      outputResponseBody: Boolean(mask & 16),
    };
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      if (requests === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify(body), { status: 201 });
    };
    const outputs = await evaluate(questions, data);
    assert.equal(requests, 2);
    assert.deepEqual(outputs.answers!.value, body.answers);
    // Unsafe accounting inputs omit calculated cost, never rewrite Usage or fail.
    assert.deepEqual(outputs.usage!.value, body.usage);
    const hasFailureOutputs = data.catchRequestFailed || !data.errorOnNon200;
    assert.equal(outputs.runFailed?.value, hasFailureOutputs ? false : undefined);
    assert.equal(outputs.runError?.type, hasFailureOutputs ? 'control-flow-excluded' : undefined);
    assert.equal(outputs.requestBody !== undefined, data.outputRequestBody);
    assert.equal(outputs.responseBody !== undefined, data.outputResponseBody);
    if (data.outputResponseBody) assert.deepEqual(outputs.responseBody!.value, body);
    if (data.outputRequestBody) {
      const sent = outputs.requestBody!.value as { questions: Record<string, unknown> };
      assert.deepEqual(
        Object.keys(sent.questions),
        questions.map((question) => question.questionId),
      );
    }
  }
});

test('malformed successful HTTP responses still fail closed and are never retried as status errors', async () => {
  const { questions, body } = fixture();
  const cases = [
    { json: '{broken', message: /invalid JSON response/ },
    { json: JSON.stringify({ ...body, answers: {} }), message: /submitted question IDs/ },
    {
      json: JSON.stringify({
        ...body,
        answers: { ...body.answers, choice: { ...body.answers.choice, choice: 'unsent' } },
      }),
      message: /unknown option/,
    },
    {
      json: JSON.stringify({
        ...body,
        answers: { ...body.answers, choice: { ...body.answers.choice, probabilities: null } },
      }),
      message: /invalid choice.probabilities/,
    },
    {
      json: JSON.stringify({
        ...body,
        answers: { ...body.answers, score: { ...body.answers.score, legend: { 0: 'low' } } },
      }),
      message: /inconsistent score.legend keys/,
    },
    {
      json: JSON.stringify({ ...body, usage: { ...body.usage, input_tokens: '1' } }),
      message: /invalid usage.input_tokens/,
    },
  ];
  for (const { json, message } of cases) {
    for (const catchRequestFailed of [false, true]) {
      for (const errorOnNon200 of [false, true]) {
        let requests = 0;
        globalThis.fetch = async () => {
          requests++;
          return new Response(json, { status: 200 });
        };
        const execution = evaluate(questions, {
          catchRequestFailed,
          errorOnNon200,
          retryOnNon200: true,
          outputUsage: true,
          outputRequestBody: true,
          outputResponseBody: true,
        });
        if (catchRequestFailed) {
          const outputs = await execution;
          assert.equal(outputs.runFailed!.value, true);
          assert.match(String(outputs.runError!.value), message);
          for (const port of ['answers', 'usage', 'requestBody', 'responseBody']) {
            assert.equal(outputs[port as PortId]!.type, 'control-flow-excluded');
          }
        } else {
          await assert.rejects(execution, message);
        }
        assert.equal(requests, 1, 'A malformed successful response must not enter the HTTP retry policy');
      }
    }
  }
});

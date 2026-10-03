import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jevClassifierProvider } from '../../../src/model/classifier/providers.js';
import type { ClassifierQuestionDefinition } from '../../../src/model/classifier/types.js';

function question(type: 'choice' | 'score'): ClassifierQuestionDefinition {
  return {
    questionId: 'q',
    type,
    instructions: 'Classify',
    criteria: type === 'choice' ? { a: 'A', b: 'B' } : [{ description: ['low'] }, 'high'],
  };
}

function responseFor(sent: { questions: Record<string, ClassifierQuestionDefinition> }) {
  return {
    model: 'jev-test',
    answers: Object.fromEntries(
      Object.entries(sent.questions).map(([id, q]) => [
        id,
        {
          type: q.type,
          confidence: 0.5,
          ...(q.type === 'choice'
            ? { choice: 'a', probabilities: { a: 0.5, b: 0.5 } }
            : {
                score: 0.5,
                probabilities: { 0: 0.5, 1: 0.5 },
                legend: Object.fromEntries((q.criteria as unknown[]).map((value, index) => [String(index), value])),
              }),
        },
      ]),
    ),
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

test('response validation uses the sent question snapshot despite concurrent identity, type, or criteria mutations', async () => {
  const cases: Array<{
    type: 'choice' | 'score';
    mutate(q: ClassifierQuestionDefinition, questions: ClassifierQuestionDefinition[]): void;
  }> = [
    {
      type: 'choice',
      mutate: (q) => {
        q.questionId = 'changed';
      },
    },
    {
      type: 'choice',
      mutate: (q) => {
        q.type = 'noul';
      },
    },
    {
      type: 'choice',
      mutate: (q) => {
        delete (q.criteria as Record<string, unknown>).b;
      },
    },
    {
      type: 'score',
      mutate: (q) => {
        (q.criteria as unknown[]).push('added');
      },
    },
    {
      type: 'score',
      mutate: (q) => {
        (q.criteria as Array<{ description: string[] }>)[0]!.description[0] = 'changed';
      },
    },
    {
      type: 'choice',
      mutate: (_q, questions) => {
        questions.push(question('choice'));
      },
    },
    {
      type: 'choice',
      mutate: (_q, questions) => {
        questions[0] = question('score');
      },
    },
  ];
  for (const { type, mutate } of cases) {
    for (const retry of [false, true]) {
      const q = question(type);
      const questions = [q];
      const sentBodies: unknown[] = [];
      let expected: ReturnType<typeof responseFor> | undefined;
      const result = await jevClassifierProvider.evaluate({
        apiKey: 'test-key',
        model: 'jev-latest',
        questions,
        state: '',
        signal: new AbortController().signal,
        timeoutMs: 1000,
        fetchImplementation: async (_url, init) => {
          const sent = JSON.parse(String(init?.body));
          sentBodies.push(sent);
          expected ??= responseFor(sent);
          if (sentBodies.length === 1) {
            mutate(q, questions);
            if (retry) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
          }
          return new Response(JSON.stringify(expected), { status: 200 });
        },
      });
      assert.deepEqual(result.response, expected);
      assert.equal(result.responseBody, result.response);
      assert.deepEqual(result.requestBody, sentBodies[0]);
      assert.equal(sentBodies.length, retry ? 2 : 1);
      if (retry) assert.deepEqual(sentBodies[1], sentBodies[0]);
    }
  }
});

test('mutation cannot make a response for unsent Choice options pass validation', async () => {
  const q = question('choice');
  await assert.rejects(
    jevClassifierProvider.evaluate({
      apiKey: 'test-key',
      model: 'jev-latest',
      questions: [q],
      state: '',
      signal: new AbortController().signal,
      timeoutMs: 1000,
      fetchImplementation: async () => {
        delete (q.criteria as Record<string, unknown>).b;
        (q.criteria as Record<string, unknown>).c = 'C';
        return new Response(
          JSON.stringify({
            model: 'jev-test',
            answers: { q: { type: 'choice', choice: 'a', confidence: 0.5, probabilities: { a: 0.5, c: 0.5 } } },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        );
      },
    }),
    /inconsistent .*probabilities keys/,
  );
});

test('the detached response contract preserves special question and option keys over HTTP JSON', async () => {
  const questions: ClassifierQuestionDefinition[] = ['__proto__', 'constructor', '01'].map((questionId) => ({
    questionId,
    type: 'choice',
    instructions: 'Classify',
    criteria: JSON.parse('{"__proto__":null,"constructor":null,"01":null}'),
  }));
  const result = await jevClassifierProvider.evaluate({
    apiKey: 'test-key',
    model: 'jev-latest',
    questions,
    state: '',
    signal: new AbortController().signal,
    timeoutMs: 1000,
    fetchImplementation: async (_url, init) => {
      const sent = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(
        Object.keys(sent.questions).map((id) => [
          id,
          {
            type: 'choice',
            choice: '__proto__',
            confidence: 0.5,
            probabilities: JSON.parse('{"01":0.25,"constructor":0.25,"__proto__":0.5}'),
          },
        ]),
      );
      return new Response(
        JSON.stringify({
          model: 'jev-test',
          answers,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    },
  });
  assert.deepEqual(Object.keys(result.response.answers).sort(), ['01', '__proto__', 'constructor']);
  assert.equal(result.responseBody, result.response);
});

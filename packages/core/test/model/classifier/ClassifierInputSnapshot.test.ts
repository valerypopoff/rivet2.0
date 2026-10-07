import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClassifierEvaluateNodeImpl, type DataValue, type InternalProcessContext } from '../../../src/index.js';
import { getClassifierProvider } from '../../../src/model/classifier/providers.js';
import { normalizeClassifierState } from '../../../src/model/classifier/state.js';
import { assertClassifierEntry } from '../../../src/model/classifier/json.js';

const question = () => ({ questionId: 'q', type: 'noul' as const, instructions: 'Is the state correct?' });
const context = {
  executor: 'nodejs',
  signal: new AbortController().signal,
  settings: {
    classifierProviders: { jev: { apiKey: 'test' }, liquid: { apiKey: 'test' }, openai: { apiKey: 'test' } },
  },
} as InternalProcessContext;

test('Multimodal State rejects message/image accessors without executing or losing changing evidence', async () => {
  let reads = 0;
  let calls = 0;
  const image = {
    mediaType: 'image/png',
    data: Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64',
      ),
    ),
  };
  const fixtures: DataValue[] = [];
  for (const key of ['type', 'message']) {
    const value = Object.defineProperty({ type: 'user', message: ['caption', { type: 'image', ...image }] }, key, {
      get() {
        reads++;
        return key === 'type' ? 'user' : ['replacement'];
      },
    });
    fixtures.push({ type: 'chat-message', value } as DataValue, { type: 'any[]', value: [value] });
  }
  for (const key of ['data', 'mediaType']) {
    const value = Object.defineProperty({ ...image }, key, {
      get() {
        reads++;
        return key === 'data' ? image.data : image.mediaType;
      },
    });
    fixtures.push({ type: 'image', value } as DataValue, { type: 'any[]', value: [value] });
  }
  fixtures.push(
    { type: 'chat-message', value: Object.create({ type: 'user', message: 'inherited' }) },
    { type: 'image', value: Object.create(image) },
  );
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('Unexpected HTTP');
  };
  try {
    for (const provider of ['jev', 'liquid', 'openai']) {
      const node = ClassifierEvaluateNodeImpl.create();
      node.data.provider = provider;
      for (const state of fixtures) {
        assert.throws(() => normalizeClassifierState(state), /own data properties/);
        await assert.rejects(
          new ClassifierEvaluateNodeImpl(node).process(
            { state, question1: { type: 'object', value: question() } },
            context,
          ),
          /own data properties/,
        );
      }
    }
    assert.equal(reads, 0);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('Evaluate reads only active input ports and rejects wrapper getters and inherited fields before HTTP', async () => {
  let reads = 0;
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('Unexpected HTTP');
  };
  try {
    for (const provider of ['jev', 'liquid', 'openai']) {
      const node = ClassifierEvaluateNodeImpl.create();
      node.data = { ...node.data, provider, useModelInput: true, apiKeySource: 'input' };
      const inputs = () => ({
        state: { type: 'string', value: 'evidence' },
        question1: { type: 'object', value: question() },
        model: { type: 'string', value: getClassifierProvider(provider).defaultModel },
        apiKey: { type: 'string', value: 'fixture' },
      });
      for (const port of ['state', 'question1', 'model', 'apiKey'] as const) {
        for (const field of [undefined, 'type', 'value']) {
          const values = inputs();
          Object.defineProperty(field === undefined ? values : values[port], field ?? port, {
            enumerable: true,
            get() {
              reads++;
              throw new Error('Input getter executed');
            },
          });
          await assert.rejects(
            new ClassifierEvaluateNodeImpl(node).process(values as any, context),
            /own data properties/,
          );
        }
      }
      for (const state of [
        Object.create({ type: 'string', value: 'inherited' }),
        Object.assign(Object.create({ value: 'inherited' }), { type: 'string' }),
        Object.assign(Object.create({ type: 'string' }), { value: 'inherited' }),
      ]) {
        assert.throws(() => normalizeClassifierState(state), /own data properties/);
      }
    }
    assert.equal(reads, 0);
    assert.equal(calls, 0);
    const node = ClassifierEvaluateNodeImpl.create();
    const inputs = { question1: { type: 'object', value: question() } };
    for (const port of ['unused', 'questionNoise', 'model', 'apiKey'])
      Object.defineProperty(inputs, port, {
        enumerable: true,
        get() {
          reads++;
          throw new Error('Inactive getter executed');
        },
      });
    globalThis.fetch = async () =>
      Response.json({
        model: 'jev-latest',
        answers: { q: { type: 'noul', noul: 0.8 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    await new ClassifierEvaluateNodeImpl(node).process(inputs as any, context);
    assert.equal(reads, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('Questions reject serialization hooks, accessors, sparse arrays and disappearing required fields before HTTP', async () => {
  let reads = 0;
  let calls = 0;
  const hook = (value: object) => Object.defineProperty(value, 'toJSON', { value: () => 'replacement' });
  const getter = Object.defineProperty(question(), 'instructions', {
    enumerable: true,
    get() {
      reads++;
      return reads === 1 ? 'original' : 'replacement';
    },
  });
  const hiddenId = Object.defineProperty(question(), 'questionId', { enumerable: false });
  const hiddenCriteria = Object.defineProperty(question(), 'criteria', {
    get() {
      reads++;
      return undefined;
    },
  });
  const fixtures = [
    hook(question()),
    { ...question(), instructions: hook({ original: 'instruction' }) },
    { ...question(), type: 'score', criteria: hook(['low', 'high']) },
    { ...question(), type: 'score', criteria: ['low', , 'high'] },
    { ...question(), instructions: new Date() },
    getter,
    hiddenId,
    hiddenCriteria,
    Object.create(question()),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('Unexpected HTTP');
  };
  try {
    for (const id of ['jev', 'liquid', 'openai']) {
      const provider = getClassifierProvider(id);
      const node = ClassifierEvaluateNodeImpl.create();
      node.data.provider = id;
      for (const value of fixtures) {
        await assert.rejects(
          provider.evaluate({
            apiKey: 'test',
            model: provider.defaultModel,
            state: '',
            questions: [value as any],
            signal: context.signal,
            timeoutMs: 1000,
          }),
          /serialization hooks|data properties|plain JSON|enumerable/,
        );
        await assert.rejects(
          new ClassifierEvaluateNodeImpl(node).process(
            {
              question1: { type: 'object', value },
            },
            context,
          ),
          /serialization hooks|data properties|plain JSON|enumerable/,
        );
      }
    }
    assert.equal(reads, 0, 'Validation must not execute question getters');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Question array flattening rejects holes, getters and cycles without calling custom iterators', async () => {
  const node = new ClassifierEvaluateNodeImpl(ClassifierEvaluateNodeImpl.create());
  let reads = 0;
  const getter = Object.defineProperty([question()], '0', {
    get() {
      reads++;
      return question();
    },
  });
  const cycle: unknown[] = [];
  cycle.push(cycle);
  const sparse = [question(), , question()];
  sparse[Symbol.iterator] = function* () {
    yield question();
  };
  for (const value of [getter, sparse, cycle])
    await assert.rejects(node.process({ question1: { type: 'object', value } }, context), /data properties|circular/);
  assert.equal(reads, 0);
});

test('Structured State and entries reject getters without invoking them and validate array indices, not custom iterators', () => {
  let reads = 0;
  const state = Object.defineProperty({}, 'text', {
    enumerable: true,
    get() {
      reads++;
      return 'text';
    },
  });
  const hook = Object.defineProperty({}, 'toJSON', {
    get() {
      reads++;
      return () => 'replacement';
    },
  });
  for (const value of [state, hook]) {
    assert.throws(() => normalizeClassifierState({ type: 'object', value }), /data properties|serialization hooks/);
    assert.throws(() => assertClassifierEntry(value, 'Instructions'), /data properties|serialization hooks/);
  }
  const array = [undefined];
  array[Symbol.iterator] = function* () {
    yield 'fake valid value';
  };
  assert.throws(() => normalizeClassifierState({ type: 'object[]', value: array }), /JSON-compatible/);
  assert.throws(() => assertClassifierEntry(['first', , 'last'], 'Criteria'), /sparse arrays/);
  assert.equal(reads, 0);
});

test('Optional undefined criteria and JSON data named toJSON remain valid and stable on every provider', async () => {
  for (const id of ['jev', 'liquid', 'openai']) {
    const provider = getClassifierProvider(id);
    let calls = 0;
    const instructions = { toJSON: 'text', check: ['one', 'two'] };
    const batch = [{ ...question(), criteria: undefined, instructions }];
    batch[Symbol.iterator] = () => {
      throw new Error('Unexpected question iterator');
    };
    Object.defineProperty(batch, 'toJSON', { value: () => [] });
    const result = await provider.evaluate({
      apiKey: 'test',
      model: provider.defaultModel,
      state: { toJSON: 'ordinary data', nested: [false, 1, null] },
      questions: batch,
      signal: context.signal,
      timeoutMs: 1000,
      fetchImplementation: async (_url, options) => {
        calls++;
        const request = JSON.parse(options!.body as string);
        const sent = id === 'openai' ? request.questions[0] : request.questions.q;
        assert.equal('criteria' in sent, false);
        assert.deepEqual(sent.instructions, id === 'openai' ? JSON.stringify(instructions) : instructions);
        return Response.json(
          id === 'openai'
            ? {
                model: provider.defaultModel,
                answers: [{ name: 'q', type: 'predicate', probability: 0.8 }],
                usage: { input_tokens: 1, output_tokens: 0 },
              }
            : {
                model: provider.defaultModel,
                answers: { q: { type: 'noul', noul: 0.8 } },
                usage: { input_tokens: 1, output_tokens: 0 },
              },
        );
      },
    });
    assert.equal(calls, 1);
    assert.ok(result.response.answers.q);
  }
});

test('Multimodal State preserves actual array contents even when custom iterators or some methods hide images', () => {
  const url =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const content = ['caption', url, 'after'];
  content[Symbol.iterator] = function* () {
    yield 'caption';
  };
  content.some = () => {
    throw new Error('Unexpected array method');
  };
  const expected = {
    state: '',
    stateMessages: [
      {
        parts: [
          { type: 'text', text: 'caption' },
          { type: 'image', dataUrl: url },
          { type: 'text', text: 'after' },
        ],
      },
    ],
  };
  assert.deepEqual(normalizeClassifierState({ type: 'any[]', value: content }), expected);
  assert.deepEqual(
    normalizeClassifierState({ type: 'chat-message', value: { type: 'user', message: content } }),
    expected,
  );
  let reads = 0;
  const getter = Object.defineProperty(['caption'], '0', {
    get() {
      reads++;
      return 'caption';
    },
  });
  assert.throws(() => normalizeClassifierState({ type: 'string[]', value: getter }), /data properties/);
  assert.equal(reads, 0);
});

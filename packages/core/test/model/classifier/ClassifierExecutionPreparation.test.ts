import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClassifierEvaluateNodeImpl, type InternalProcessContext } from '../../../src/index.js';
import {
  classifierProviders,
  createApiCompatibleClassifierProvider,
  getClassifierProvider,
  calculateClassifierUsageCost,
  type ClassifierProvider,
} from '../../../src/model/classifier/providers.js';
import { ClassifierValueBudget, assertClassifierResourceLimits } from '../../../src/model/classifier/limits.js';
import { snapshotClassifierJson } from '../../../src/model/classifier/json.js';

const question = { questionId: 'q', type: 'noul' as const, instructions: 'Check the shared state' };
const context = () =>
  ({
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: {
      classifierProviders: { jev: { apiKey: 'test' }, liquid: { apiKey: 'test' }, openai: { apiKey: 'test' } },
    },
  }) as InternalProcessContext;
const reply = (id: string) => ({
  model: getClassifierProvider(id).defaultModel,
  answers: id === 'openai' ? [{ name: 'q', type: 'predicate', probability: 0.8 }] : { q: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: 1, output_tokens: 0 },
});

test('Graph preparation validates/copies structured evidence once and builds diagnostics only on demand', async () => {
  const descriptor = Object.getOwnPropertyDescriptor;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const fetch = globalThis.fetch;
  try {
    for (const id of ['jev', 'liquid', 'openai']) {
      for (const size of [64, 512 * 1024]) {
        for (const diagnostics of [false, true]) {
          const state = { auditMarker: 'x'.repeat(size), nested: [false, 1, null] };
          let rawReads = 0,
            allReads = 0,
            parses = 0,
            serializations = 0;
          Object.getOwnPropertyDescriptor = (value, key) => {
            if (key === 'auditMarker') {
              allReads++;
              if (value === state) rawReads++;
            }
            return descriptor(value, key);
          };
          JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
            parses++;
            return parse(...args);
          };
          JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
            serializations++;
            return stringify(...args);
          }) as typeof JSON.stringify;
          let wire = '';
          globalThis.fetch = async (_url, options) => {
            assert.equal(rawReads, 1, 'Untrusted structured State is walked once');
            assert.equal(allReads, id === 'openai' ? 1 : 2, 'Only the transformed wire receives a second measurement');
            assert.equal(parses, 0, 'No JSON round-trip or diagnostic reconstruction before HTTP');
            assert.equal(serializations, id === 'openai' ? 2 : 1);
            wire = options!.body as string;
            // Simulate another graph branch mutating shared input after the snapshot.
            state.auditMarker = 'changed';
            return new Response(stringify(reply(id)), { status: 200 });
          };
          const node = ClassifierEvaluateNodeImpl.create();
          const outputs = await new ClassifierEvaluateNodeImpl({
            ...node,
            data: { ...node.data, provider: id, outputRequestBody: diagnostics },
          }).process(
            { state: { type: 'object', value: state }, question1: { type: 'object', value: question } },
            context(),
          );
          assert.equal(parses, diagnostics ? 2 : 1, 'One response parse plus the opt-in request diagnostic');
          if (diagnostics) assert.deepEqual(outputs.requestBody!.value, parse(wire));
          else assert.equal(outputs.requestBody, undefined);
          Object.getOwnPropertyDescriptor = descriptor;
          JSON.parse = parse;
          JSON.stringify = stringify;
        }
      }
    }
  } finally {
    Object.getOwnPropertyDescriptor = descriptor;
    JSON.parse = parse;
    JSON.stringify = stringify;
    globalThis.fetch = fetch;
  }
});

test('Direct-provider request diagnostics retain the exact wire body and stable object identity', async () => {
  for (const id of ['jev', 'liquid', 'openai']) {
    const provider = getClassifierProvider(id);
    let wire = '';
    const result = await provider.evaluate({
      state: { ['__proto__']: 'ordinary data' },
      questions: [question],
      model: provider.defaultModel,
      apiKey: 'test',
      signal: new AbortController().signal,
      timeoutMs: 1000,
      fetchImplementation: async (_url, options) => {
        wire = options!.body as string;
        return Response.json(reply(id));
      },
    });
    assert.deepEqual(result.requestBody, JSON.parse(wire));
    assert.equal(result.requestBody, result.requestBody);
    assert.ok(Object.keys(result).includes('requestBody'));
    const replacement = { redacted: true };
    result.requestBody = replacement;
    assert.equal(result.requestBody, replacement, 'Public diagnostics remain replaceable');
    assert.deepEqual(result.responseBody, reply(id));
  }
});

test('Opt-in request diagnostic reconstruction stays within the graph deadline', async () => {
  const parse = JSON.parse;
  const now = Date.now;
  const fetch = globalThis.fetch;
  let clock = now();
  try {
    Date.now = () => clock;
    JSON.parse = (text, reviver) => {
      const value = parse(text, reviver);
      if (value.state === 'diagnostic-clock') clock += 1000;
      return value;
    };
    globalThis.fetch = async () => Response.json(reply('jev'));
    for (const diagnostics of [false, true]) {
      const node = ClassifierEvaluateNodeImpl.create();
      const run = new ClassifierEvaluateNodeImpl({
        ...node,
        data: { ...node.data, timeoutMs: 1000, outputRequestBody: diagnostics },
      }).process(
        { state: { type: 'string', value: 'diagnostic-clock' }, question1: { type: 'object', value: question } },
        context(),
      );
      if (diagnostics) await assert.rejects(run, /timed out/);
      else await run;
    }
  } finally {
    JSON.parse = parse;
    Date.now = now;
    globalThis.fetch = fetch;
  }
});

test('Direct provider deadlines reject timer overflow but permit an earlier bounded deadline', async () => {
  for (const id of ['jev', 'liquid', 'openai']) {
    let calls = 0;
    const args = {
      state: '',
      questions: [question],
      model: getClassifierProvider(id).defaultModel,
      apiKey: 'test',
      timeoutMs: Number.MAX_VALUE,
      signal: new AbortController().signal,
      fetchImplementation: async () => {
        calls++;
        return Response.json(reply(id));
      },
    };
    await assert.rejects(getClassifierProvider(id).evaluate(args), /effective timeout/);
    assert.equal(calls, 0, 'Invalid timer budgets fail before network IO');
    await getClassifierProvider(id).evaluate({ ...args, deadline: Date.now() + 1000 });
    assert.equal(calls, 1, 'Only the effective deadline needs to fit the platform timer');
  }
});

test('Direct providers reject invalid Model and API Key without serialization or coercion hooks', async () => {
  for (const id of ['jev', 'liquid', 'openai']) {
    let calls = 0,
      hooks = 0;
    const hooked = {
      toJSON() {
        hooks++;
        return 'replacement';
      },
      toString() {
        hooks++;
        return 'replacement';
      },
    };
    const args = {
      state: '',
      questions: [question],
      model: getClassifierProvider(id).defaultModel,
      apiKey: 'test',
      timeoutMs: 1000,
      signal: new AbortController().signal,
      fetchImplementation: async () => {
        calls++;
        return Response.json(reply(id));
      },
    };
    for (const model of [undefined, null, 1, '', '  ', hooked])
      await assert.rejects(getClassifierProvider(id).evaluate({ ...args, model } as any), /model.*nonblank string/i);
    for (const apiKey of [undefined, null, 1, '', '  ', 'secret\r\ninjected', hooked])
      await assert.rejects(getClassifierProvider(id).evaluate({ ...args, apiKey } as any), /API key.*nonblank string/i);
    assert.equal(calls, 0);
    assert.equal(hooks, 0);
  }
});

test('Plain-data snapshots preserve special keys and charge expanded references cumulatively', () => {
  const shared = { ['__proto__']: 'data', toJSON: 'ordinary field', nested: [false, null, 2] };
  const budget = new ClassifierValueBudget(undefined, JSON.stringify([shared, shared]).length + 16);
  const snapshot = snapshotClassifierJson([shared, shared], 'State', budget) as (typeof shared)[];
  assert.deepEqual(snapshot, [shared, shared]);
  assert.notEqual(snapshot[0], shared);
  assert.notEqual(snapshot[0], snapshot[1]);
  shared.nested[0] = true;
  assert.equal(snapshot[0]!.nested[0], false);
  assert.throws(() => snapshotClassifierJson(shared, 'Question', budget), /resource limit/);
});

test('Omitted JSON fields and sparse preflight slots still consume bounded work and bytes', async () => {
  const omitted = Object.fromEntries(Array.from({ length: 60_000 }, (_, index) => [`optional${index}`, undefined]));
  const budget = new ClassifierValueBudget();
  snapshotClassifierJson(omitted, 'Question', budget, true);
  assert.throws(() => snapshotClassifierJson(omitted, 'Question', budget, true), /too many expanded values/);
  assert.throws(
    () =>
      snapshotClassifierJson(
        { ['x'.repeat(1024)]: undefined },
        'Question',
        new ClassifierValueBudget(undefined, 128),
        true,
      ),
    /resource limit/,
  );
  const sparse = Array(60_000);
  assert.throws(() => assertClassifierResourceLimits([sparse, sparse]), /too many expanded values/);
  let reads = 0;
  const accessor = Object.defineProperty({}, 'ignored', {
    enumerable: true,
    get: () => {
      reads++;
      return 'must not execute';
    },
  });
  assert.ok(assertClassifierResourceLimits(accessor) > 2);
  assert.equal(reads, 0);
  let checks = 0;
  assert.throws(
    () =>
      assertClassifierResourceLimits(sparse, () => {
        if (++checks === 100) throw new Error('cancelled');
      }),
    /cancelled/,
  );

  for (const id of ['jev', 'liquid', 'openai']) {
    let calls = 0;
    await assert.rejects(
      getClassifierProvider(id).evaluate({
        state: '',
        model: getClassifierProvider(id).defaultModel,
        apiKey: 'test',
        questions: [
          { ...omitted, ...question },
          { ...omitted, ...question, questionId: 'q2' },
        ],
        signal: new AbortController().signal,
        timeoutMs: 5000,
        fetchImplementation: async () => {
          calls++;
          return Response.json(reply(id));
        },
      }),
      /too many expanded values/,
    );
    assert.equal(calls, 0);
  }
});

test('System One evidence policy belongs to the specification, not a special provider ID', async () => {
  let checked = 0,
    calls = 0;
  const provider = createApiCompatibleClassifierProvider({
    id: 'custom-policy',
    label: 'Policy',
    defaultModel: 'test',
    endpoint: 'https://example.invalid/decisions',
    credentialNames: { programmaticName: 'testKey', environmentVariableName: 'TEST_KEY' },
    checkState: () => {
      checked++;
      throw new Error('Provider evidence rejected');
    },
  });
  await assert.rejects(
    provider.evaluate({
      state: 'evidence',
      questions: [question],
      model: 'test',
      apiKey: 'test',
      timeoutMs: 1000,
      signal: new AbortController().signal,
      fetchImplementation: async () => {
        calls++;
        throw new Error('Unexpected HTTP');
      },
    }),
    /Provider evidence rejected/,
  );
  assert.equal(checked, 1);
  assert.equal(calls, 0);
});

test('Removed direct-provider image fields fail before getters or argument copying can hide evidence', async () => {
  for (const id of ['jev', 'liquid', 'openai']) {
    let calls = 0,
      reads = 0;
    const args = {
      state: '',
      questions: [question],
      model: getClassifierProvider(id).defaultModel,
      apiKey: 'test',
      timeoutMs: 1000,
      signal: new AbortController().signal,
      fetchImplementation: async () => {
        calls++;
        return Response.json(reply(id));
      },
    };
    for (const input of [
      { ...args, images: undefined },
      Object.assign(Object.create({ images: undefined }), args),
      Object.defineProperty({ ...args }, 'images', { value: undefined }),
      Object.defineProperty({ ...args }, 'images', {
        enumerable: true,
        get: () => {
          reads++;
          return [];
        },
      }),
    ]) {
      await assert.rejects(getClassifierProvider(id).evaluate(input), /not a separate images field/);
    }
    assert.equal(calls, 0);
    assert.equal(reads, 0);
  }
});

test('Legacy custom descriptors still receive normalized graph evidence', async () => {
  let received: unknown;
  const provider: ClassifierProvider = {
    id: 'legacy-custom',
    label: 'Legacy',
    defaultModel: 'test',
    browserExecutionSupported: false,
    credentialNames: { programmaticName: 'testKey', environmentVariableName: 'TEST_KEY' },
    evaluate: async (args) => {
      received = args;
      return {
        requestBody: {},
        responseBody: {},
        response: { model: 'test', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } },
      };
    },
  };
  const registry = classifierProviders as ClassifierProvider[];
  registry.push(provider);
  try {
    const node = ClassifierEvaluateNodeImpl.create();
    await assert.rejects(
      new ClassifierEvaluateNodeImpl({ ...node, data: { ...node.data, provider: provider.id } }).process(
        { question1: { type: 'object', value: { ...question, instructions: Array(100_001).fill('x') } } },
        { ...context(), settings: { testKey: 'test' } },
      ),
      /too many expanded values/,
    );
    assert.equal(received, undefined, 'Legacy resource preflight remains in front of custom execution');
    const entries = Array(60_000).fill('x');
    const implementation = new ClassifierEvaluateNodeImpl({ ...node, data: { ...node.data, provider: provider.id } });
    const customContext = { ...context(), settings: { testKey: 'test' } };
    await assert.rejects(
      implementation.process(
        {
          question1: { type: 'object', value: { ...question, instructions: entries } },
          question2: { type: 'object', value: { ...question, questionId: 'q2', instructions: entries } },
        },
        customContext,
      ),
      /too many expanded values/,
    );
    await assert.rejects(
      implementation.process(
        {
          state: { type: 'object', value: { evidence: entries } },
          question1: { type: 'object', value: { ...question, instructions: entries } },
        },
        customContext,
      ),
      /too many expanded values/,
    );
    assert.equal(received, undefined, 'State and all Question ports share the legacy resource budget');
    provider.maxRequestBytes = 128;
    try {
      await assert.rejects(
        new ClassifierEvaluateNodeImpl({
          ...node,
          data: { ...node.data, provider: provider.id, model: 'm'.repeat(128) },
        }).process({ question1: { type: 'object', value: question } }, customContext),
        /resource limit/,
      );
      assert.equal(received, undefined, 'Model also participates in the custom provider request cap');
    } finally {
      delete provider.maxRequestBytes;
    }
    await new ClassifierEvaluateNodeImpl({ ...node, data: { ...node.data, provider: provider.id } }).process(
      {
        state: { type: 'string[]', value: ['one', 'two'] },
        question1: { type: 'object', value: question },
      },
      { ...context(), settings: { testKey: 'test' } },
    );
    assert.deepEqual((received as Record<string, unknown>).stateMessages, [
      {
        parts: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      },
    ]);
    assert.equal((received as Record<string, unknown>).state, '');
    assert.equal('stateInput' in (received as object), false);
  } finally {
    registry.splice(registry.indexOf(provider), 1);
  }
});

test('Evaluate rejects a legacy custom provider result returned after the original deadline', async () => {
  const now = Date.now;
  let clock = now();
  let calls = 0;
  const provider: ClassifierProvider = {
    id: 'late-custom',
    label: 'Late',
    defaultModel: 'test',
    browserExecutionSupported: false,
    credentialNames: { programmaticName: 'testKey', environmentVariableName: 'TEST_KEY' },
    evaluate: async () => {
      calls++;
      clock += 1000;
      return {
        requestBody: {},
        responseBody: {},
        response: { model: 'test', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } },
      };
    },
  };
  const registry = classifierProviders as ClassifierProvider[];
  registry.push(provider);
  Date.now = () => clock;
  try {
    const node = ClassifierEvaluateNodeImpl.create();
    await assert.rejects(
      new ClassifierEvaluateNodeImpl({
        ...node,
        data: { ...node.data, provider: provider.id, timeoutMs: 1000 },
      }).process({ question1: { type: 'object', value: question } }, { ...context(), settings: { testKey: 'test' } }),
      /timed out/,
    );
    assert.equal(calls, 1);
  } finally {
    Date.now = now;
    registry.splice(registry.indexOf(provider), 1);
  }
});

test('Legacy pricing is normalized per call without caching mutable caller metadata', () => {
  const provider = {
    defaultModel: 'custom',
    pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 0 },
  };
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  const models = { requestedModel: 'custom', responseModel: 'custom' };
  assert.equal(calculateClassifierUsageCost(provider, usage, models), 1);
  provider.pricing = { inputPerMillionTokens: 2, outputPerMillionTokens: 0 };
  assert.equal(calculateClassifierUsageCost(provider, usage, models), 2);
});

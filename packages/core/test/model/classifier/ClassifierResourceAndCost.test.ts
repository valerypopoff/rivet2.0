import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  ClassifierEvaluateNodeImpl,
  GraphInputNodeImpl,
  GraphOutputNodeImpl,
  GraphProcessor,
  SubGraphNodeImpl,
  createBuiltInRegistry,
  type ChartNode,
  type GraphId,
  type NodeGraph,
  type NodeConnection,
  type Project,
  type ProjectId,
  type InternalProcessContext,
} from '../../../src/index.js';
import {
  createApiCompatibleClassifierProvider,
  getClassifierProvider,
} from '../../../src/model/classifier/providers.js';
import { assertClassifierResourceLimits, CLASSIFIER_LIMITS } from '../../../src/model/classifier/limits.js';
import { normalizeClassifierState } from '../../../src/model/classifier/state.js';
import { assertClassifierInstructions } from '../../../src/model/classifier/json.js';
import { nativeClassifierImage, classifierImageFromText } from '../../../src/model/classifier/images.js';
import { testProcessContext } from '../../testUtils.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const question = { questionId: 'q', type: 'noul' as const, instructions: 'Check the shared state' };
const settings = {
  classifierProviders: { jev: { apiKey: 'fixture' }, liquid: { apiKey: 'fixture' }, openai: { apiKey: 'fixture' } },
};
const context = () =>
  ({ executor: 'nodejs', signal: new AbortController().signal, settings }) as InternalProcessContext;
const args = (provider = 'jev') => ({
  apiKey: 'fixture',
  model: getClassifierProvider(provider).defaultModel,
  questions: [question],
  state: '',
  timeoutMs: 5000,
  signal: new AbortController().signal,
});
const reply = (provider: string, tokens = 1_000_000) => ({
  model: getClassifierProvider(provider).defaultModel,
  answers:
    provider === 'openai' ? [{ name: 'q', type: 'predicate', probability: 0.8 }] : { q: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: tokens, output_tokens: 0 },
});

test('Every provider rejects oversized text, expanded references, deep JSON and excessive questions before HTTP', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('Unexpected HTTP');
  };
  let deep: unknown = 'leaf';
  for (let i = 0; i < 70; i++) deep = [deep];
  let expanded: unknown = { leaf: 'x' };
  for (let i = 0; i < 20; i++) expanded = { left: expanded, right: expanded };
  for (const provider of ['jev', 'liquid', 'openai']) {
    for (const state of ['x'.repeat(CLASSIFIER_LIMITS.requestBytes + 1), deep, expanded]) {
      await assert.rejects(
        getClassifierProvider(provider).evaluate({ ...args(provider), state: state as any }),
        /resource limit|nesting depth|expanded values/,
      );
      const node = ClassifierEvaluateNodeImpl.create();
      node.data.provider = provider;
      await assert.rejects(
        new ClassifierEvaluateNodeImpl(node).process(
          { state: { type: 'any', value: state }, question1: { type: 'object', value: question } },
          context(),
        ),
        /resource limit|nesting depth|expanded values/,
      );
    }
    await assert.rejects(
      getClassifierProvider(provider).evaluate({ ...args(provider), questions: Array(1001).fill(question) }),
      /1000 questions/,
    );
  }
  assert.equal(calls, 0);
});

test('Resource limits count UTF-8 escaping and base64 expansion before allocating encoded native images', () => {
  for (const text of ['a', '你好', '😀', '\ud800', '\u0000\n"\\']) {
    const bytes = Buffer.byteLength(JSON.stringify(text));
    assert.equal(assertClassifierResourceLimits(text, undefined, bytes), bytes);
    assert.throws(() => assertClassifierResourceLimits(text, undefined, bytes - 1), /resource limit/);
  }
  assert.throws(
    () =>
      normalizeClassifierState({
        type: 'image',
        value: { data: new Uint8Array(25 * 1024 * 1024), mediaType: 'image/png' },
      }),
    /resource limit/,
  );
  assert.throws(() => normalizeClassifierState({ type: 'string[]', value: Array(4097).fill('') }), /content parts/);
  assert.throws(
    () =>
      normalizeClassifierState({
        type: 'chat-message[]',
        value: Array.from({ length: 1025 }, () => ({ type: 'user', message: 'caption' })),
      }),
    /messages/,
  );
  assert.throws(
    () =>
      normalizeClassifierState(
        { type: 'image', value: { data: new Uint8Array(4_000_000), mediaType: 'image/png' } },
        undefined,
        getClassifierProvider('liquid').maxRequestBytes,
      ),
    /resource limit/,
  );
});

test('Question root kinds remain strict while nested JSON values survive every provider', async () => {
  for (const id of ['jev', 'liquid', 'openai']) {
    let calls = 0;
    const fetchImplementation: typeof fetch = async () => {
      calls++;
      return Response.json(reply(id));
    };
    const provider = getClassifierProvider(id);
    const invalid = [
      ...[null, true, 42, '   '].map((instructions) => ({ ...question, instructions })),
      { ...question, type: 'choice', criteria: { first: true, second: 'description' } },
      { ...question, type: 'score', criteria: ['low', 42] },
      { ...question, criteria: { true: 42, false: 'description' } },
    ];
    for (const value of invalid) {
      await assert.rejects(
        provider.evaluate({ ...args(id), questions: [value as any], fetchImplementation }),
        /only strings|required/,
      );
    }
    assert.equal(calls, 0);
    const instructions = { rule: false, context: [0, true, null] };
    const result = await provider.evaluate({
      ...args(id),
      questions: [{ ...question, instructions }],
      fetchImplementation,
    });
    assert.equal(calls, 1);
    assert.deepEqual(
      id === 'openai'
        ? (result.requestBody.questions as any[])[0].instructions
        : (result.requestBody.questions as any).q.instructions,
      id === 'openai' ? JSON.stringify(instructions) : instructions,
    );
  }
});

test('Preparation checks run inside traversal and stop cancellation/deadline work promptly', () => {
  const controller = new AbortController();
  let visits = 0;
  assert.throws(
    () =>
      assertClassifierResourceLimits(Array(1000).fill('caption'), () => {
        if (++visits === 10) controller.abort(new Error('Cancelled while preparing'));
        controller.signal.throwIfAborted();
      }),
    /Cancelled while preparing/,
  );
  assert.equal(visits, 10);
  let checks = 0;
  assert.throws(
    () =>
      normalizeClassifierState({ type: 'string', value: 'x'.repeat(50_000) }, () => {
        if (++checks === 3) throw new Error('Preparation deadline reached');
      }),
    /deadline reached/,
  );
});

test('Native image budgets use intrinsic byte geometry, never authored getters or methods', () => {
  let reads = 0;
  const oversized = new Uint8Array(25 * 1024 * 1024);
  Object.defineProperty(oversized, 'byteLength', {
    get() {
      reads++;
      return 0;
    },
  });
  assert.throws(() => assertClassifierResourceLimits(oversized), /resource limit/);
  assert.equal(reads, 0);

  const bytes = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5eQAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const expected = nativeClassifierImage({ data: bytes, mediaType: 'image/png' });
  for (const property of ['buffer', 'byteOffset', 'byteLength', 'length', 'subarray']) {
    Object.defineProperty(bytes, property, {
      get() {
        reads++;
        throw new Error('Authored byte accessor ran');
      },
    });
  }
  assert.equal(nativeClassifierImage({ data: bytes, mediaType: 'image/png' }), expected);
  assert.equal(
    nativeClassifierImage({ data: Buffer.from(expected.split(',')[1]!, 'base64'), mediaType: 'image/png' }),
    expected,
  );
  assert.equal(reads, 0);
});

test('Resource byte limits fail closed on invalid configuration', () => {
  assert.throws(() => assertClassifierInstructions(' '.repeat(CLASSIFIER_LIMITS.requestBytes + 1)), /resource limit/);
  for (const limit of [NaN, Infinity, -1, 0, 1.5])
    assert.throws(() => assertClassifierResourceLimits('state', undefined, limit), /positive safe integer/);
  assert.throws(
    () =>
      assertClassifierResourceLimits(
        'x'.repeat(CLASSIFIER_LIMITS.requestBytes + 1),
        undefined,
        CLASSIFIER_LIMITS.requestBytes * 2,
      ),
    /32 MiB/,
  );
});

test('Provider limits and transformed OpenAI JSON cannot bypass the HTTP-boundary cap', async () => {
  let calls = 0;
  const fetchImplementation: typeof fetch = async () => {
    calls++;
    throw new Error('Unexpected HTTP');
  };
  for (const maxRequestBytes of [NaN, Infinity, -1, 0, 1.5]) {
    const provider = createApiCompatibleClassifierProvider({
      ...getClassifierProvider('jev'),
      endpoint: 'https://example.invalid/classifier',
      maxRequestBytes,
    });
    await assert.rejects(provider.evaluate({ ...args(), fetchImplementation }), /positive safe integer/);
  }
  await assert.rejects(
    getClassifierProvider('openai').evaluate({
      ...args('openai'),
      state: { content: '"'.repeat(CLASSIFIER_LIMITS.requestBytes / 4) },
      fetchImplementation,
    }),
    /32 MiB resource limit/,
  );
  assert.equal(calls, 0);
});

test('Long JPEG header scans obey preparation checks instead of swallowing cancellation', () => {
  const data = new Uint8Array(100_000).fill(255);
  data[0] = 255;
  data[1] = 216;
  let checks = 0;
  const check = () => {
    if (++checks === 10) throw new Error('Header scan cancelled');
  };
  assert.throws(() => nativeClassifierImage({ data, mediaType: 'image/jpeg' }, check), /Header scan cancelled/);
  checks = 0;
  assert.throws(() => classifierImageFromText(Buffer.from(data).toString('base64'), check), /Header scan cancelled/);
});

test('Empty nested question arrays cannot bypass expanded-work limits', async () => {
  let value: unknown = [];
  for (let i = 0; i < 20; i++) value = [value, value];
  const node = new ClassifierEvaluateNodeImpl(ClassifierEvaluateNodeImpl.create());
  await assert.rejects(node.process({ question1: { type: 'object', value } }, context()), /expanded values/);
});

test('Bounded response reading handles UTF-8 chunk boundaries and does not call unbounded json()', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...reply('jev'), detail: '你好😀' }));
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
  );
  response.json = async () => {
    throw new Error('Unbounded JSON reader used');
  };
  const result = await getClassifierProvider('jev').evaluate({ ...args(), fetchImplementation: async () => response });
  assert.equal(result.responseBody.detail, '你好😀');
});

test('Invalid UTF-8 is rejected without replacing provider content or retrying malformed successes', async () => {
  for (const id of ['jev', 'liquid', 'openai']) {
    for (const invalid of [[0xff], [0xe2, 0x82], [0xc0, 0xaf]]) {
      const json = JSON.stringify({ ...reply(id), detail: 'marker' });
      const [before, after] = json.split('marker');
      const bytes = new Uint8Array([
        ...new TextEncoder().encode(before),
        ...invalid,
        ...new TextEncoder().encode(after),
      ]);
      let calls = 0;
      await assert.rejects(
        getClassifierProvider(id).evaluate({
          ...args(id),
          retryOnNon200: true,
          fetchImplementation: async () => {
            calls++;
            return new Response(
              new ReadableStream({
                start(controller) {
                  for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
                  controller.close();
                },
              }),
            );
          },
        }),
        /invalid JSON response/,
      );
      assert.equal(calls, 1);
    }
  }
});

test('Oversized declared and chunked responses are cancelled without retry or waiting for cleanup', async () => {
  for (const declared of [true, false]) {
    let cancelled = 0;
    let calls = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
        },
        cancel() {
          cancelled++;
          return new Promise(() => {});
        },
      }),
      {
        headers: declared
          ? { 'content-length': String(CLASSIFIER_LIMITS.responseBytes + 1) }
          : { 'content-length': '1' },
      },
    );
    await assert.rejects(
      getClassifierProvider('jev').evaluate({
        ...args(),
        fetchImplementation: async () => {
          calls++;
          return response;
        },
      }),
      /8 MiB response limit/,
    );
    assert.equal(cancelled, 1);
    assert.equal(calls, 1);
  }
});

test('Response byte caps inspect actual chunk bytes without executing authored byte accessors', async () => {
  const chunk = new Uint8Array(CLASSIFIER_LIMITS.responseBytes + 1);
  let reads = 0;
  let cancelled = 0;
  Object.defineProperty(chunk, 'byteLength', {
    get() {
      reads++;
      return 0;
    },
  });
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled++;
      },
    }),
  );
  await assert.rejects(
    getClassifierProvider('jev').evaluate({ ...args(), fetchImplementation: async () => response }),
    /8 MiB response limit/,
  );
  assert.equal(reads, 0);
  assert.equal(cancelled, 1);
});

test('Nested response JSON is rejected before recursive provider validation', async () => {
  let detail: unknown = 0;
  for (let i = 0; i < 70; i++) detail = [detail];
  await assert.rejects(
    getClassifierProvider('jev').evaluate({
      ...args(),
      fetchImplementation: async () => Response.json({ ...reply('jev'), detail }),
    }),
    /nesting depth/,
  );
  await assert.rejects(
    getClassifierProvider('jev').evaluate({
      ...args(),
      fetchImplementation: async () => new Response('[' + '{},'.repeat(100_001) + '{}]'),
    }),
    /too many values/,
  );
  const response = { ...reply('jev'), detail: '\\"[{not nesting}]' };
  const result = await getClassifierProvider('jev').evaluate({
    ...args(),
    fetchImplementation: async () => Response.json(response),
  });
  assert.equal(result.responseBody.detail, response.detail);
});

test('A rapidly producing stream still obeys the overall deadline and cancellation', async () => {
  for (const abort of [true, false]) {
    const controller = new AbortController();
    let cancelled = false;
    const originalNow = Date.now;
    let elapsed = 0;
    Date.now = () => originalNow() + elapsed;
    try {
      await assert.rejects(
        getClassifierProvider('jev').evaluate({
          ...args(),
          signal: controller.signal,
          fetchImplementation: async () =>
            new Response(
              new ReadableStream({
                pull(stream) {
                  stream.enqueue(Uint8Array.of(32));
                  if (abort) controller.abort(new Error('Cancelled during stream'));
                  else elapsed = 10_000;
                },
                cancel() {
                  cancelled = true;
                },
              }),
            ),
        }),
        abort ? /Cancelled during stream/ : /timed out/,
      );
      assert.equal(cancelled, true);
    } finally {
      Date.now = originalNow;
    }
  }
});

const wire = (from: ChartNode, outputId: string, to: ChartNode, inputId: string) =>
  ({ outputNodeId: from.id, outputId, inputNodeId: to.id, inputId }) as NodeConnection;
function graph(provider: string, usage: boolean, split = false): NodeGraph {
  const input = GraphInputNodeImpl.create();
  input.data.id = 'questions';
  input.data.dataType = 'object';
  const model = GraphInputNodeImpl.create();
  model.data.id = 'model';
  model.data.dataType = split ? 'string[]' : 'string';
  const node = ClassifierEvaluateNodeImpl.create();
  node.data.provider = provider;
  node.data.outputUsage = usage;
  node.data.useModelInput = true;
  node.isSplitRun = split;
  node.splitRunMax = 2;
  const output = GraphOutputNodeImpl.create();
  output.data.id = 'usage';
  output.data.dataType = 'object';
  return {
    metadata: { id: 'child' as GraphId, name: 'Classifier', description: '' },
    nodes: [input, model, node, output],
    connections: [
      wire(input, 'data', node, 'question1'),
      wire(model, 'data', node, 'model'),
      wire(node, 'usage', output, 'value'),
    ],
  };
}

test('Real graphs account each provider cost with Usage details on or off, retry, split runs and subgraphs', async () => {
  for (const provider of ['jev', 'liquid', 'openai'])
    for (const details of [false, true])
      for (const mode of ['normal', 'split', 'subgraph']) {
        let calls = 0;
        globalThis.fetch = async () => {
          if (++calls === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
          return Response.json(reply(provider));
        };
        const child = graph(provider, details, mode === 'split');
        const subgraph = SubGraphNodeImpl.create();
        subgraph.data.graphId = 'child' as GraphId;
        const input = GraphInputNodeImpl.create();
        input.data.id = 'questions';
        input.data.dataType = 'object';
        const model = GraphInputNodeImpl.create();
        model.data.id = 'model';
        model.data.dataType = 'string';
        const output = GraphOutputNodeImpl.create();
        output.data.id = 'usage';
        output.data.dataType = 'object';
        const parent: NodeGraph = {
          metadata: { id: 'parent' as GraphId, name: 'Parent', description: '' },
          nodes: [input, model, subgraph, output],
          connections: [
            wire(input, 'data', subgraph, 'questions'),
            wire(model, 'data', subgraph, 'model'),
            wire(subgraph, 'usage', output, 'value'),
          ],
        };
        const id = mode === 'subgraph' ? 'parent' : 'child';
        const project: Project = {
          metadata: { id: 'cost-test' as ProjectId, title: 'Cost', description: '', mainGraphId: id as GraphId },
          plugins: [],
          graphs: { child, parent },
        };
        const processor = new GraphProcessor(project, id as GraphId, createBuiltInRegistry());
        const result = await processor.processGraph(
          { ...testProcessContext(), settings },
          {
            questions: { type: 'object', value: question },
            model:
              mode === 'split'
                ? {
                    type: 'string[]',
                    value: [getClassifierProvider(provider).defaultModel, getClassifierProvider(provider).defaultModel],
                  }
                : { type: 'string', value: getClassifierProvider(provider).defaultModel },
          },
        );
        const expected = (provider === 'jev' ? 0.042 : provider === 'liquid' ? 0.04 : 0.2) * (mode === 'split' ? 2 : 1);
        assert.equal(result.cost?.value, expected, `${provider}/${details}/${mode}`);
        assert.equal(calls, mode === 'split' ? 3 : 2);
        if (mode !== 'split') assert.equal((result.usage?.value as any).totalCost, details ? expected : undefined);
      }
});

test('Unknown/unsafe cost is excluded, real zero remains zero, and caught failures exclude Cost', async () => {
  const node = ClassifierEvaluateNodeImpl.create();
  node.data.outputUsage = true;
  node.data.catchRequestFailed = true;
  for (const tokens of [0, -1, 0.5]) {
    globalThis.fetch = async () => Response.json(reply('jev', tokens));
    const outputs = await new ClassifierEvaluateNodeImpl(node).process(
      { question1: { type: 'object', value: question } },
      context(),
    );
    assert.equal(outputs.cost?.type, tokens === 0 ? 'number' : 'control-flow-excluded');
    assert.equal(outputs.cost?.value, tokens === 0 ? 0 : undefined);
  }
  globalThis.fetch = async () => new Response(null, { status: 401 });
  const outputs = await new ClassifierEvaluateNodeImpl(node).process(
    { question1: { type: 'object', value: question } },
    context(),
  );
  assert.equal(outputs.cost?.type, 'control-flow-excluded');
  assert.equal(outputs.runFailed?.value, true);
});

test('A mixed-provider graph sums both costs independently of diagnostic outputs', async () => {
  const input = GraphInputNodeImpl.create();
  input.data.id = 'questions';
  input.data.dataType = 'object';
  const nodes: ChartNode[] = [input];
  const connections: NodeConnection[] = [];
  for (const provider of ['jev', 'openai']) {
    const node = ClassifierEvaluateNodeImpl.create();
    node.data.provider = provider;
    const output = GraphOutputNodeImpl.create();
    output.data.id = provider;
    output.data.dataType = 'object';
    nodes.push(node, output);
    connections.push(wire(input, 'data', node, 'question1'), wire(node, 'usage', output, 'value'));
  }
  globalThis.fetch = async (url) => Response.json(reply(String(url).includes('openai') ? 'openai' : 'jev'));
  const graph: NodeGraph = { metadata: { id: 'mixed' as GraphId, name: 'Mixed', description: '' }, nodes, connections };
  const project: Project = {
    metadata: { id: 'mixed-project' as ProjectId, title: 'Mixed', description: '', mainGraphId: 'mixed' as GraphId },
    plugins: [],
    graphs: { mixed: graph },
  };
  const result = await new GraphProcessor(project, 'mixed' as GraphId, createBuiltInRegistry()).processGraph(
    { ...testProcessContext(), settings },
    { questions: { type: 'object', value: question } },
  );
  assert.equal(result.cost?.value, 0.042 + 0.2);
});

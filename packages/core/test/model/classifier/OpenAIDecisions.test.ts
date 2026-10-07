import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  ClassifierEvaluateNodeImpl,
  ClassifierQuestionNodeImpl,
  getClassifierProvider,
  type InternalProcessContext,
  type PortId,
} from '../../../src/index.js';
import { validateOpenAIDecisionResponse } from '../../../src/model/classifier/openai.js';
import { assertClassifierImages } from '../../../src/model/classifier/images.js';
import { normalizeClassifierState } from '../../../src/model/classifier/state.js';
import type { ClassifierProviderEvaluateArgs } from '../../../src/model/classifier/providers.js';
import type { ClassifierQuestionDefinition } from '../../../src/model/classifier/types.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const otherImage = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const imageBytes = () => Uint8Array.from(Buffer.from(image.split(',')[1]!, 'base64'));
const sharedImage = () => [{ parts: [{ type: 'image' as const, dataUrl: image }] }];
const ctx = (): InternalProcessContext =>
  ({
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: { classifierProviders: { openai: { apiKey: 'openai-test-key' }, liquid: { apiKey: 'liquid-test-key' } } },
    graphInputNodeValues: {},
    contextValues: {},
    getGlobal: () => undefined,
  }) as InternalProcessContext;

function evaluator(data: Partial<ClassifierEvaluateNodeImpl['data']> = {}) {
  const node = ClassifierEvaluateNodeImpl.create();
  return new ClassifierEvaluateNodeImpl({
    ...node,
    data: {
      ...node.data,
      provider: 'openai',
      outputRequestBody: true,
      outputResponseBody: true,
      outputUsage: true,
      ...data,
    },
  });
}

type WireQuestion = { name: string; type: string; choices?: { value: string }[]; levels?: { label: string }[] };
function reply(questions: WireQuestion[]) {
  return {
    model: 'gpt-6-luna',
    answers: questions.map((q) =>
      q.type === 'predicate'
        ? { name: q.name, type: q.type, probability: 0.83 }
        : q.type === 'choice'
          ? {
              name: q.name,
              type: q.type,
              choice: q.choices![0]!.value,
              confidence: 0.76,
              probabilities: q.choices!.map((c) => ({ value: c.value, probability: 0.5 })),
            }
          : {
              name: q.name,
              type: q.type,
              score: 0.35,
              confidence: 0.65,
              probabilities: q.levels!.map((c, value) => ({ value, label: c.label, probability: 0.5 })),
            },
    ),
    usage: {
      input_tokens: 42,
      output_tokens: 0,
      total_tokens: 42,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  };
}

test('OpenAI runs existing real Choice, Score and Noul nodes and preserves native diagnostics', async () => {
  const definitions: ClassifierQuestionDefinition[] = [];
  for (const data of [
    {
      questionId: '__proto__',
      questionType: 'choice' as const,
      instructionsType: 'object' as const,
      instructionsObjectTemplate: '{"task":"route"}',
      options: [
        { key: '__proto__', value: 'A' },
        { key: 'constructor', value: '' },
      ],
    },
    {
      questionId: 'score',
      questionType: 'score' as const,
      instructionsType: 'lines' as const,
      instructionsLines: ['Rate it', 'Use evidence'],
      levels: ['Low', 'High'],
    },
    {
      questionId: 'yes',
      questionType: 'noul' as const,
      instructions: 'Is it urgent?',
      noulTrueCriteria: undefined,
      noulFalseCriteria: undefined,
      yesMeans: 'Urgent',
      noMeans: 'Not urgent',
    },
  ]) {
    const node = ClassifierQuestionNodeImpl.create();
    const output = await new ClassifierQuestionNodeImpl({
      ...node,
      data: { ...node.data, scoreCriteria: undefined, ...data },
    }).process({}, ctx());
    definitions.push(output['question' as PortId]!.value as ClassifierQuestionDefinition);
  }
  let sent: Record<string, any> | undefined;
  let native: ReturnType<typeof reply> | undefined;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer openai-test-key');
    sent = JSON.parse(String(init?.body));
    native = reply(sent!.questions);
    return Response.json(native);
  };
  const output = await evaluator().process(
    {
      ['state' as PortId]: { type: 'object', value: { text: 'Broken screen' } },
      ['question1' as PortId]: { type: 'object[]', value: definitions },
    },
    ctx(),
  );
  assert.equal(sent!.model, 'gpt-6-luna');
  assert.equal(sent!.input, '{"text":"Broken screen"}');
  assert.deepEqual(sent!.questions[0], {
    name: '__proto__',
    type: 'choice',
    instructions: '{"task":"route"}',
    choices: [{ value: '__proto__', description: 'A' }, { value: 'constructor' }],
  });
  assert.deepEqual(sent!.questions[1].levels, [{ label: 'Low' }, { label: 'High' }]);
  assert.equal(sent!.questions[1].instructions, '["Rate it","Use evidence"]');
  assert.equal(sent!.questions[2].type, 'predicate');
  assert.match(sent!.questions[2].instructions, /True criterion: Urgent\nFalse criterion: Not urgent/);
  const answers = output['answers' as PortId]!.value as Record<string, any>;
  assert.equal(answers.__proto__.choice, '__proto__');
  assert.equal(answers.score.score, 0.35);
  assert.deepEqual({ ...answers.score.legend }, { 0: 'Low', 1: 'High' });
  assert.deepEqual(answers.yes, { type: 'noul', noul: 0.83 });
  assert.deepEqual(output['requestBody' as PortId]!.value, sent);
  assert.deepEqual(output['responseBody' as PortId]!.value, native);
  assert.equal((output['usage' as PortId]!.value as any).totalCost, (42 * 0.1) / 1_000_000);
  assert.equal(JSON.stringify(output).includes('openai-test-key'), false);
});

test('Evaluate exposes only State and sends native image bytes as shared evidence', async () => {
  const node = ClassifierQuestionNodeImpl.create();
  const question = new ClassifierQuestionNodeImpl({
    ...node,
    data: { ...node.data, questionType: 'noul', instructions: 'Is it red?' },
  });
  const output = await question.process({}, ctx());
  assert.equal((output['question' as PortId]!.value as any).images, undefined);
  assert.equal(
    question.getInputDefinitions().find((p) => p.id === 'images'),
    undefined,
  );
  assert.equal(
    question.getEditors().some((editor: any) => editor.dataKey === 'useImagesInput'),
    false,
  );
  assert.equal(
    evaluator()
      .getInputDefinitions([])
      .find((p) => p.id === 'state')!.splitRunBehavior,
    'preserve-array',
  );
  let sent: any;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json(reply(sent.questions));
  };
  await evaluator().process(
    {
      ['state' as PortId]: { type: 'image[]', value: [{ mediaType: 'image/png', data: imageBytes() }] },
      ['question1' as PortId]: output['question' as PortId],
    },
    ctx(),
  );
  assert.deepEqual(sent.input, [
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: image }],
    },
  ]);
});

test('Shared image evaluation snapshots every question and image before retries without splitting the batch', async () => {
  const definitions = [
    { questionId: 'a', type: 'noul', instructions: 'A' },
    { questionId: 'b', type: 'noul', instructions: 'B' },
    { questionId: 'c', type: 'noul', instructions: 'C' },
  ] as ClassifierQuestionDefinition[];
  const calls: any[] = [];
  const images = [image];
  globalThis.fetch = async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    calls.push(sent);
    definitions[1]!.instructions = 'MUTATED';
    images[0] = otherImage;
    if (calls.length === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
    return Response.json(reply(sent.questions));
  };
  const output = await evaluator().process(
    {
      ['question1' as PortId]: { type: 'object[]', value: definitions },
      ['state' as PortId]: { type: 'string[]', value: images },
    },
    ctx(),
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[0].questions.map((q: any) => q.name),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[1].input[0].content[0].image_url, image);
  assert.equal(calls[1].questions[1].instructions, 'B');
  assert.deepEqual(output['requestBody' as PortId]!.value, calls[1]);
  assert.equal((output['usage' as PortId]!.value as any).input_tokens, 42);
  assert.deepEqual(Object.keys(output['answers' as PortId]!.value as object), ['a', 'b', 'c']);
});

test('Liquid d1 sends shared images via its native System One images field', async () => {
  let sent: any;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    sent = JSON.parse(String(init?.body));
    return Response.json({
      model: 'd1',
      answers: { q: { type: 'noul', noul: 0.75 }, r: { type: 'noul', noul: 0.6 } },
      usage: { input_tokens: 12, output_tokens: 0 },
    });
  };
  await evaluator({ provider: 'liquid' }).process(
    {
      ['state' as PortId]: { type: 'string[]', value: [image] },
      ['question1' as PortId]: {
        type: 'object[]',
        value: [
          { questionId: 'q', type: 'noul', instructions: 'Red?' },
          { questionId: 'r', type: 'noul', instructions: 'Damaged?' },
        ],
      },
    },
    ctx(),
  );
  assert.deepEqual(sent.images, [image]);
  assert.deepEqual(sent.questions.q, { type: 'noul', instructions: 'Red?' });
  assert.deepEqual(sent.questions.r, { type: 'noul', instructions: 'Damaged?' });
  assert.equal(calls, 1);
});

test('Unsupported models, remote URLs, malformed images and excessive image batches fail before network', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('Unexpected network');
  };
  const args = {
    apiKey: 'key',
    model: 'jev-latest',
    state: '',
    questions: [{ questionId: 'q', type: 'noul' as const, instructions: 'Q' }],
    signal: new AbortController().signal,
    timeoutMs: 1000,
  };
  for (const [provider, model] of [
    ['jev', 'jev-latest'],
    ['liquid', 'd1:free'],
    ['openai', 'text-only'],
  ]) {
    await assert.rejects(
      getClassifierProvider(provider).evaluate({ ...args, model: model!, stateMessages: sharedImage() }),
      /does not support classifier images/,
    );
  }
  for (const invalid of [
    ['https://example.com/a.png'],
    ['data:image/png;base64,'],
    ['data:image/png;base64,!!!'],
    [null],
    Array.from({ length: 129 }, () => image),
  ]) {
    await assert.rejects(
      getClassifierProvider('openai').evaluate({
        ...args,
        model: 'gpt-6-luna',
        stateMessages: [{ parts: invalid.map((dataUrl) => ({ type: 'image' as const, dataUrl: dataUrl as string })) }],
      }),
      /State|Invalid/,
    );
  }
  assert.equal(calls, 0);
});

test('Inline image validation accepts multi-megabyte payloads without regexp stack exhaustion', () => {
  const bytes = new Uint8Array(3 * 1024 * 1024);
  bytes.set(imageBytes());
  assert.doesNotThrow(() => assertClassifierImages([`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`]));
  for (const payload of ['A===', 'A', 'AAAA=', 'AA=A', 'AA==\n', 'A A=']) {
    assert.throws(() => assertClassifierImages([`data:image/png;base64,${payload}`]), /State images/);
  }
  assert.doesNotThrow(() => assertClassifierImages([image, otherImage]));
});

test('OpenAI refuses malformed mappings and per-question refusals instead of manufacturing answers', () => {
  const questions: ClassifierQuestionDefinition[] = [
    { questionId: 'q', type: 'choice', instructions: 'Q', criteria: { a: 'A', b: 'B' } },
  ];
  const native = () => reply([{ name: 'q', type: 'choice', choices: [{ value: 'a' }, { value: 'b' }] }]);
  for (const mutate of [
    (body: any) => {
      body.answers[0].name = 'wrong';
    },
    (body: any) => {
      body.answers[0].type = 'refusal';
    },
    (body: any) => {
      body.answers[0].probabilities[1].value = 'a';
    },
    (body: any) => {
      body.answers[0].probabilities[1].value = true;
    },
    (body: any) => {
      body.answers[0].confidence = '0.9';
    },
    (body: any) => {
      body.answers[0].probabilities.pop();
    },
    (body: any) => {
      delete body.usage.output_tokens;
    },
    (body: any) => {
      body.answers[0] = Object.create(body.answers[0]);
    },
  ]) {
    const body = native();
    mutate(body);
    assert.throws(() => validateOpenAIDecisionResponse(body, questions));
  }
  const trusted = native();
  trusted.answers[0]!.confidence = 3.9;
  trusted.answers[0]!.probabilities![0]!.probability = -0.4;
  const validated = validateOpenAIDecisionResponse(trusted, questions);
  assert.equal((validated.answers.q as any).confidence, 3.9);
  assert.equal((validated.answers.q as any).probabilities.a, -0.4);
});

test('OpenAI retries exact payloads, handles refusals through node failure controls and rejects browser execution', async () => {
  const bodies: string[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
      : Response.json({
          model: 'gpt-6-luna',
          answers: [{ type: 'refusal', name: 'q' }],
          usage: { input_tokens: 1, output_tokens: 0 },
        });
  };
  const inputs = {
    ['question1' as PortId]: { type: 'object' as const, value: { questionId: 'q', type: 'noul', instructions: 'Q' } },
  };
  const output = await evaluator({ catchRequestFailed: true }).process(inputs, ctx());
  assert.equal(bodies[0], bodies[1]);
  assert.equal(output['runFailed' as PortId]!.value, true);
  assert.equal(output['answers' as PortId]!.type, 'control-flow-excluded');
  assert.match(String(output['runError' as PortId]!.value), /refused question 'q'/);
  await assert.rejects(
    evaluator().process(inputs, { ...ctx(), executor: 'browser' }),
    /OpenAI cannot run in the Browser/,
  );
  assert.equal(bodies.length, 2);
});

test('Question retains ordinary images interpolation without an image-evidence setting', async () => {
  const node = ClassifierQuestionNodeImpl.create();
  const question = new ClassifierQuestionNodeImpl({
    ...node,
    data: {
      ...node.data,
      questionType: 'noul',
      instructions: 'Classify {{images}}',
    },
  });
  assert.equal(question.getInputDefinitions().find((port) => port.id === 'images')!.dataType, 'any');
  const output = await question.process({ ['images' as PortId]: { type: 'string', value: 'ordinary text' } }, ctx());
  const definition = output['question' as PortId]!.value as ClassifierQuestionDefinition;
  assert.equal(definition.instructions, 'Classify ordinary text');
  assert.equal('images' in definition, false);
});

test('OpenAI credentials reuse modern and legacy settings but custom names do not leak default keys', async () => {
  const originalEnv = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const keys: string[] = [];
  globalThis.fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get('authorization')!);
    return Response.json(reply(JSON.parse(String(init?.body)).questions));
  };
  const inputs = {
    ['question1' as PortId]: { type: 'object' as const, value: { questionId: 'q', type: 'noul', instructions: 'Q' } },
  };
  try {
    for (const settings of [
      { openAiApiKey: 'modern-key', openAiKey: 'old-key' },
      { openAiKey: 'old-key' },
      { classifierProviders: { openai: { apiKey: 'classifier-key' } } },
      { pluginEnv: { OPENAI_API_KEY: 'env-key' } },
    ])
      await evaluator().process(inputs, { ...ctx(), settings });
    assert.deepEqual(keys, ['Bearer modern-key', 'Bearer old-key', 'Bearer classifier-key', 'Bearer env-key']);
    await assert.rejects(
      evaluator({
        apiKeyNamesByProvider: {
          openai: { programmaticName: 'myKey', environmentVariableName: 'CUSTOM_DECISIONS_TEST_KEY' },
        },
      }).process(inputs, { ...ctx(), settings: { openAiApiKey: 'modern-key' } }),
      /API key is not set/,
    );
    await evaluator({ apiKeySource: 'input' }).process(
      { ...inputs, ['apiKey' as PortId]: { type: 'string', value: 'input-key' } },
      ctx(),
    );
    assert.equal(keys.at(-1), 'Bearer input-key');
  } finally {
    if (originalEnv === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalEnv;
  }
});

test('One deadline bounds shared image request retries and cancellation prevents retries', async () => {
  const provider = getClassifierProvider('openai');
  const args = {
    apiKey: 'key',
    model: 'gpt-6-luna',
    state: '',
    questions: [
      { questionId: 'a', type: 'noul' as const, instructions: 'A' },
      { questionId: 'b', type: 'noul' as const, instructions: 'B' },
    ],
    timeoutMs: 1000,
    stateMessages: sharedImage(),
  };
  const controller = new AbortController();
  let calls = 0;
  const abortingFetch: typeof fetch = async (_url, init) => {
    calls++;
    controller.abort(new Error('Stopped'));
    return Response.json(reply(JSON.parse(String(init?.body)).questions));
  };
  await assert.rejects(
    provider.evaluate({ ...args, signal: controller.signal, fetchImplementation: abortingFetch }),
    /Stopped/,
  );
  assert.equal(calls, 1);
  calls = 0;
  // Advance the wall clock deterministically so retrying cannot restart the budget.
  const originalNow = Date.now;
  let elapsed = 0;
  Date.now = () => originalNow() + elapsed;
  try {
    const delayedFetch: typeof fetch = async (_url, init) => {
      calls++;
      elapsed += 600;
      if (calls === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
      return Response.json(reply(JSON.parse(String(init?.body)).questions));
    };
    await assert.rejects(
      provider.evaluate({ ...args, signal: new AbortController().signal, fetchImplementation: delayedFetch }),
      /timed out/,
    );
    assert.equal(calls, 2);
  } finally {
    Date.now = originalNow;
  }
});

test('Image validation rejects holes and mismatched declared types before encoding oversized arrays', () => {
  assert.throws(() => assertClassifierImages(new Array(1)), /State images/);
  const nativeImage = { mediaType: 'image/png', data: imageBytes() };
  for (const input of [
    { type: 'image', value: image },
    { type: 'string', value: nativeImage },
    { type: 'image[]', value: new Array(1) },
    { type: 'string[]', value: new Array(1) },
  ]) {
    assert.throws(() => normalizeClassifierState(input as any), /State|Multimodal/);
  }
  let reads = 0;
  const oversized = Array.from({ length: 129 }, () => ({
    mediaType: 'image/png',
    get data() {
      reads++;
      return nativeImage.data;
    },
  }));
  assert.throws(() => normalizeClassifierState({ type: 'image[]', value: oversized }), /128/);
  assert.equal(reads, 0);
});

test('Shared image retries retain the original model, credentials, transport and retry settings', async () => {
  for (const terminalFailure of [false, true]) {
    const requests: any[] = [];
    const args: ClassifierProviderEvaluateArgs = {
      apiKey: 'original-key',
      model: 'gpt-6-luna',
      state: '',
      timeoutMs: 1000,
      signal: new AbortController().signal,
      questions: [
        { questionId: 'a', type: 'noul', instructions: 'A' },
        { questionId: 'b', type: 'noul', instructions: 'B' },
      ],
      stateMessages: sharedImage(),
      fetchImplementation: async (_url, init) => {
        assert.equal(init?.redirect, 'error');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer original-key');
        const sent = JSON.parse(String(init?.body));
        requests.push(sent);
        args.model = 'mutated-model';
        args.apiKey = 'mutated-key';
        args.fetchImplementation = async () => {
          throw new Error('Mutated transport');
        };
        args.retryOnNon200 = true;
        if (requests.length === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
        if (terminalFailure && requests.length === 2) return new Response(null, { status: 500 });
        return Response.json(reply(sent.questions));
      },
    };
    const evaluation = getClassifierProvider('openai').evaluate(args);
    if (terminalFailure) await assert.rejects(evaluation, /HTTP 500/);
    else await evaluation;
    assert.deepEqual(
      requests.map((request) => request.model),
      ['gpt-6-luna', 'gpt-6-luna'],
    );
  }
});

test('Question-level image evidence fails with actionable guidance before any request', async () => {
  for (const provider of ['openai', 'liquid']) {
    let calls = 0;
    const question = { questionId: 'a', type: 'noul', instructions: 'A', images: [image] };
    globalThis.fetch = async () => {
      calls++;
      throw new Error('Unexpected network');
    };
    await assert.rejects(
      getClassifierProvider(provider).evaluate({
        apiKey: 'key',
        model: provider === 'openai' ? 'gpt-6-luna' : 'd1',
        state: '',
        timeoutMs: 1000,
        signal: new AbortController().signal,
        questions: [question as ClassifierQuestionDefinition],
      }),
      /Question-level images.*Evaluate's State input/,
    );
    await assert.rejects(
      evaluator({ provider }).process({ ['question1' as PortId]: { type: 'object', value: question } }, ctx()),
      /Question-level images.*Evaluate's State input/,
    );
    assert.equal(calls, 0);
  }
});

test('A successful response cannot escape the deadline during response receipt', async () => {
  const originalNow = Date.now;
  let elapsed = 0;
  Date.now = () => originalNow() + elapsed;
  try {
    await assert.rejects(
      getClassifierProvider('openai').evaluate({
        apiKey: 'key',
        model: 'gpt-6-luna',
        state: '',
        timeoutMs: 1000,
        signal: new AbortController().signal,
        questions: [{ questionId: 'a', type: 'noul', instructions: 'A' }],
        fetchImplementation: async (_url, init) => {
          const body = reply(JSON.parse(String(init?.body)).questions);
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
                elapsed = 2000;
                controller.close();
              },
            }),
          );
        },
      }),
      /timed out/,
    );
  } finally {
    Date.now = originalNow;
  }
});

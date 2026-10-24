import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AssembleMessageNodeImpl, ClassifierEvaluateNodeImpl, ClassifierProfileNodeImpl } from '../../../src/index.js';
import {
  getClassifierProvider,
  calculateClassifierUsageCost,
  type ClassifierProviderEvaluateArgs,
} from '../../../src/model/classifier/providers.js';
import { resolveClassifierApiKey } from '../../../src/model/classifier/credentials.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';
import type { ClassifierQuestionDefinition } from '../../../src/model/classifier/types.js';

const provider = getClassifierProvider('subq');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64',
);
const image = (bytes = png, mediaType = 'image/png') => ({
  type: 'image' as const,
  dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`,
});
const questions: ClassifierQuestionDefinition[] = [
  { questionId: 'route', type: 'choice', instructions: { task: 'Route' }, criteria: { yes: ['Ready'], no: null } },
  { questionId: 'score', type: 'score', instructions: 'Rate', criteria: ['Low', { label: 'High' }] },
  { questionId: 'gate', type: 'noul', instructions: 'Ready?' },
];
const response = {
  model: 'subq-snap-1.1',
  answers: {
    route: { type: 'choice', choice: 'yes', confidence: 0.8, probabilities: { yes: 0.8, no: 0.2 } },
    score: {
      type: 'score',
      score: 0.2,
      confidence: 0.8,
      probabilities: { '0': 0.8, '1': 0.2 },
      legend: { '0': 'Low', '1': { label: 'High' } },
    },
    gate: { type: 'noul', noul: 0.9 },
  },
  usage: { input_tokens: 1000, output_tokens: 0 },
};
const args = () => ({
  apiKey: 'fixture-key',
  model: provider.defaultModel,
  questions,
  state: { ticket: 'Help', image_url: 'ordinary evidence, not an image part' },
  signal: new AbortController().signal,
});
const context = () =>
  ({
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: { classifierProviders: { subq: { apiKey: 'fixture-key' } } },
  }) as InternalProcessContext;

void test('SubQ uses its native fixed endpoint, exact structured questions and request-level input-only pricing', async () => {
  const input = args();
  const result = await provider.evaluate({
    ...input,
    fetchImplementation: async (url, init) => {
      assert.equal(url, 'https://api.subq.ai/v1/systemone');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.deepEqual(init?.headers, { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' });
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: 'subq-snap-1.1',
        state: input.state,
        questions: Object.fromEntries(questions.map(({ questionId, ...question }) => [questionId, question])),
      });
      return Response.json(response);
    },
  });
  assert.deepEqual(result.response, response);
  assert.equal(provider.browserExecutionSupported, false);
  assert.deepEqual(provider.credentialNames, {
    programmaticName: 'subqApiKey',
    environmentVariableName: 'SUBQ_API_KEY',
  });
  assert.equal(
    resolveClassifierApiKey({
      context: context(),
      inputs: {},
      providerId: 'subq',
      defaults: provider.credentialNames,
      apiKeySource: 'classifier-settings',
    }),
    'fixture-key',
  );
  for (const responseModel of ['subq-snap-1.1', 'subq-snap-future', 'subq-preview'])
    assert.equal(
      calculateClassifierUsageCost(provider, response.usage, { requestedModel: provider.defaultModel, responseModel }),
      responseModel === provider.defaultModel ? 0.00004 : undefined,
    );
  assert.equal(
    calculateClassifierUsageCost(provider, response.usage, {
      requestedModel: 'subq-snap-future',
      responseModel: provider.defaultModel,
    }),
    undefined,
  );
});

void test('SubQ inline/profile nodes preserve image/text order, emit numeric Cost and keep credentials out of diagnostics', async () => {
  const assembled = await new AssembleMessageNodeImpl(AssembleMessageNodeImpl.create()).process({
    part1: { type: 'string', value: 'Before' },
    part2: { type: 'image', value: { mediaType: 'image/png', data: png } },
    part3: { type: 'string', value: 'After' },
  });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.images, [{ mediaType: 'image/png', base64: png.toString('base64') }]);
    assert.ok(['[Image 1]', 'Before\n[Image 1]\nAfter'].includes(body.state));
    assert.equal(body.messages, undefined);
    assert.equal(body.assets, undefined);
    return Response.json({ ...response, answers: { gate: response.answers.gate } });
  };
  for (const configurationMode of ['inline', 'profile'] as const)
    for (const outputUsage of [false, true])
      for (const state of [
        { type: 'image' as const, value: { mediaType: 'image/png' as const, data: png } },
        assembled.message!,
      ]) {
        const node = ClassifierEvaluateNodeImpl.create();
        Object.assign(node.data, {
          provider: 'subq',
          configurationMode,
          outputUsage,
          outputRequestBody: true,
          outputResponseBody: true,
        });
        const profile = ClassifierProfileNodeImpl.create();
        profile.data.provider = 'subq';
        const profileOutput = await new ClassifierProfileNodeImpl(profile).process({}, { ...context(), node: profile });
        const outputs = await new ClassifierEvaluateNodeImpl(node).process(
          {
            state,
            question1: { type: 'object', value: questions[2]! },
            ...(configurationMode === 'profile' ? { classifierProfile: profileOutput.profile! } : {}),
          },
          context(),
        );
        assert.deepEqual(outputs.cost, { type: 'number', value: 0.00004 });
        assert.equal((outputs.usage!.value as Record<string, unknown>).totalCost, outputUsage ? 0.00004 : undefined);
        assert.doesNotMatch(JSON.stringify(outputs), /fixture-key/);
      }
  assert.equal(calls, 8);
});

void test('SubQ enforces published question, image and body limits before HTTP without altering JSON evidence', async () => {
  const paddedPng = (size: number) => {
    const bytes = Buffer.alloc(size);
    png.copy(bytes);
    return bytes;
  };
  const invalid: [Partial<ClassifierProviderEvaluateArgs>, RegExp][] = [
    [
      { questions: Array.from({ length: 129 }, (_, i) => ({ ...questions[2]!, questionId: `q${i}` })) },
      /at most 128 questions/,
    ],
    [{ questions: [{ ...questions[2]!, questionId: 'q'.repeat(101) }] }, /at most 100 characters/],
    [{ state: '', stateMessages: [{ parts: Array.from({ length: 5 }, () => image()) }] }, /at most 4 images/],
    [
      {
        state: '',
        stateMessages: [
          {
            parts: [
              image(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), 'image/gif'),
            ],
          },
        ],
      },
      /PNG, JPEG and WebP images, not GIF/,
    ],
    [{ state: '', stateMessages: [{ parts: [image(paddedPng(4 * 1024 * 1024 + 1))] }] }, /4 MiB decoded each/],
    [
      { state: '', stateMessages: [{ parts: Array.from({ length: 3 }, () => image(paddedPng(3 * 1024 * 1024))) }] },
      /8 MiB decoded in total/,
    ],
    [{ state: 'x'.repeat(13 * 1024 * 1024) }, /resource limit/],
    [
      { model: 'subq-snap-future', state: '', stateMessages: [{ parts: [image()] }] },
      /does not support Decision AI images/,
    ],
  ];
  for (const [evidence, message] of invalid) {
    let requests = 0;
    await assert.rejects(
      provider.evaluate({
        ...args(),
        ...evidence,
        fetchImplementation: async () => {
          requests++;
          return Response.json(response);
        },
      }),
      message,
    );
    assert.equal(requests, 0, 'A rejected input must not reach HTTP');
  }
  for (const parts of [
    Array.from({ length: 4 }, () => image()),
    [image(paddedPng(4 * 1024 * 1024)), image(paddedPng(4 * 1024 * 1024))],
  ]) {
    await provider.evaluate({
      ...args(),
      state: '',
      stateMessages: [{ parts }],
      fetchImplementation: async (_url, init) => {
        assert.equal(JSON.parse(String(init?.body)).images.length, parts.length);
        return Response.json(response);
      },
    });
  }
  const batch = Array.from({ length: 128 }, (_, i) => ({
    ...questions[2]!,
    questionId: i ? `q${i}` : '🦊'.repeat(100),
  }));
  await provider.evaluate({
    ...args(),
    questions: batch,
    fetchImplementation: async () =>
      Response.json({
        ...response,
        answers: Object.fromEntries(batch.map(({ questionId }) => [questionId, response.answers.gate])),
      }),
  });
});

void test('SubQ accepts ordered PNG, JPEG and WebP parts across messages but never downloads remote image content', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 3, 1]);
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0);
  webp.write('WEBP', 8);
  webp.write('VP8X', 12);
  webp[24] = 2;
  webp[27] = 1;
  for (const [mediaType, bytes] of [
    ['image/png', png],
    ['image/jpeg', jpeg],
    ['image/webp', webp],
  ] as const)
    await provider.evaluate({
      ...args(),
      state: '',
      stateMessages: [{ parts: [image(bytes, mediaType)] }],
      fetchImplementation: async (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)).images, [{ mediaType, base64: bytes.toString('base64') }]);
        return Response.json(response);
      },
    });
  await provider.evaluate({
    ...args(),
    state: '',
    stateMessages: [
      { parts: [{ type: 'text', text: 'Before' }, image(), image(jpeg, 'image/jpeg')] },
      { parts: [{ type: 'text', text: 'After' }, image(webp, 'image/webp')] },
    ],
    fetchImplementation: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.state, 'Before\n[Image 1]\n[Image 2]\n\nAfter\n[Image 3]');
      assert.deepEqual(body.images, [
        { mediaType: 'image/png', base64: png.toString('base64') },
        { mediaType: 'image/jpeg', base64: jpeg.toString('base64') },
        { mediaType: 'image/webp', base64: webp.toString('base64') },
      ]);
      return Response.json(response);
    },
  });
  let remoteRequests = 0;
  await assert.rejects(
    provider.evaluate({
      ...args(),
      state: '',
      stateMessages: [{ parts: [{ type: 'image', dataUrl: 'https://example.com/image.png' }] }],
      fetchImplementation: async () => {
        remoteRequests++;
        return Response.json(response);
      },
    }),
    /inline base64 PNG/,
  );
  assert.equal(remoteRequests, 0, 'Remote image rejection must precede HTTP');
});

void test('SubQ keeps shared retry/failure semantics for credits, auth, validation, rate limits and malformed responses', async () => {
  for (const status of [400, 401, 402, 403, 422]) {
    let calls = 0;
    const bodies: unknown[] = [];
    const attempts: { error?: string }[] = [];
    await assert.rejects(
      provider.evaluate({
        ...args(),
        retryOnNon200: true,
        onResponseBody: (body) => bodies.push(body),
        onAttempt: (attempt) => attempts.push(attempt),
        fetchImplementation: async () => {
          calls++;
          return Response.json({ detail: { error_type: 'validation_error', message: 'contract fixture' } }, { status });
        },
      }),
      (error: any) => {
        assert.equal(error.statusCode, status);
        assert.equal(error.kind, 'http');
        if (status === 403) assert.match(error.message, /access denied.*permissions.*model access/);
        if (status === 401) assert.match(error.message, /authentication failed/);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(attempts.length, 1);
    if (status === 403) assert.match(attempts[0]!.error!, /access denied.*permissions.*model access/);
    if (status === 401) assert.match(attempts[0]!.error!, /authentication failed/);
    assert.deepEqual(bodies, [{ detail: { error_type: 'validation_error', message: 'contract fixture' } }]);
  }
  for (const status of [429, 503]) {
    const wires: string[] = [];
    await provider.evaluate({
      ...args(),
      retryOnNon200: status === 503,
      fetchImplementation: async (_url, init) => {
        wires.push(String(init?.body));
        return wires.length === 1
          ? Response.json(
              { detail: { error_type: 'unavailable', message: 'Try later' } },
              { status, headers: { 'retry-after': '0' } },
            )
          : Response.json(response);
      },
    });
    assert.equal(wires.length, 2);
    assert.equal(wires[0], wires[1]);
  }
  let calls = 0;
  await assert.rejects(
    provider.evaluate({
      ...args(),
      retryOnNon200: true,
      fetchImplementation: async () => {
        calls++;
        return Response.json({ ...response, answers: {} });
      },
    }),
    (error: any) => error.kind === 'response-validation',
  );
  assert.equal(calls, 1);
});

void test('SubQ capability failures fall back to another profile without splitting or dropping questions', async () => {
  const batch = Array.from({ length: 129 }, (_, i) => ({ ...questions[2]!, questionId: `q${i}` }));
  const node = ClassifierEvaluateNodeImpl.create();
  node.data.configurationMode = 'profile';
  node.data.outputClassifierAttempts = true;
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body));
    assert.equal(Object.keys(body.questions).length, 129);
    return Response.json({
      ...response,
      model: body.model,
      answers: Object.fromEntries(batch.map(({ questionId }) => [questionId, response.answers.gate])),
    });
  };
  const profiles = ['subq', 'jev'].map((id) => ({
    version: 1,
    configuration: { provider: id, model: getClassifierProvider(id).defaultModel },
    credential: { value: 'fixture-key' },
  }));
  const output = await new ClassifierEvaluateNodeImpl(node).process(
    {
      question1: { type: 'object[]', value: batch },
      classifierProfile: { type: 'classifier-config[]', value: profiles },
    } as any,
    context(),
  );
  assert.deepEqual(calls, ['https://api.typesafe.ai/v1/systemone']);
  assert.equal(Object.keys(output.answers!.value as object).length, 129);
  assert.match(JSON.stringify(output.classifierAttempts), /capability/);
});

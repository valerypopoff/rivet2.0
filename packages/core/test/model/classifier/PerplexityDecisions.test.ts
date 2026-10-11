import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ClassifierEvaluateNodeImpl } from '../../../src/model/nodes/ClassifierEvaluateNode.js';
import { ClassifierProfileNodeImpl } from '../../../src/model/nodes/ClassifierProfileNode.js';
import { getClassifierProvider, calculateClassifierUsageCost } from '../../../src/model/classifier/providers.js';
import { resolveClassifierApiKey } from '../../../src/model/classifier/credentials.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';
import type { ClassifierQuestionDefinition } from '../../../src/model/classifier/types.js';

const provider = getClassifierProvider('perplexity');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const imagePart = (url: string) => ({ type: 'image_url', image_url: { url } });
// Header-only fixtures exercise preflight dimensions; mock HTTP never decodes pixels.
const sizedPng = (width: number, height: number) => {
  const bytes = Buffer.from(png.split(',')[1]!, 'base64');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
};
const questions: ClassifierQuestionDefinition[] = [
  { questionId: 'route', type: 'choice', instructions: 'Route', criteria: { a: 'A', b: null } },
  { questionId: 'severity', type: 'score', instructions: 'Rate', criteria: ['Low', 'High'] },
  { questionId: 'repeat', type: 'noul', instructions: 'Repeat?', criteria: { true: 'Yes', false: 'No' } },
];
const response = {
  model: provider.defaultModel,
  answers: {
    route: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } },
    severity: {
      type: 'score',
      score: 0.2,
      confidence: 0.8,
      probabilities: { '0': 0.8, '1': 0.2 },
      legend: { '0': 'Low', '1': 'High' },
    },
    repeat: { type: 'noul', noul: 0.7 },
  },
  usage: { input_tokens: 1000, output_tokens: 3 },
};
const args = () => ({
  apiKey: 'private-key',
  model: provider.defaultModel,
  questions,
  state: { review: 'Incident', count: 3 },
  signal: new AbortController().signal,
  timeoutMs: 30_000,
});
const context = () =>
  ({
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: { classifierProviders: { perplexity: { apiKey: 'private-key' } } },
    project: { metadata: { id: 'project' }, graphs: {} },
  }) as InternalProcessContext;

test('Perplexity sends the complete native batch, JSON State and Bearer key with no chat fields', async () => {
  const captured = args();
  const attempts: unknown[] = [];
  let calls = 0;
  const result = await provider.evaluate({
    ...captured,
    onAttempt: (event) => attempts.push(event),
    fetchImplementation: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.perplexity.ai/v1/decisions');
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-key');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: provider.defaultModel,
        state: captured.state,
        questions: Object.fromEntries(questions.map(({ questionId, ...definition }) => [questionId, definition])),
      });
      return Response.json(response);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.response, response);
  assert.deepEqual(result.responseBody, response);
  assert.doesNotMatch(JSON.stringify([result, attempts]), /private-key/);
  assert.match(JSON.stringify(attempts), /estimatedCostUsd/);
  assert.equal(
    calculateClassifierUsageCost(provider, response.usage, {
      requestedModel: provider.defaultModel,
      responseModel: response.model,
    }),
    0.00002,
  );
  assert.equal(
    calculateClassifierUsageCost(provider, response.usage, {
      requestedModel: provider.defaultModel,
      responseModel: 'unknown',
    }),
    undefined,
  );
});

test('Perplexity inline/profile modes preserve ordered image evidence, diagnostics and free output pricing', async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(response);
  };
  const ctx = context();
  const node = ClassifierEvaluateNodeImpl.create();
  node.data = { ...node.data, provider: provider.id, model: '', outputUsage: true };
  const inputs = {
    state: {
      type: 'chat-message[]' as const,
      value: [
        {
          type: 'user' as const,
          message: [
            'Before',
            { mediaType: 'image/png' as const, data: new Uint8Array(Buffer.from(png.split(',')[1]!, 'base64')) },
            'After',
          ],
        },
        { type: 'user' as const, message: 'Next message' },
      ],
    },
    question1: { type: 'object[]' as const, value: questions },
  };
  const inline = await new ClassifierEvaluateNodeImpl(node).process(inputs, ctx);
  const profileNode = ClassifierProfileNodeImpl.create();
  Object.assign(profileNode.data, { provider: provider.id, model: '' });
  const profile = (await new ClassifierProfileNodeImpl(profileNode).process({}, { ...ctx, node: profileNode }))
    .profile!;
  node.data.configurationMode = 'profile';
  const configured = await new ClassifierEvaluateNodeImpl(node).process({ ...inputs, classifierProfile: profile }, ctx);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[0]!.state, ['Before', '\n', imagePart(png), '\n', 'After', '\n\n', 'Next message']);
  assert.equal(bodies[0]!.images, undefined);
  assert.deepEqual(inline, configured);
  assert.equal(inline.cost?.value, 0.00002);
  assert.deepEqual(inline.usage?.value, { ...response.usage, totalCost: 0.00002 });
  assert.doesNotMatch(JSON.stringify(profileNode), /private-key/);
});

test('Perplexity credentials are provider-scoped and the older model retains known pricing', async () => {
  const ctx = context();
  const credentials = { providerId: provider.id, defaults: provider.credentialNames, context: ctx, inputs: {} };
  assert.equal(resolveClassifierApiKey({ ...credentials, apiKeySource: 'classifier-settings' }), 'private-key');
  assert.equal(provider.credentialNames.environmentVariableName, 'PERPLEXITY_API_KEY');
  assert.equal(provider.credentialNames.programmaticName, 'perplexityApiKey');
  assert.equal(provider.browserExecutionSupported, false);
  const model = 'pplx-decider-v1-27b';
  await provider.evaluate({
    ...args(),
    model,
    fetchImplementation: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).model, model);
      return Response.json({ ...response, model });
    },
  });
  assert.equal(
    calculateClassifierUsageCost(provider, response.usage, {
      requestedModel: model,
      responseModel: model,
    }),
    0.00002,
  );
});

test('Perplexity tile limits apply to normalized images and native JSON State without rewriting nested evidence', async () => {
  for (const [width, height] of [
    [1440, 1440],
    [2048, 1024],
  ]) {
    const state = [imagePart(sizedPng(width!, height!))];
    await provider.evaluate({
      ...args(),
      state,
      fetchImplementation: async (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)).state, state);
        return Response.json(response);
      },
    });
  }
  for (const url of [
    sizedPng(1600, 1310),
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  ]) {
    for (const evidence of [
      { state: imagePart(url) },
      { state: '', stateMessages: [{ parts: [{ type: 'image' as const, dataUrl: url }] }] },
    ])
      await assert.rejects(
        provider.evaluate({
          ...args(),
          ...evidence,
          fetchImplementation: async () => {
            assert.fail('Unsupported evidence must not reach HTTP');
          },
        }),
        (error: any) => error.kind === 'capability',
      );
  }
  for (const state of [
    imagePart('https://example.com/image.png'),
    imagePart('bad'),
    Array.from({ length: 129 }, () => imagePart(png)),
  ]) {
    await assert.rejects(
      provider.evaluate({
        ...args(),
        state: state as any,
        fetchImplementation: async () => {
          assert.fail('Invalid native State must not reach HTTP');
        },
      }),
      (error: any) => error.kind === 'capability',
    );
  }
  const state = { evidence: imagePart('https://example.com/image.png') };
  await provider.evaluate({
    ...args(),
    state,
    fetchImplementation: async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)).state, state);
      return Response.json(response);
    },
  });
});

test('Perplexity supports PNG, JPEG and WebP inline parts and rejects null Score levels', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 3, 1]);
  const webp = new Uint8Array(30);
  webp.set(Buffer.from('RIFF'), 0);
  webp.set(Buffer.from('WEBP'), 8);
  webp.set(Buffer.from('VP8X'), 12);
  webp[24] = 2;
  webp[27] = 1;
  for (const [mime, bytes] of [
    ['image/jpeg', jpeg],
    ['image/webp', webp],
  ] as const) {
    const state = imagePart(`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
    await provider.evaluate({ ...args(), state, fetchImplementation: async () => Response.json(response) });
  }
  await assert.rejects(
    provider.evaluate({
      ...args(),
      questions: [{ questionId: 'score', type: 'score', instructions: 'Rate', criteria: ['Low', null] }],
      fetchImplementation: async () => {
        assert.fail('Null Score levels must not reach HTTP');
      },
    }),
    (error: any) => error.kind === 'capability',
  );
});

test('Perplexity enforces 128 questions per candidate and can fall back without splitting the batch', async () => {
  const batch = Array.from({ length: 129 }, (_, i) => ({
    questionId: `q${i}`,
    type: 'noul' as const,
    instructions: 'Check',
  }));
  const node = ClassifierEvaluateNodeImpl.create();
  node.data.configurationMode = 'profile';
  node.data.outputClassifierAttempts = true;
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body));
    return Response.json({
      model: body.model,
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.5 }])),
      usage: response.usage,
    });
  };
  await provider.evaluate({ ...args(), questions: batch.slice(0, 128) });
  assert.deepEqual(calls, ['https://api.perplexity.ai/v1/decisions']);
  calls.length = 0;
  const result = await new ClassifierEvaluateNodeImpl(node).process(
    {
      question1: { type: 'object[]', value: batch },
      classifierProfile: {
        type: 'any[]',
        value: ['perplexity', 'jev'].map((id) => ({
          version: 1,
          configuration: { provider: id, model: getClassifierProvider(id).defaultModel },
          credential: { value: 'private-key' },
        })),
      },
    },
    context(),
  );
  assert.deepEqual(calls, ['https://api.typesafe.ai/v1/systemone']);
  assert.equal(Object.keys(result.answers!.value as object).length, 129);
  assert.match(JSON.stringify(result.classifierAttempts), /capability/);
});

test('Perplexity uses shared rate-limit retries with identical bodies and no authentication retry', async () => {
  const bodies: string[] = [];
  await provider.evaluate({
    ...args(),
    fetchImplementation: async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json(response);
    },
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  let calls = 0;
  await assert.rejects(
    provider.evaluate({
      ...args(),
      retryOnNon200: true,
      fetchImplementation: async () => {
        calls++;
        return new Response('private-key', { status: 401 });
      },
    }),
    (error: any) => error.statusCode === 401 && !error.message.includes('private-key'),
  );
  assert.equal(calls, 1);
});

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AssembleMessageNodeImpl, ClassifierEvaluateNodeImpl, ClassifierProfileNodeImpl } from '../../../src/index.js';
import {
  getClassifierProvider,
  calculateClassifierUsageCost,
  ClassifierProviderError,
} from '../../../src/model/classifier/providers.js';
import { BASETEN_DECISION_MODELS } from '../../../src/model/classifier/baseten.js';
import { resolveClassifierApiKey } from '../../../src/model/classifier/credentials.js';
import type { ClassifierQuestionDefinition } from '../../../src/model/classifier/types.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const provider = getClassifierProvider('baseten');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64',
);
const imageUrl = `data:image/png;base64,${png.toString('base64')}`;
const q: ClassifierQuestionDefinition = { questionId: 'q', type: 'noul', instructions: 'Ready?' };
const answer = { type: 'noul', noul: 0.9 };
const response = { model: 'backend-model-id', answers: { q: answer }, usage: { input_tokens: 100, output_tokens: 1 } };
const context = () =>
  ({
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: { classifierProviders: { baseten: { apiKey: 'fixture-key' } } },
  }) as InternalProcessContext;
const args = () => ({
  model: provider.defaultModel,
  apiKey: 'fixture-key',
  state: { ticket: 'Help' },
  questions: [q],
  signal: new AbortController().signal,
});

void test('Baseten inline/Profile modes preserve both exact model slugs, multimodal order and unknown cost without exposing credentials', async () => {
  const assembled = await new AssembleMessageNodeImpl(AssembleMessageNodeImpl.create()).process({
    part1: { type: 'string', value: 'Before' },
    part2: { type: 'image', value: { mediaType: 'image/png', data: png } },
    part3: { type: 'string', value: 'After' },
  });
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://inference.baseten.co/v1/systemone');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(init?.headers, { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' });
    const body = JSON.parse(String(init?.body));
    assert.ok(BASETEN_DECISION_MODELS.includes(body.model));
    assert.deepEqual(body.state, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Before' },
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: 'After' },
          ],
        },
      ],
    });
    assert.equal(body.images, undefined);
    assert.deepEqual(body.questions, { q: { type: 'noul', instructions: 'Ready?' } });
    return Response.json(response);
  };
  for (const model of BASETEN_DECISION_MODELS)
    for (const mode of ['inline', 'profile'] as const) {
      const node = ClassifierEvaluateNodeImpl.create();
      Object.assign(node.data, {
        provider: 'baseten',
        model,
        configurationMode: mode,
        apiKeySource: 'classifier-settings',
        outputUsage: true,
        outputRequestBody: true,
        outputResponseBody: true,
      });
      const profile = ClassifierProfileNodeImpl.create();
      Object.assign(profile.data, { provider: 'baseten', model, apiKeySource: 'classifier-settings' });
      const profileOutput = await new ClassifierProfileNodeImpl(profile).process({}, { ...context(), node: profile });
      const result = await new ClassifierEvaluateNodeImpl(node).process(
        {
          state: assembled.message!,
          question1: { type: 'object', value: q },
          ...(mode === 'profile' ? { classifierProfile: profileOutput.profile! } : {}),
        },
        context(),
      );
      assert.deepEqual(result.answers!.value, response.answers);
      assert.equal(result.cost!.type, 'control-flow-excluded');
      assert.equal((result.usage!.value as Record<string, unknown>).totalCost, undefined);
      assert.doesNotMatch(JSON.stringify(result), /fixture-key/);
    }
  assert.equal(calls, 4);
  assert.equal(provider.browserExecutionSupported, false);
  assert.equal(
    calculateClassifierUsageCost(provider, response.usage, {
      requestedModel: provider.defaultModel,
      responseModel: response.model,
    }),
    undefined,
  );
  assert.deepEqual(provider.credentialNames, {
    programmaticName: 'basetenApiKey',
    environmentVariableName: 'BASETEN_API_KEY',
  });
  assert.equal(
    resolveClassifierApiKey({
      context: context(),
      inputs: {},
      providerId: 'baseten',
      defaults: provider.credentialNames,
      apiKeySource: 'classifier-settings',
    }),
    'fixture-key',
  );
});

void test('Baseten passes structured State, typed questions and non-normalized Score answers unchanged', async () => {
  const questions: ClassifierQuestionDefinition[] = [
    { questionId: 'choice', type: 'choice', instructions: { task: 'Choose' }, criteria: { a: ['A'], b: null } },
    { questionId: 'score', type: 'score', instructions: 'Rate', criteria: ['Low', { label: 'Mid' }, 'High'] },
    q,
  ];
  const body = {
    ...response,
    answers: {
      q: answer,
      choice: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } },
      score: {
        type: 'score',
        score: 1.5,
        confidence: 0.2,
        probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 },
        legend: { '0': 'Low', '1': { label: 'Mid' }, '2': 'High' },
      },
    },
  };
  for (const state of [
    { ticket: 'Help' },
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Help' }] },
        { role: 'assistant', content: 'What happened?' },
      ],
    },
  ]) {
    const result = await provider.evaluate({
      ...args(),
      state,
      questions,
      fetchImplementation: async (_url, init) => {
        const sent = JSON.parse(String(init?.body));
        assert.deepEqual(sent.state, state);
        assert.deepEqual(sent.questions.choice.instructions, { task: 'Choose' });
        return Response.json(body);
      },
    });
    assert.deepEqual(result.response, body);
  }
});

void test('Baseten documented limits also apply to native JSON conversations and fail before HTTP', async (t) => {
  let calls = 0;
  const fetchImplementation: typeof fetch = async (_url, init) => {
    calls++;
    const sent = JSON.parse(String(init?.body));
    return Response.json({
      ...response,
      answers: Object.fromEntries(Object.keys(sent.questions).map((id) => [id, answer])),
    });
  };
  const messages = (parts: unknown[], role: unknown = 'user') => ({ messages: [{ role, content: parts }] });
  const part = { type: 'image_url', image_url: { url: imageUrl } };
  for (const [label, patch, reason] of [
    [
      'too many options',
      { questions: Array.from({ length: 257 }, (_, index) => ({ ...q, questionId: `q${index}` })) },
      /512 options/,
    ],
    ['too much text', { state: 'a'.repeat(50001) }, /50,000 characters/],
    ['too many images', { state: messages(Array(5).fill(part)) }, /at most four images/],
    ['assistant image', { state: messages([part], 'assistant') }, /user messages only/],
    ['bad role', { state: messages([{ type: 'text', text: 'Hello' }], 'system') }, /user or assistant roles/],
    ['non-string role', { state: messages([{ type: 'text', text: 'Hello' }], ['user']) }, /user or assistant roles/],
    [
      'unsupported part',
      { state: messages([{ type: 'input_audio', data: 'not supported' }]) },
      /text and image_url parts only/,
    ],
    [
      'bad detail',
      { state: messages([{ ...part, image_url: { url: imageUrl, detail: 'high' } }]) },
      /detail must be auto/,
    ],
    [
      'remote image',
      { state: messages([{ ...part, image_url: { url: 'https://example.test/image.png' } }]) },
      /inline base64/,
    ],
    [
      'GIF image',
      {
        state: messages([
          { ...part, image_url: { url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' } },
        ]),
      },
      /not GIF/,
    ],
    ['unknown image model', { model: 'future-model', state: messages([part]) }, /Image support is not known/],
    [
      'question image',
      {
        questions: [
          { ...q, instructions: '', instructionsMessages: [{ parts: [{ type: 'image', dataUrl: imageUrl }] }] },
        ],
      },
      /does not support images in question instructions/,
    ],
    ['box', { questions: [{ ...q, type: 'box' }] }, /does not support Bounding Box/],
  ] as const)
    await t.test(label, async () => {
      await assert.rejects(
        provider.evaluate({ ...args(), ...patch, fetchImplementation } as Parameters<typeof provider.evaluate>[0]),
        (error) =>
          error instanceof ClassifierProviderError && error.kind === 'capability' && reason.test(error.message),
      );
      assert.equal(calls, 0, `${label} must fail before HTTP`);
    });
  assert.equal(calls, 0);
  for (const state of [messages(Array(4).fill(part)), '😀'.repeat(50000)])
    await provider.evaluate({ ...args(), state, fetchImplementation });
  await provider.evaluate({
    ...args(),
    questions: Array.from({ length: 256 }, (_, index) => ({ ...q, questionId: `q${index}` })),
    fetchImplementation,
  });
  assert.equal(calls, 3);
});

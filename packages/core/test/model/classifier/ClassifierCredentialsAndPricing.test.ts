import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ClassifierEvaluateNodeImpl, type InternalProcessContext } from '../../../src/index.js';
import { resolveClassifierApiKey } from '../../../src/model/classifier/credentials.js';
import { calculateClassifierUsageCost, getClassifierProvider } from '../../../src/model/classifier/providers.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

void test('Classifier settings is strict and provider-scoped while Automatic preserves credential precedence', () => {
  for (const providerId of ['jev', 'liquid', 'openai']) {
    const provider = getClassifierProvider(providerId);
    const context = {
      settings: {
        [provider.credentialNames.programmaticName]: 'general',
        openAiKey: 'legacy-general',
        pluginEnv: { [provider.credentialNames.environmentVariableName]: 'environment' },
        pluginSettings: { typesafe: { typesafeApiKey: 'legacy-plugin' } },
        classifierProviders: {
          [providerId]: { apiKey: '  classifier-specific  ' },
          other: { apiKey: 'other-provider' },
        },
      },
    } as Pick<InternalProcessContext, 'settings'>;
    const args = { providerId, defaults: provider.credentialNames, context, inputs: {} };
    assert.equal(resolveClassifierApiKey(args), 'general');
    assert.equal(resolveClassifierApiKey({ ...args, apiKeySource: 'configured' }), 'general');
    assert.equal(resolveClassifierApiKey({ ...args, apiKeySource: 'classifier-settings' }), 'classifier-specific');
    assert.equal(
      resolveClassifierApiKey({
        ...args,
        apiKeySource: 'input',
        inputs: { apiKey: { type: 'string', value: 'port' } },
      }),
      'port',
    );
    context.settings.classifierProviders![providerId]!.apiKey = ' ';
    assert.throws(
      () => resolveClassifierApiKey({ ...args, apiKeySource: 'classifier-settings' }),
      /No automatic fallback/,
    );
    assert.equal(resolveClassifierApiKey(args), 'general');
    assert.throws(
      () => resolveClassifierApiKey({ ...args, apiKeySource: 'invalid' as any }),
      /Unknown classifier API key source/,
    );
  }
});

void test('Pricing recognizes exact aliases, rejects unverified model pairs and applies Decisions long-context rates', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 999 };
  const cost = (provider: string, requestedModel: string, responseModel: string, input_tokens = usage.input_tokens) =>
    calculateClassifierUsageCost(
      getClassifierProvider(provider),
      { ...usage, input_tokens },
      { requestedModel, responseModel },
    );
  assert.equal(cost('jev', 'jev-latest', 'jev-1.13.0'), 0.042);
  assert.equal(cost('jev', 'jev-preview', 'jev-1.13.0'), 0.042);
  assert.equal(cost('liquid', 'd1', 'd1'), 0.04);
  for (const [requested, returned] of [
    ['d1:free', 'd1:free'],
    ['unpriced-model', 'd1'],
    ['d1', 'unpriced-model'],
    ['d1', 'd1:free'],
  ])
    assert.equal(cost('liquid', requested!, returned!), undefined);
  assert.equal(cost('jev', 'jev-latest', 'jev-1.14.0'), undefined);
  assert.equal(cost('openai', 'gpt-6-luna', 'gpt-6-luna', 272_000), 0.0272);
  assert.equal(cost('openai', 'gpt-6-luna', 'gpt-6-luna', 272_001), 0.0544002);
  assert.equal(cost('openai', 'gpt-6-luna', 'gpt-6-luna'), 0.2);
  assert.equal(calculateClassifierUsageCost(getClassifierProvider('liquid'), usage), undefined);
});

void test('Decisions pricing ignores cache/output metadata and uses input tokens for the context threshold', () => {
  const provider = getClassifierProvider('openai');
  const models = { requestedModel: 'gpt-6-luna', responseModel: 'gpt-6-luna' };
  for (const input_tokens of [0, 1, 271_999, 272_000, 272_001, 1_000_000]) {
    const usage = {
      input_tokens,
      output_tokens: 9_999,
      total_tokens: 2_000_000,
      input_tokens_details: { cached_tokens: input_tokens, cache_write_tokens: input_tokens },
    };
    const expected = (input_tokens * (input_tokens > 272_000 ? 0.2 : 0.1)) / 1_000_000;
    assert.equal(calculateClassifierUsageCost(provider, usage, models), expected);
    assert.equal(
      calculateClassifierUsageCost(provider, { input_tokens, output_tokens: 0 }, models),
      expected,
      'optional usage details must not add charges or discounts to Decisions',
    );
  }
});

void test('All providers price aggregate multi-question usage once and preserve raw usage and diagnostics', async () => {
  const image =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const questions = ['first', 'second'].map((questionId) => ({
    questionId,
    type: 'noul',
    instructions: 'Evaluate the shared evidence',
  }));
  for (const [providerId, inputRate] of [
    ['jev', 0.042],
    ['liquid', 0.04],
    ['openai', 0.1],
  ] as const) {
    for (const outputUsage of [false, true]) {
      const provider = getClassifierProvider(providerId);
      // Billed input is supplied by the provider, including image work for both
      // questions where supported. Do not estimate it from bytes or add it again.
      const usage = {
        input_tokens: 3_200,
        output_tokens: 20,
        total_tokens: 3_220,
        input_tokens_details: { cached_tokens: 100, cache_write_tokens: 200 },
      };
      const responseBody = {
        model: providerId === 'jev' ? 'jev-1.13.0' : provider.defaultModel,
        answers:
          providerId === 'openai'
            ? questions.map(({ questionId }) => ({ name: questionId, type: 'predicate', probability: 0.8 }))
            : Object.fromEntries(questions.map(({ questionId }) => [questionId, { type: 'noul', noul: 0.8 }])),
        usage,
      };
      let calls = 0;
      let sent: any;
      globalThis.fetch = async (_url, init) => {
        calls++;
        sent = JSON.parse(String(init?.body));
        return Response.json(responseBody);
      };
      const node = ClassifierEvaluateNodeImpl.create();
      node.data = { ...node.data, provider: providerId, outputUsage, outputResponseBody: true };
      const outputs = await new ClassifierEvaluateNodeImpl(node).process(
        {
          state: {
            type: 'chat-message[]',
            value: [{ type: 'user', message: providerId === 'jev' ? ['Seven', 'Three'] : ['Caption', image] }],
          },
          question1: { type: 'object[]', value: questions },
        },
        {
          executor: 'nodejs',
          signal: new AbortController().signal,
          settings: { classifierProviders: { [providerId]: { apiKey: 'fixture' } } },
        } as InternalProcessContext,
      );
      const expected = (3_200 * inputRate) / 1_000_000;
      assert.equal(calls, 1);
      assert.equal(Object.keys(sent.questions).length, 2);
      if (providerId === 'liquid') assert.deepEqual(sent.images, [image]);
      if (providerId === 'openai') assert.equal(sent.input[0].content[1].type, 'input_image');
      assert.equal(outputs.cost!.type, 'number');
      assert.equal(outputs.cost!.value, expected);
      assert.deepEqual(outputs.usage!.value, outputUsage ? { ...usage, totalCost: expected } : usage);
      assert.deepEqual(outputs.responseBody!.value, responseBody);
      assert.equal(Object.hasOwn(usage, 'totalCost'), false);
    }
  }
});

void test('Strict saved credentials reject inherited fields and accessors without reading them', () => {
  const provider = getClassifierProvider('liquid');
  let reads = 0;
  const accessor = (key: string) =>
    Object.defineProperty({}, key, {
      get: () => {
        reads++;
        return 'not-a-saved-key';
      },
    });
  for (const settings of [
    Object.create({ classifierProviders: { liquid: { apiKey: 'inherited' } } }),
    { classifierProviders: Object.create({ liquid: { apiKey: 'inherited' } }) },
    { classifierProviders: { liquid: Object.create({ apiKey: 'inherited' }) } },
    accessor('classifierProviders'),
    { classifierProviders: accessor('liquid') },
    { classifierProviders: { liquid: accessor('apiKey') } },
  ]) {
    assert.throws(
      () =>
        resolveClassifierApiKey({
          apiKeySource: 'classifier-settings',
          providerId: provider.id,
          defaults: provider.credentialNames,
          context: { settings },
          inputs: {},
        }),
      /own data properties/,
    );
  }
  assert.equal(reads, 0);
  const keys = Object.assign(Object.create(null), { liquid: { apiKey: 'saved' } });
  assert.equal(
    resolveClassifierApiKey({
      apiKeySource: 'classifier-settings',
      providerId: provider.id,
      defaults: provider.credentialNames,
      context: { settings: { classifierProviders: keys } },
      inputs: {},
    }),
    'saved',
  );
});

void test('Invalid model-pricing metadata never produces a cost, even below an invalid tier threshold', () => {
  const models = { requestedModel: 'test-model', responseModel: 'test-model' };
  for (const input_tokens of [0, 1, 1_000_000]) {
    for (const aboveInputTokens of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        calculateClassifierUsageCost(
          {
            modelPricing: [
              {
                models: ['test-model'],
                pricing: {
                  inputPerMillionTokens: 1,
                  outputPerMillionTokens: 0,
                  longContext: { aboveInputTokens, inputPerMillionTokens: 2, outputPerMillionTokens: 0 },
                },
              },
            ],
          },
          { input_tokens, output_tokens: 0 },
          models,
        ),
        undefined,
      );
    }
  }
  for (const invalidRate of [NaN, Infinity, -1]) {
    for (const tier of ['base', 'longContext']) {
      for (const rate of ['inputPerMillionTokens', 'outputPerMillionTokens']) {
        const pricing = {
          inputPerMillionTokens: 1,
          outputPerMillionTokens: 0,
          longContext: { aboveInputTokens: 100, inputPerMillionTokens: 2, outputPerMillionTokens: 0 },
        };
        if (tier === 'base') pricing[rate as 'inputPerMillionTokens' | 'outputPerMillionTokens'] = invalidRate;
        else pricing.longContext[rate as 'inputPerMillionTokens' | 'outputPerMillionTokens'] = invalidRate;
        for (const input_tokens of [0, 1, 101])
          assert.equal(
            calculateClassifierUsageCost(
              { modelPricing: [{ models: ['test-model'], pricing }] },
              { input_tokens, output_tokens: 0 },
              models,
            ),
            undefined,
          );
      }
    }
  }
});

void test('Unknown pricing preserves successful Answers and raw Usage but excludes Cost and Usage.totalCost', async () => {
  for (const model of ['d1:free', 'future-model']) {
    for (const outputUsage of [false, true]) {
      const node = ClassifierEvaluateNodeImpl.create();
      node.data = { ...node.data, provider: 'liquid', model, outputUsage, apiKeySource: 'classifier-settings' };
      let authorization = '';
      const body = {
        model,
        answers: { q: { type: 'noul', noul: 0.8 } },
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      };
      globalThis.fetch = async (_url, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        return Response.json(body);
      };
      const output = await new ClassifierEvaluateNodeImpl(node).process(
        {
          question1: { type: 'object', value: { questionId: 'q', type: 'noul', instructions: 'Check' } },
        },
        {
          executor: 'nodejs',
          signal: new AbortController().signal,
          settings: {
            liquidApiKey: 'shadow-key',
            classifierProviders: { liquid: { apiKey: 'saved-key' } },
          },
        } as InternalProcessContext,
      );
      assert.equal(authorization, 'Bearer saved-key');
      assert.deepEqual(output.answers!.value, body.answers);
      assert.deepEqual(output.usage!.value, body.usage);
      assert.equal(output.cost!.type, 'control-flow-excluded');
    }
  }
});

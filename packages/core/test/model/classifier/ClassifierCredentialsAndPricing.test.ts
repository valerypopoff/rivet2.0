import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ClassifierEvaluateNodeImpl, type InternalProcessContext } from '../../../src/index.js';
import { resolveClassifierApiKey } from '../../../src/model/classifier/credentials.js';
import { calculateClassifierUsageCost, getClassifierProvider } from '../../../src/model/classifier/providers.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('Classifier settings is strict and provider-scoped while Automatic preserves credential precedence', () => {
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

test('Pricing recognizes exact aliases, rejects unverified model pairs and applies Decisions long-context rates', () => {
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

test('Strict saved credentials reject inherited fields and accessors without reading them', () => {
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

test('Invalid model-pricing metadata never produces a cost, even below an invalid tier threshold', () => {
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

test('Unknown pricing preserves successful Answers and raw Usage but excludes Cost and Usage.totalCost', async () => {
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

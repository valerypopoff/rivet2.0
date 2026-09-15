import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generativeAiGoogleModels as coreGenerativeAiGoogleModels,
  generativeAiOptions as coreGenerativeAiOptions,
} from '../../core/src/plugins/google/google.js';
import {
  generativeAiGoogleModels,
  generativeAiOptions,
  streamChatCompletions,
  type ChatCompletionOptions,
} from '../overrides/core/plugins/google/google.js';

test('hosted Google adapter preserves only its two legacy zero-price catalog differences', () => {
  assert.deepEqual(Object.keys(generativeAiGoogleModels), Object.keys(coreGenerativeAiGoogleModels));
  assert.deepEqual(generativeAiOptions, coreGenerativeAiOptions);

  assert.deepEqual(generativeAiGoogleModels, {
    'gemini-2.5-pro': {
      maxTokens: 1048576,
      cost: { prompt: 1.25 / 1000, completion: 10 / 1000 },
      displayName: 'Gemini 2.5 Pro',
    },
    'gemini-2.5-flash': {
      maxTokens: 1048576,
      cost: { prompt: 0.3 / 1000, completion: 2.5 / 1000 },
      displayName: 'Gemini 2.5 Flash',
    },
    'gemini-2.5-flash-lite-preview-06-17': {
      maxTokens: 1000000,
      cost: { prompt: 0.1 / 1000, completion: 0.4 / 1000 },
      displayName: 'Gemini 2.5 Flash Lite Preview',
    },
    'gemini-2.0-flash': {
      maxTokens: 1048576,
      cost: { prompt: 0.1 / 1000, completion: 0.4 / 1000 },
      displayName: 'Gemini 2.0 Flash',
    },
    'gemini-2.0-flash-lite': {
      maxTokens: 1048576,
      cost: { prompt: 0.075 / 1000, completion: 0.3 / 1000 },
      displayName: 'Gemini 2.0 Flash Lite',
    },
    'gemini-1.5-pro': {
      maxTokens: 2097152,
      cost: { prompt: 0, completion: 0 },
      displayName: 'Gemini 1.5 Pro',
    },
    'gemini-1.5-flash': {
      maxTokens: 1048576,
      cost: { prompt: 0, completion: 0 },
      displayName: 'Gemini 1.5 Flash',
    },
  });

  for (const modelId of ['gemini-1.5-pro', 'gemini-1.5-flash'] as const) {
    const hosted = generativeAiGoogleModels[modelId];
    const core = coreGenerativeAiGoogleModels[modelId];

    assert.deepEqual(hosted.cost, { prompt: 0, completion: 0 });
    assert.equal('pricing' in hosted, false);
    assert.equal(core.pricing, 'unpriced');
    assert.equal('cost' in core, false);
  }

  assert.deepEqual(coreGenerativeAiGoogleModels['gemini-1.5-pro'], {
    maxTokens: 2097152,
    displayName: 'Gemini 1.5 Pro',
    pricing: 'unpriced',
  });
});

test('hosted Google adapter rejects Vertex credentials only when the generator advances', async () => {
  const options: ChatCompletionOptions = {
    project: 'synthetic-project',
    location: 'synthetic-location',
    applicationCredentials: 'synthetic-credentials',
    model: 'gemini-pro',
    prompt: [],
    max_output_tokens: 1,
  };
  const iterator = streamChatCompletions(options);

  await assert.rejects(
    iterator.next(),
    new Error(
      'Google Vertex AI with application credentials is not supported in the hosted browser wrapper. Configure `googleApiKey` to use the browser-safe Google Generative AI path instead.',
    ),
  );
});

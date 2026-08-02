import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { Settings } from '@valerypopoff/rivet2-core';

import {
  getChatV2ModelCatalogCacheKey,
  getChatV2DiscoveredModelOptionsWithStatus,
  invalidateChatV2DiscoveredModelOptions,
} from './chatV2ModelCatalog.js';

const originalFetch = globalThis.fetch;

function createContext(apiKey?: string) {
  return {
    settings: {
      openAiEndpoint: 'https://api.openai.com/v1/responses',
      openAiApiKey: 'configured-openai-key',
      openAiKey: '',
      anthropicApiKey: 'configured-anthropic-key',
      googleApiKey: 'configured-google-key',
    } as Settings,
    plugins: [],
    apiKey,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('OpenAI model refresh uses the explicit API key override', async () => {
  const context = createContext('input-openai-key');
  let authorization: string | null = null;
  let requestUrl = '';

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get('Authorization');
    return new Response(JSON.stringify({ data: [{ id: 'gpt-test-model' }] }));
  };

  invalidateChatV2DiscoveredModelOptions('openai', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('openai', context);

  assert.equal(result.source, 'api');
  assert.equal(requestUrl, 'https://api.openai.com/v1/models');
  assert.equal(authorization, 'Bearer input-openai-key');
});

test('OpenAI model refresh retains static GPT-5.6 Luna when the API list omits it', async () => {
  const context = createContext('input-openai-key');

  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'gpt-api-only-model' }] }));

  invalidateChatV2DiscoveredModelOptions('openai', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('openai', context);

  assert.equal(result.source, 'api');
  assert.ok(result.options.some((option) => option.value === 'gpt-api-only-model'));
  assert.ok(result.options.some((option) => option.value === 'gpt-5.6-luna'));
});

test('OpenAI model refresh ignores stale legacy endpoint and chat headers', async () => {
  const context = {
    settings: {
      ...createContext().settings,
      openAiEndpoint: 'https://stale.example.com/v1/chat/completions',
      chatNodeHeaders: {
        Authorization: 'Bearer stale-header-key',
      },
    } as Settings,
    plugins: [],
  };
  let authorization: string | null = null;
  let requestUrl = '';

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get('Authorization');
    return new Response(JSON.stringify({ data: [{ id: 'gpt-configured-model' }] }));
  };

  invalidateChatV2DiscoveredModelOptions('openai', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('openai', context);

  assert.equal(result.source, 'api');
  assert.equal(requestUrl, 'https://api.openai.com/v1/models');
  assert.equal(authorization, 'Bearer configured-openai-key');
});

test('OpenAI model refresh cache stays scoped by explicit API key override', async () => {
  const firstContext = createContext('input-openai-key-a');
  const secondContext = createContext('input-openai-key-b');
  const authorizations: string[] = [];

  globalThis.fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
    return new Response(JSON.stringify({ data: [{ id: `gpt-test-model-${authorizations.length}` }] }));
  };

  invalidateChatV2DiscoveredModelOptions('openai', firstContext);
  invalidateChatV2DiscoveredModelOptions('openai', secondContext);

  const firstResult = await getChatV2DiscoveredModelOptionsWithStatus('openai', firstContext);
  const secondResult = await getChatV2DiscoveredModelOptionsWithStatus('openai', secondContext);
  const cachedFirstResult = await getChatV2DiscoveredModelOptionsWithStatus('openai', firstContext);

  assert.equal(firstResult.source, 'api');
  assert.equal(secondResult.source, 'api');
  assert.equal(cachedFirstResult.source, 'api');
  assert.deepEqual(authorizations, ['Bearer input-openai-key-a', 'Bearer input-openai-key-b']);
});

test('model catalog cache identity fingerprints credentials without exposing them', () => {
  const cacheKey = getChatV2ModelCatalogCacheKey('openai', createContext('input-openai-secret'));

  assert.doesNotMatch(cacheKey, /input-openai-secret/);
  assert.match(cacheKey, /openai/);
});

test('OpenAI model refresh uses the configured openAiApiKey alias', async () => {
  const context = createContext();
  let authorization: string | null = null;

  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get('Authorization');
    return new Response(JSON.stringify({ data: [{ id: 'gpt-configured-model' }] }));
  };

  invalidateChatV2DiscoveredModelOptions('openai', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('openai', context);

  assert.equal(result.source, 'api');
  assert.equal(authorization, 'Bearer configured-openai-key');
});

test('Anthropic model refresh uses the explicit API key override without configured plugin credentials', async () => {
  const context = createContext('input-anthropic-key');
  let apiKey: string | null = null;

  globalThis.fetch = async (_input, init) => {
    apiKey = new Headers(init?.headers).get('x-api-key');
    return new Response(JSON.stringify({ data: [{ id: 'claude-test-model', display_name: 'Claude Test' }] }));
  };

  invalidateChatV2DiscoveredModelOptions('anthropic', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('anthropic', context);

  assert.equal(result.source, 'api');
  assert.equal(apiKey, 'input-anthropic-key');
});

test('Anthropic model refresh uses the configured LLM settings key', async () => {
  const context = createContext();
  let apiKey: string | null = null;

  globalThis.fetch = async (_input, init) => {
    apiKey = new Headers(init?.headers).get('x-api-key');
    return new Response(
      JSON.stringify({ data: [{ id: 'claude-configured-model', display_name: 'Claude Configured' }] }),
    );
  };

  invalidateChatV2DiscoveredModelOptions('anthropic', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('anthropic', context);

  assert.equal(result.source, 'api');
  assert.equal(apiKey, 'configured-anthropic-key');
});

test('Anthropic model refresh ignores stale legacy chat headers', async () => {
  const context = {
    settings: {
      ...createContext().settings,
      chatNodeHeaders: {
        'x-api-key': 'stale-anthropic-header-key',
        'anthropic-version': '2020-01-01',
      },
    } as Settings,
    plugins: [],
  };
  let apiKey: string | null = null;
  let anthropicVersion: string | null = null;

  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    apiKey = headers.get('x-api-key');
    anthropicVersion = headers.get('anthropic-version');
    return new Response(
      JSON.stringify({ data: [{ id: 'claude-configured-model', display_name: 'Claude Configured' }] }),
    );
  };

  invalidateChatV2DiscoveredModelOptions('anthropic', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('anthropic', context);

  assert.equal(result.source, 'api');
  assert.equal(apiKey, 'configured-anthropic-key');
  assert.equal(anthropicVersion, '2023-06-01');
});

test('Anthropic model refresh falls back to the legacy plugin key', async () => {
  const context = {
    settings: {
      openAiEndpoint: 'https://api.openai.com/v1/responses',
      openAiKey: 'configured-openai-key',
      anthropicApiKey: '',
      pluginSettings: {
        anthropic: {
          anthropicApiKey: 'legacy-plugin-anthropic-key',
        },
      },
    } as Settings,
    plugins: [
      {
        id: 'anthropic',
        configSpec: {
          anthropicApiKey: {
            type: 'secret' as const,
            label: 'Anthropic API Key',
          },
        },
      },
    ],
  };
  let apiKey: string | null = null;

  globalThis.fetch = async (_input, init) => {
    apiKey = new Headers(init?.headers).get('x-api-key');
    return new Response(JSON.stringify({ data: [{ id: 'claude-plugin-model', display_name: 'Claude Plugin' }] }));
  };

  invalidateChatV2DiscoveredModelOptions('anthropic', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('anthropic', context);

  assert.equal(result.source, 'api');
  assert.equal(apiKey, 'legacy-plugin-anthropic-key');
});

test('Anthropic model refresh ignores stale legacy plugin endpoint', async () => {
  const context = {
    settings: {
      ...createContext().settings,
      anthropicApiKey: '',
      pluginSettings: {
        anthropic: {
          anthropicApiKey: 'legacy-plugin-anthropic-key',
          anthropicApiEndpoint: 'https://stale-anthropic.example/v1',
        },
      },
    } as Settings,
    plugins: [
      {
        id: 'anthropic',
        configSpec: {
          anthropicApiKey: {
            type: 'secret' as const,
            label: 'Anthropic API Key',
          },
          anthropicApiEndpoint: {
            type: 'string' as const,
            label: 'Anthropic API Endpoint',
          },
        },
      },
    ],
  };
  let requestUrl = '';

  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ data: [{ id: 'claude-plugin-model', display_name: 'Claude Plugin' }] }));
  };

  invalidateChatV2DiscoveredModelOptions('anthropic', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('anthropic', context);

  assert.equal(result.source, 'api');
  assert.equal(requestUrl, 'https://api.anthropic.com/v1/models');
});

test('Google model refresh uses the explicit API key override in the model-list URL', async () => {
  const context = createContext('input-google-key');
  let requestUrl = '';

  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(
      JSON.stringify({
        models: [
          {
            name: 'models/gemini-test-model',
            displayName: 'Gemini Test',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    );
  };

  invalidateChatV2DiscoveredModelOptions('google', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('google', context);

  assert.equal(result.source, 'api');
  assert.match(requestUrl, /key=input-google-key/);
  assert.doesNotMatch(requestUrl, /configured-openai-key/);
});

test('Google model refresh uses the configured LLM settings key', async () => {
  const context = createContext();
  let requestUrl = '';

  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(
      JSON.stringify({
        models: [
          {
            name: 'models/gemini-configured-model',
            displayName: 'Gemini Configured',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    );
  };

  invalidateChatV2DiscoveredModelOptions('google', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('google', context);

  assert.equal(result.source, 'api');
  assert.match(requestUrl, /key=configured-google-key/);
});

test('Google model refresh ignores stale legacy chat headers', async () => {
  const context = {
    settings: {
      ...createContext().settings,
      chatNodeHeaders: {
        Authorization: 'Bearer stale-google-header',
      },
    } as Settings,
    plugins: [],
  };
  let hasInit = false;
  let requestUrl = '';

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    hasInit = init !== undefined;
    return new Response(
      JSON.stringify({
        models: [
          {
            name: 'models/gemini-configured-model',
            displayName: 'Gemini Configured',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    );
  };

  invalidateChatV2DiscoveredModelOptions('google', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('google', context);

  assert.equal(result.source, 'api');
  assert.match(requestUrl, /key=configured-google-key/);
  assert.equal(hasInit, false);
});

test('Google model refresh falls back to the legacy plugin key', async () => {
  const context = {
    settings: {
      openAiEndpoint: 'https://api.openai.com/v1/responses',
      openAiKey: 'configured-openai-key',
      googleApiKey: '',
      pluginSettings: {
        google: {
          googleApiKey: 'legacy-plugin-google-key',
        },
      },
    } as Settings,
    plugins: [
      {
        id: 'google',
        configSpec: {
          googleApiKey: {
            type: 'secret' as const,
            label: 'Google API Key',
          },
        },
      },
    ],
  };
  let requestUrl = '';

  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(
      JSON.stringify({
        models: [
          {
            name: 'models/gemini-plugin-model',
            displayName: 'Gemini Plugin',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    );
  };

  invalidateChatV2DiscoveredModelOptions('google', context);
  const result = await getChatV2DiscoveredModelOptionsWithStatus('google', context);

  assert.equal(result.source, 'api');
  assert.match(requestUrl, /key=legacy-plugin-google-key/);
});

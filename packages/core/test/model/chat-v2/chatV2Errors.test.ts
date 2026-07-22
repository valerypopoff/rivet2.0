import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  getChatV2ProviderErrorStatusCode,
  normalizeChatV2ProviderError,
} from '../../../src/model/chat-v2/chatV2Errors.js';

function createApiError(overrides: Partial<Error & Record<string, unknown>> = {}) {
  const error = new Error('Not Found') as Error & Record<string, unknown>;
  error.name = 'AI_APICallError';
  Object.assign(error, {
    url: 'https://api.cerebras.ai/v1/chat/completions',
    statusCode: 404,
    responseBody: JSON.stringify({
      error: {
        message: 'Model llama-does-not-exist does not exist.',
      },
    }),
    ...overrides,
  });
  return error;
}

describe('normalizeChatV2ProviderError', () => {
  it('turns provider 404 errors into model and endpoint guidance', () => {
    const normalized = normalizeChatV2ProviderError(createApiError(), {
      provider: 'custom',
      modelId: 'llama-does-not-exist',
    });

    assert.ok(normalized instanceof Error);
    assert.equal(normalized.name, 'LLM Chat error');
    assert.match(normalized.message, /404 Not Found/);
    assert.match(normalized.message, /Provider: Custom provider/);
    assert.match(normalized.message, /Model: llama-does-not-exist/);
    assert.match(normalized.message, /Provider base URL/);
    assert.match(normalized.message, /Model llama-does-not-exist does not exist/);
    assert.doesNotMatch(normalized.message, /AI_APICallError/);
  });

  it('shows the original provider message when the SDK error message is identical', () => {
    const providerMessage = 'Grammar error: Unimplemented keys: ["uniqueItems"]';
    const normalized = normalizeChatV2ProviderError(
      createApiError({
        message: providerMessage,
        statusCode: 400,
        responseBody: JSON.stringify({
          error: {
            message: providerMessage,
            type: 'BadRequestError',
            code: 400,
          },
        }),
      }),
      {
        provider: 'custom',
        modelId: 'deepseek-ai/DeepSeek-V4-Flash',
      },
    );

    assert.ok(normalized instanceof Error);
    assert.match(normalized.message, /400 Bad Request/);
    assert.match(normalized.message, /Provider message: Grammar error: Unimplemented keys/);
  });

  it('prefers the original response body message over generic SDK data', () => {
    const normalized = normalizeChatV2ProviderError(
      createApiError({
        statusCode: 400,
        data: { message: 'Request rejected.' },
        responseBody: JSON.stringify({
          error: {
            message: 'Specific provider grammar failure.',
          },
        }),
      }),
      {
        provider: 'custom',
        modelId: 'custom-model',
      },
    );

    assert.ok(normalized instanceof Error);
    assert.match(normalized.message, /Provider message: Specific provider grammar failure/);
    assert.doesNotMatch(normalized.message, /Provider message: Request rejected/);
  });

  it('finds the original provider response through nested SDK error causes', () => {
    const nested = createApiError({
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          message: 'Nested provider detail.',
        },
      }),
    });
    const outer = createApiError({
      message: 'Provider request failed.',
      statusCode: 400,
      responseBody: undefined,
      data: undefined,
      cause: nested,
    });

    const normalized = normalizeChatV2ProviderError(outer, {
      provider: 'custom',
      modelId: 'custom-model',
    });

    assert.ok(normalized instanceof Error);
    assert.match(normalized.message, /Provider message: Nested provider detail/);
  });

  it('preserves the Vercel API status code on normalized provider errors', () => {
    const error = createApiError({
      statusCode: 503,
    });
    const normalized = normalizeChatV2ProviderError(error, {
      provider: 'openai',
      modelId: 'gpt-5',
    });

    assert.ok(normalized instanceof Error);
    assert.equal((normalized as Error & { statusCode?: number }).statusCode, 503);
    assert.equal(normalized.cause, error);
  });

  it('normalizes string-shaped Vercel API status codes for guidance and output handling', () => {
    const normalized = normalizeChatV2ProviderError(
      createApiError({
        statusCode: '401',
      }),
      {
        provider: 'openai',
        modelId: 'gpt-5.4-mini',
      },
    );

    assert.ok(normalized instanceof Error);
    assert.match(normalized.message, /401 Unauthorized/);
    assert.match(normalized.message, /API key source/);
    assert.equal((normalized as Error & { statusCode?: number }).statusCode, 401);
  });

  it('turns browser fetch failures into provider guidance instead of raw TypeError output', () => {
    const normalized = normalizeChatV2ProviderError(new TypeError('Failed to fetch'), {
      provider: 'openai',
      modelId: 'gpt-5.4-mini',
    });

    assert.ok(normalized instanceof Error);
    assert.equal(normalized.name, 'LLM Chat error');
    assert.match(normalized.message, /before Rivet could read an HTTP response/);
    assert.match(normalized.message, /Provider: OpenAI/);
    assert.match(normalized.message, /Model: gpt-5\.4-mini/);
    assert.match(normalized.message, /API key source/);
    assert.match(normalized.message, /Node executor/);
  });

  it('finds provider status codes on nested response and provider data shapes', () => {
    assert.equal(
      getChatV2ProviderErrorStatusCode({
        response: {
          status: '403',
        },
      }),
      403,
    );
    assert.equal(
      getChatV2ProviderErrorStatusCode({
        data: {
          error: {
            statusCode: '429',
          },
        },
      }),
      429,
    );
  });

  it('does not include endpoint query strings in formatted API errors', () => {
    const normalized = normalizeChatV2ProviderError(
      createApiError({
        url: 'https://api.example.test/v1/chat/completions?api_key=secret#fragment',
      }),
      {
        provider: 'custom',
        modelId: 'wrong-model',
      },
    );

    assert.ok(normalized instanceof Error);
    assert.match(normalized.message, /Endpoint: https:\/\/api\.example\.test\/v1\/chat\/completions/);
    assert.doesNotMatch(normalized.message, /secret/);
    assert.doesNotMatch(normalized.message, /fragment/);
  });

  it('does not dump provider data objects without a clear message', () => {
    const normalized = normalizeChatV2ProviderError(
      createApiError({
        statusCode: 401,
        data: {
          requestBodyValues: {
            apiKey: 'sk-secret-from-request',
          },
        },
        responseBody: JSON.stringify({
          requestBodyValues: {
            apiKey: 'sk-secret-from-response',
          },
        }),
      }),
      {
        provider: 'openai',
        modelId: 'gpt-5',
      },
    );

    assert.ok(normalized instanceof Error);
    assert.match(normalized.message, /401 Unauthorized/);
    assert.match(normalized.message, /API key source/);
    assert.doesNotMatch(normalized.message, /sk-secret/);
    assert.doesNotMatch(normalized.message, /requestBodyValues/);
  });

  it('uses scalar nested provider errors without dumping sibling data', () => {
    const normalized = normalizeChatV2ProviderError(
      createApiError({
        data: {
          error: 'Model is not available.',
          requestBodyValues: {
            apiKey: 'sk-secret-from-request',
          },
        },
        responseBody: undefined,
      }),
      {
        provider: 'custom',
        modelId: 'wrong-model',
      },
    );

    assert.ok(normalized instanceof Error);
    assert.match(normalized.message, /Provider message: Model is not available/);
    assert.doesNotMatch(normalized.message, /sk-secret/);
    assert.doesNotMatch(normalized.message, /requestBodyValues/);
  });

  it('adds guidance for known SDK API key errors', () => {
    const error = new Error('Missing API key.');
    error.name = 'LoadAPIKeyError';

    const normalized = normalizeChatV2ProviderError(error, {
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
    });

    assert.ok(normalized instanceof Error);
    assert.match(normalized.message, /LLM API key could not be loaded/);
    assert.match(normalized.message, /Provider: Anthropic/);
    assert.match(normalized.message, /configured provider credentials/);
  });

  it('keeps unrelated runtime errors unchanged', () => {
    const error = new Error('Tool execution failed.');

    assert.equal(
      normalizeChatV2ProviderError(error, {
        provider: 'openai',
        modelId: 'gpt-5',
      }),
      error,
    );
  });

  it('keeps abort errors unchanged', () => {
    const error = new Error('Aborted.');
    error.name = 'AbortError';

    assert.equal(
      normalizeChatV2ProviderError(error, {
        provider: 'openai',
        modelId: 'gpt-5',
      }),
      error,
    );
  });
});

import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { createChatV2Model, resolveChatV2ProviderConfig } from '../../../src/model/chat-v2/providerOptions.js';

describe('resolveChatV2ProviderConfig', () => {
  it('derives OpenAI baseURL and merges global and resolved headers', async () => {
    const result = await resolveChatV2ProviderConfig(
      'openai',
      'gpt-5',
      {
        settings: {
          openAiEndpoint: 'https://example.test/v1/chat/completions',
          chatNodeHeaders: {
            'x-global': 'global',
          },
        },
        getPluginConfig: () => undefined,
        getChatNodeEndpoint: async (endpoint) => ({
          endpoint: endpoint.replace('example.test', 'proxy.test'),
          headers: {
            'x-proxy': 'proxy',
          },
        }),
      } as any,
      {
        headers: {
          'x-node': 'node',
        },
      },
    );

    assert.equal(result.baseURL, 'https://proxy.test/v1');
    assert.deepEqual(result.headers, {
      'x-global': 'global',
      'x-node': 'node',
      'x-proxy': 'proxy',
    });
  });
});

describe('createChatV2Model', () => {
  it('enables structured outputs on custom OpenAI-compatible chat models', async () => {
    const model = createChatV2Model(
      'custom',
      'gpt-oss-120b',
      {
        settings: {},
        getPluginConfig: () => undefined,
      } as any,
      {
        apiKey: 'test-key',
        baseURL: 'https://api.example.test/v1',
      },
    ) as { supportsStructuredOutputs?: boolean };

    assert.equal(model.supportsStructuredOutputs, true);

    const responseSchema = {
      type: 'object',
      properties: {
        answer: { type: 'string' },
      },
    };
    const { args, warnings } = await (
      model as unknown as {
        getArgs(options: unknown): Promise<{ args: { response_format?: unknown }; warnings: unknown[] }>;
      }
    ).getArgs({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Answer briefly.' }] }],
      responseFormat: {
        type: 'json',
        schema: responseSchema,
        name: 'answer_schema',
        description: 'Answer payload',
      },
    });

    assert.deepEqual(warnings, []);
    assert.deepEqual(args.response_format, {
      type: 'json_schema',
      json_schema: {
        schema: responseSchema,
        name: 'answer_schema',
        description: 'Answer payload',
      },
    });
  });

  it('does not request OpenAI stream usage options from custom-compatible providers', () => {
    const model = createChatV2Model(
      'custom',
      'gpt-oss-120b',
      {
        settings: {},
        getPluginConfig: () => undefined,
      } as any,
      {
        apiKey: 'test-key',
        baseURL: 'https://api.example.test/v1',
      },
    ) as { config?: { includeUsage?: boolean } };

    assert.equal(model.config?.includeUsage, false);
  });

  it('captures JSON provider request bodies without recording request headers', async () => {
    const capturedBodies: unknown[] = [];
    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    try {
      const model = createChatV2Model(
        'custom',
        'gpt-oss-120b',
        {
          settings: {},
          getPluginConfig: () => undefined,
        } as any,
        {
          apiKey: 'secret-key',
          baseURL: 'https://api.example.test/v1',
          onRequestBody: (body) => capturedBodies.push(body),
        },
      ) as { config?: { fetch?: typeof fetch } };
      const requestBody = {
        model: 'gpt-oss-120b',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      assert.ok(model.config?.fetch);
      await model.config.fetch('https://api.example.test/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-key',
        },
        body: JSON.stringify(requestBody),
      });

      assert.deepEqual(capturedBodies, [requestBody]);
      assert.equal(JSON.stringify(capturedBodies).includes('secret-key'), false);
      assert.equal(fetchMock.mock.callCount(), 1);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

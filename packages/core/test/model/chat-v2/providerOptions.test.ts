import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { createChatV2Model, resolveChatV2ProviderConfig } from '../../../src/model/chat-v2/providerOptions.js';
import { createChatV2ResponseBodyCapture } from '../../../src/model/chat-v2/chatV2ResponseBodyCapture.js';

describe('resolveChatV2ProviderConfig', () => {
  it('ignores legacy OpenAI endpoint overrides and keeps node/global headers', async () => {
    const result = await resolveChatV2ProviderConfig(
      'openai',
      'gpt-5',
      {
        settings: {
          openAiEndpoint: 'https://legacy-openai-compatible.example.test/v1/chat/completions?legacy=1',
          chatNodeHeaders: {
            'x-global': 'global',
          },
        },
        getPluginConfig: () => undefined,
      } as any,
      {
        headers: {
          'x-node': 'node',
        },
      },
    );

    assert.equal(result.baseURL, undefined);
    assert.deepEqual(result.headers, {
      'x-global': 'global',
      'x-node': 'node',
    });
  });

  it('ignores explicit OpenAI baseURL overrides from stale node settings', async () => {
    const result = await resolveChatV2ProviderConfig(
      'openai',
      'gpt-5',
      {
        settings: {
          openAiEndpoint: 'https://stale.example.test/v1/chat/completions',
          chatNodeHeaders: {},
        },
        getPluginConfig: () => undefined,
      } as any,
      {
        baseURL: 'https://proxy.example.test/v1/responses',
      },
    );

    assert.equal(result.baseURL, undefined);
  });

  it('ignores built-in Anthropic and Google baseURL overrides too', async () => {
    const context = {
      settings: {
        chatNodeHeaders: {},
      },
      getPluginConfig: (key: string) => (key === 'anthropicApiEndpoint' ? 'https://plugin-anthropic.example/v1' : ''),
    } as any;

    const anthropic = await resolveChatV2ProviderConfig('anthropic', 'claude-test', context, {
      baseURL: 'https://stale-anthropic.example/v1',
    });
    const google = await resolveChatV2ProviderConfig('google', 'gemini-test', context, {
      baseURL: 'https://stale-google.example/v1',
    });

    assert.equal(anthropic.baseURL, undefined);
    assert.equal(google.baseURL, undefined);
  });
});

describe('createChatV2Model', () => {
  it('keeps built-in provider models away from stale endpoint overrides', () => {
    const context = {
      settings: {},
      getPluginConfig: (key: string) => (key === 'anthropicApiEndpoint' ? 'https://plugin-anthropic.example/v1' : ''),
    } as any;
    const anthropic = createChatV2Model('anthropic', 'claude-test', context, {
      apiKey: 'test-key',
      baseURL: 'https://stale-anthropic.example/v1',
    }) as { config?: { baseURL?: string } };
    const google = createChatV2Model('google', 'gemini-test', context, {
      apiKey: 'test-key',
      baseURL: 'https://stale-google.example/v1',
    }) as { config?: { baseURL?: string } };

    assert.notEqual(anthropic.config?.baseURL, 'https://stale-anthropic.example/v1');
    assert.notEqual(anthropic.config?.baseURL, 'https://plugin-anthropic.example/v1');
    assert.notEqual(google.config?.baseURL, 'https://stale-google.example/v1');
  });

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

  it('forwards the raw OpenAI-compatible parallel tool-call request field', async () => {
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
    ) as {
      getArgs(options: unknown): Promise<{ args: { parallel_tool_calls?: unknown }; warnings: unknown[] }>;
    };

    const { args, warnings } = await model.getArgs({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use both tools.' }] }],
      providerOptions: {
        custom: {
          parallel_tool_calls: true,
        },
      },
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look up a value.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    assert.deepEqual(warnings, []);
    assert.equal(args.parallel_tool_calls, true);
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

  it('captures a cloned provider response body without consuming the SDK response', async () => {
    const responseBodyCapture = createChatV2ResponseBodyCapture();
    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response('{"id":"response-1","output":"Hello secret-key"}', {
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
          onResponseBody: (response) => responseBodyCapture.capture(response),
        },
      ) as { config?: { fetch?: typeof fetch } };

      assert.ok(model.config?.fetch);
      const response = await model.config.fetch('https://api.example.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-oss-120b' }),
      });
      await responseBodyCapture.flush();

      assert.deepEqual(responseBodyCapture.bodies, [{ id: 'response-1', output: 'Hello secret-key' }]);
      assert.equal(await response.text(), '{"id":"response-1","output":"Hello secret-key"}');
      assert.equal(fetchMock.mock.callCount(), 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it('retains complete provider response bodies for workflow debugging', async () => {
    const responseBodyCapture = createChatV2ResponseBodyCapture();
    responseBodyCapture.capture(new Response('{"error":{"message":"Key secret-key was rejected"}}'));
    await responseBodyCapture.flush();

    assert.deepEqual(responseBodyCapture.bodies, [{ error: { message: 'Key secret-key was rejected' } }]);
  });

  it('sends and captures transformed provider request bodies', async () => {
    const capturedBodies: unknown[] = [];
    let sentBody: unknown;
    let sentHeaders: Headers | undefined;
    const fetchMock = mock.method(globalThis, 'fetch', async (_input, init) => {
      sentBody = JSON.parse(String(init?.body));
      sentHeaders = new Headers(init?.headers);
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

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
          transformRequestBody: (body) => ({
            ...(body as Record<string, unknown>),
            transformed: true,
          }),
        },
      ) as { config?: { fetch?: typeof fetch } };
      const requestBody = {
        model: 'gpt-oss-120b',
        messages: [{ role: 'system', content: 'Hello' }],
      };

      assert.ok(model.config?.fetch);
      await model.config.fetch('https://api.example.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-length': '1', 'x-test': 'preserved' },
        body: JSON.stringify(requestBody),
      });

      const expected = { ...requestBody, transformed: true };
      assert.deepEqual(capturedBodies, [expected]);
      assert.deepEqual(sentBody, expected);
      assert.equal(sentHeaders?.has('content-length'), false);
      assert.equal(sentHeaders?.get('x-test'), 'preserved');
    } finally {
      fetchMock.mock.restore();
    }
  });
});

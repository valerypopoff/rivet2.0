import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  createChatV2Model,
  normalizeOpenAICompatibleEndpoint,
  parseCustomProviderApi,
  resolveChatV2ProviderConfig,
} from '../../../src/model/chat-v2/providerOptions.js';
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

  it('normalizes Custom full endpoints structurally and preserves ordered query values', async () => {
    assert.deepEqual(
      normalizeOpenAICompatibleEndpoint(
        'https://api.example.test/v1/responses///?api-version=2026-08-01&route=first&route=second#ignored',
      ),
      {
        baseURL: 'https://api.example.test/v1',
        endpointQuery: [
          ['api-version', '2026-08-01'],
          ['route', 'first'],
          ['route', 'second'],
        ],
      },
    );
    assert.deepEqual(normalizeOpenAICompatibleEndpoint('http://localhost:11434/v1/chat/completions/'), {
      baseURL: 'http://localhost:11434/v1',
      endpointQuery: [],
    });
    assert.deepEqual(normalizeOpenAICompatibleEndpoint('https://api.example.test///'), {
      baseURL: 'https://api.example.test',
      endpointQuery: [],
    });

    await assert.rejects(
      () =>
        resolveChatV2ProviderConfig('custom', 'model', { settings: {}, getPluginConfig: () => undefined } as any, {
          baseURL: 'not a URL',
        }),
      /valid absolute HTTP or HTTPS URL/,
    );
    await assert.rejects(
      () =>
        resolveChatV2ProviderConfig('custom', 'model', { settings: {}, getPluginConfig: () => undefined } as any, {
          baseURL: 'ftp://api.example.test/v1',
        }),
      /must use HTTP or HTTPS/,
    );
  });
});

describe('parseCustomProviderApi', () => {
  it('defaults missing legacy values to Completions and rejects corrupt values', () => {
    assert.equal(parseCustomProviderApi(undefined), 'completions');
    assert.equal(parseCustomProviderApi('completions'), 'completions');
    assert.equal(parseCustomProviderApi('responses'), 'responses');
    assert.throws(() => parseCustomProviderApi('response'), /Unsupported Custom provider API: response/);
  });
});

describe('createChatV2Model', () => {
  it('applies configured endpoint queries after either Custom adapter appends its path', async () => {
    const requestedURLs: string[] = [];
    const fetchMock = mock.method(globalThis, 'fetch', async (input) => {
      requestedURLs.push(String(input));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    try {
      const context = { settings: {}, getPluginConfig: () => undefined } as any;
      for (const customProviderApi of ['completions', 'responses'] as const) {
        const endpointPath = customProviderApi === 'responses' ? 'responses' : 'chat/completions';
        const config = await resolveChatV2ProviderConfig('custom', 'model', context, {
          baseURL: `https://api.example.test/v1/${endpointPath}?api-version=2026&route=first&route=second`,
        });
        const model = createChatV2Model('custom', 'model', context, {
          ...config,
          customProviderApi,
        }) as {
          config?: {
            fetch?: typeof fetch;
            url?: (options: { path: string; modelId: string }) => string;
          };
        };
        const requestPath = customProviderApi === 'responses' ? '/responses' : '/chat/completions';
        const generatedURL =
          model.config?.url?.({ path: requestPath, modelId: 'model' }) ?? `https://api.example.test/v1${requestPath}`;
        await model.config?.fetch?.(`${generatedURL}?route=adapter&sdk=kept`, { method: 'POST', body: '{}' });
      }

      assert.deepEqual(requestedURLs, [
        'https://api.example.test/v1/chat/completions?sdk=kept&api-version=2026&route=first&route=second',
        'https://api.example.test/v1/responses?sdk=kept&api-version=2026&route=first&route=second',
      ]);
    } finally {
      fetchMock.mock.restore();
    }
  });

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

  it('uses the OpenAI Responses adapter for opt-in Custom provider Responses mode', async () => {
    const model = createChatV2Model(
      'custom',
      'responses-compatible-model',
      {
        settings: { openAiApiKey: 'must-not-leak-to-custom' },
        getPluginConfig: () => undefined,
      } as any,
      {
        apiKey: 'custom-key',
        baseURL: 'https://api.example.test/v1',
        customProviderApi: 'responses',
      },
    ) as {
      provider?: string;
      config?: { url?: (options: { path: string; modelId: string }) => string };
      getArgs(options: unknown): Promise<{
        args: { input?: unknown; text?: unknown; store?: unknown };
        warnings: unknown[];
      }>;
    };

    assert.equal(model.provider, 'custom.responses');
    assert.equal(
      model.config?.url?.({ path: '/responses', modelId: 'responses-compatible-model' }),
      'https://api.example.test/v1/responses',
    );

    const { args } = await model.getArgs({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Return JSON.' }] }],
      providerOptions: { openai: { store: false } },
      responseFormat: {
        type: 'json',
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
        name: 'answer_schema',
      },
    });

    assert.ok(Array.isArray(args.input));
    assert.equal(args.store, false);
    assert.deepEqual(args.text, {
      format: {
        type: 'json_schema',
        strict: true,
        name: 'answer_schema',
        description: undefined,
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
      },
    });
  });

  it('sends and parses an opt-in Custom Responses request through the configured endpoint and credential', async () => {
    let requestedUrl: string | undefined;
    let requestedHeaders: Headers | undefined;
    let requestedBody: Record<string, unknown> | undefined;
    const fetchMock = mock.method(globalThis, 'fetch', async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'resp_custom_contract',
          created_at: 1_700_000_000,
          model: 'responses-compatible-model',
          output: [
            {
              type: 'message',
              role: 'assistant',
              id: 'msg_custom_contract',
              content: [{ type: 'output_text', text: 'Custom Responses works.', annotations: [] }],
            },
          ],
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    try {
      const model = createChatV2Model(
        'custom',
        'responses-compatible-model',
        {
          settings: { openAiApiKey: 'must-not-leak-to-custom' },
          getPluginConfig: () => undefined,
        } as any,
        {
          apiKey: 'custom-responses-key',
          baseURL: 'https://api.example.test/v1',
          customProviderApi: 'responses',
        },
      ) as {
        doGenerate(options: unknown): Promise<{ content: Array<{ type: string; text?: string }> }>;
      };

      const result = await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Test the endpoint.' }] }],
      });

      assert.equal(requestedUrl, 'https://api.example.test/v1/responses');
      assert.equal(requestedHeaders?.get('authorization'), 'Bearer custom-responses-key');
      assert.equal(requestedBody?.model, 'responses-compatible-model');
      assert.ok(Array.isArray(requestedBody?.input));
      assert.equal(result.content.find((part) => part.type === 'text')?.text, 'Custom Responses works.');
      assert.equal(fetchMock.mock.callCount(), 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it('streams partial and final text through the Custom Responses adapter', async () => {
    let requestedUrl: string | undefined;
    let requestedBody: Record<string, unknown> | undefined;
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_stream', created_at: 1_700_000_000, model: 'responses-compatible-model' },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg_stream' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_stream',
        delta: 'Hello',
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_stream',
        delta: ' world',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id: 'msg_stream' },
      },
      {
        type: 'response.completed',
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 3,
            input_tokens_details: { cached_tokens: 1 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ];
    const fetchMock = mock.method(globalThis, 'fetch', async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    try {
      const model = createChatV2Model(
        'custom',
        'responses-compatible-model',
        { settings: {}, getPluginConfig: () => undefined } as any,
        {
          apiKey: 'custom-key',
          baseURL: 'https://api.example.test/v1',
          endpointQuery: [['api-version', '2026-08-01']],
          customProviderApi: 'responses',
        },
      ) as {
        doStream(options: unknown): Promise<{ stream: ReadableStream<Record<string, unknown>> }>;
      };
      const result = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Stream.' }] }],
      });
      const chunks: Array<Record<string, unknown>> = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }

      assert.equal(requestedUrl, 'https://api.example.test/v1/responses?api-version=2026-08-01');
      assert.equal(requestedBody?.stream, true);
      assert.deepEqual(
        chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta),
        ['Hello', ' world'],
      );
      assert.ok(chunks.some((chunk) => chunk.type === 'text-start' && chunk.id === 'msg_stream'));
      assert.ok(chunks.some((chunk) => chunk.type === 'text-end' && chunk.id === 'msg_stream'));
      assert.ok(chunks.some((chunk) => chunk.type === 'finish'));
    } finally {
      fetchMock.mock.restore();
    }
  });

  it('parses function calls from a Custom Responses response', async () => {
    let requestedBody: Record<string, unknown> | undefined;
    const fetchMock = mock.method(globalThis, 'fetch', async (_input, init) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'resp_tool',
          created_at: 1_700_000_000,
          model: 'responses-compatible-model',
          output: [
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'lookup_weather',
              arguments: '{"city":"Paris"}',
            },
          ],
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    try {
      const model = createChatV2Model(
        'custom',
        'responses-compatible-model',
        { settings: {}, getPluginConfig: () => undefined } as any,
        {
          apiKey: 'custom-key',
          baseURL: 'https://api.example.test/v1',
          customProviderApi: 'responses',
        },
      ) as {
        doGenerate(options: unknown): Promise<{ content: Array<Record<string, unknown>>; finishReason: string }>;
      };
      const result = await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Check Paris.' }] }],
        tools: [
          {
            type: 'function',
            name: 'lookup_weather',
            description: 'Look up weather.',
            inputSchema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      });

      assert.ok(Array.isArray(requestedBody?.tools));
      assert.deepEqual(
        result.content.find((part) => part.type === 'tool-call'),
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'lookup_weather',
          input: '{"city":"Paris"}',
          providerMetadata: { openai: { itemId: 'fc_1' } },
        },
      );
      assert.equal(result.finishReason.unified, 'tool-calls');
    } finally {
      fetchMock.mock.restore();
    }
  });

  it('omits only the adapter-generated empty bearer header for keyless Custom Responses endpoints', async () => {
    const authorizationHeaders: Array<string | null> = [];
    const fetchMock = mock.method(globalThis, 'fetch', async (_input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('authorization'));
      return new Response(
        JSON.stringify({
          id: 'resp_keyless_custom_contract',
          created_at: 1_700_000_000,
          model: 'responses-compatible-model',
          output: [
            {
              type: 'message',
              role: 'assistant',
              id: 'msg_keyless_custom_contract',
              content: [{ type: 'output_text', text: 'OK', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    try {
      const context = {
        settings: { openAiApiKey: 'must-not-leak-to-custom' },
        getPluginConfig: () => undefined,
      } as any;
      const keylessModel = createChatV2Model('custom', 'responses-compatible-model', context, {
        baseURL: 'https://api.example.test/v1',
        customProviderApi: 'responses',
      }) as { doGenerate(options: unknown): Promise<unknown> };
      const headerAuthenticatedModel = createChatV2Model('custom', 'responses-compatible-model', context, {
        baseURL: 'https://api.example.test/v1',
        customProviderApi: 'responses',
        headers: { Authorization: 'Token custom-header-key' },
      }) as { doGenerate(options: unknown): Promise<unknown> };
      const request = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Test authentication.' }] }],
      };

      await keylessModel.doGenerate(request);
      await headerAuthenticatedModel.doGenerate(request);

      assert.deepEqual(authorizationHeaders, [null, 'Token custom-header-key']);
      assert.equal(fetchMock.mock.callCount(), 2);
    } finally {
      fetchMock.mock.restore();
    }
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

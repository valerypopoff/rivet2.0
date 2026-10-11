import assert from 'node:assert/strict';
import { afterEach, mock, it } from 'node:test';
import { LLMChatV2NodeImpl } from '../../../src/model/nodes/LLMChatV2Node.js';
import { LLMProfileNodeImpl } from '../../../src/model/nodes/LLMProfileNode.js';
import { resolveLLMChatV2RuntimeConfig } from '../../../src/model/chat-v2/llmChatV2NodeRuntime.js';
import { runChatV2PipelineWithToolContinuation } from '../../../src/model/chat-v2/toolContinuation.js';
import { resolveChatV2Credential } from '../../../src/model/chat-v2/chatV2ProviderProfile.js';
import {
  createRivetLLMProfileHealthIdentity,
  InMemoryRivetLLMProfileHealthStore,
} from '../../../src/model/chat-v2/llmProfileHealthStore.js';
import { chatMessagesToModelMessages } from '../../../src/model/chat-v2/messageConverter.js';
import { getChatV2ProviderErrorStatusCode } from '../../../src/model/chat-v2/chatV2Errors.js';
import { isUnhealthyLLMProfileProviderFailure } from '../../../src/model/chat-v2/llmProfileFallback.js';
import type { LLMChatV2NodeData } from '../../../src/model/chat-v2/llmChatV2NodeData.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';
import type { Inputs } from '../../../src/model/GraphProcessor.js';
import type { Project } from '../../../src/model/Project.js';
import { testProcessContext } from '../../testUtils.js';

afterEach(() => mock.restoreAll());

function node(data: Partial<LLMChatV2NodeData> = {}) {
  const base = LLMChatV2NodeImpl.create();
  return { ...base, data: { ...base.data, provider: 'openrouter' as const, model: 'test/model', ...data } };
}

function context(extra: Record<string, unknown> = {}): InternalProcessContext {
  return {
    settings: { openRouterApiKey: 'router-secret', chatNodeHeaders: { 'x-global': 'global' } },
    getPluginConfig: () => '',
    signal: new AbortController().signal,
    node: node(),
    processId: 'router-process',
    trace: () => {},
    ...extra,
  } as unknown as InternalProcessContext;
}

async function runtime(data: Partial<LLMChatV2NodeData> = {}, inputs: Inputs = {}, ctx = context()) {
  const chartNode = node(data);
  const result = await resolveLLMChatV2RuntimeConfig({
    data: chartNode.data,
    nodeId: chartNode.id,
    inputs: { prompt: { type: 'string', value: 'Hello' }, ...inputs },
    context: ctx,
  });
  result.runOptions.emitPartialOutputs = false;
  return result;
}

function response(message: Record<string, unknown> = { role: 'assistant', content: 'Hello back' }, finish = 'stop') {
  return {
    id: 'router-response',
    object: 'chat.completion',
    created: 1,
    model: 'test/model',
    provider: 'Test',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 6,
      total_tokens: 16,
      cost: 0.004,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  };
}

function sseResponse(chunks: Record<string, unknown>[]) {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify({ id: 'stream-1', model: 'test/model', ...chunk })}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function mockRequests(reply: (body: Record<string, any>, index: number) => Response = () => Response.json(response())) {
  const requests: { body: Record<string, any>; headers: Headers; url: string }[] = [];
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers), url: String(input) };
    requests.push(request);
    return reply(request.body, requests.length - 1);
  });
  return requests;
}

void it('OpenRouter sends every shared generation setting, reasoning, headers and exact diagnostics', async () => {
  const requests = mockRequests();
  const calls: unknown[] = [];
  const configured = await runtime(
    {
      temperature: 0.3,
      topP: 0.8,
      topK: 4,
      maxTokens: 90,
      presencePenalty: 0.2,
      frequencyPenalty: 0.4,
      seed: 12,
      stopSequences: ['END'],
      openRouterReasoningEffort: 'low',
      headers: [{ key: 'HTTP-Referer', value: 'https://rivet.test' }],
      outputUsage: true,
      outputReasoning: true,
      outputRequestBody: true,
      outputResponseBody: true,
      customProviderBaseURL: 'https://must-not-receive-key.test',
      openAIReasoningEffort: 'high',
      enableOpenAIWebSearch: true,
      enableGoogleSearchGrounding: true,
    },
    {},
    context({ onChatV2CallFinished: (call: unknown) => calls.push(call) }),
  );
  const result = await configured.runPipeline(configured.runOptions);
  const sent = requests[0]!;
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.headers.get('authorization'), 'Bearer router-secret');
  assert.equal(sent.headers.get('http-referer'), 'https://rivet.test');
  assert.equal(sent.headers.get('x-global'), 'global');
  for (const [key, value] of Object.entries({
    temperature: 0.3,
    top_p: 0.8,
    top_k: 4,
    max_tokens: 90,
    presence_penalty: 0.2,
    frequency_penalty: 0.4,
    seed: 12,
    stop: ['END'],
    reasoning: { effort: 'low' },
    provider: { require_parameters: true },
    usage: { include: true },
  })) {
    assert.deepEqual(sent.body[key], value, key);
  }
  assert.equal(sent.body.tools, undefined);
  assert.equal(result.response, 'Hello back');
  assert.deepEqual(result.commonOutputs.requestBody?.value, sent.body);
  assert.deepEqual(result.commonOutputs.responseBody?.value, response());
  assert.equal(result.usage?.totalCost, 0.004);
  assert.equal(result.usage?.cachedTokens, 2);
  assert.equal(result.usage?.reasoningTokens, 3);
  assert.equal((calls[0] as any).pricing.costUsd, 0.004);
  assert.doesNotMatch(JSON.stringify(calls), /router-secret/);
});

void it('OpenRouter input overrides and profiles use the same configuration path', async () => {
  const requests = mockRequests();
  const base = LLMProfileNodeImpl.create();
  const profile = new LLMProfileNodeImpl({
    ...base,
    data: {
      ...base.data,
      provider: 'openrouter',
      model: 'stale/model',
      apiKeySource: 'input',
      useModelInput: true,
      useTemperatureInput: true,
      useMaxTokensInput: true,
      useTopPInput: true,
      useTopKInput: true,
      usePresencePenaltyInput: true,
      useFrequencyPenaltyInput: true,
      useStopSequencesInput: true,
      useSeedInput: true,
      useHeadersInput: true,
      useExtraProviderOptionsInput: true,
      openRouterReasoningEffort: 'medium',
    },
  });
  const outputs = await profile.process(
    {
      apiKey: { type: 'string', value: 'input-secret' },
      model: { type: 'string', value: 'input/model' },
      temperature: { type: 'number', value: 0.7 },
      maxTokens: { type: 'number', value: 44 },
      topP: { type: 'number', value: 0.9 },
      topK: { type: 'number', value: 5 },
      presencePenalty: { type: 'number', value: 0.5 },
      frequencyPenalty: { type: 'number', value: 0.6 },
      stopSequences: { type: 'string[]', value: ['HALT'] },
      seed: { type: 'number', value: 42 },
      headers: { type: 'object', value: { 'x-node': 'input-header' } },
      extraProviderOptions: {
        type: 'object',
        value: { temperature: 0.1, provider: { order: ['Test'], require_parameters: true } },
      },
    } as Inputs,
    context(),
  );
  const configured = await runtime({ configurationMode: 'profile', provider: 'openai' }, {
    llmProfile: outputs.profile!,
  } as Inputs);
  const result = await configured.runPipeline(configured.runOptions);
  assert.equal(result.response, 'Hello back');
  const sent = requests[0]!;
  assert.equal(sent.headers.get('authorization'), 'Bearer input-secret');
  assert.equal(sent.headers.get('x-node'), 'input-header');
  assert.equal(sent.body.model, 'input/model');
  assert.equal(sent.body.temperature, 0.1, 'raw extra options have final precedence');
  assert.deepEqual(
    [
      sent.body.max_tokens,
      sent.body.top_p,
      sent.body.top_k,
      sent.body.presence_penalty,
      sent.body.frequency_penalty,
      sent.body.stop,
      sent.body.seed,
    ],
    [44, 0.9, 5, 0.5, 0.6, ['HALT'], 42],
  );
  assert.deepEqual(sent.body.reasoning, { effort: 'medium' });
});

void it('OpenRouter structured output sends native JSON schema and validates the response', async () => {
  const requests = mockRequests(() => Response.json(response({ role: 'assistant', content: '{"ok":true}' })));
  const configured = await runtime(
    { responseFormat: 'json_schema', responseSchemaName: 'Answer', responseSchemaDescription: 'Result' },
    {
      responseSchema: {
        type: 'object',
        value: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    } as Inputs,
  );
  const result = await configured.runPipeline(configured.runOptions);
  assert.equal(requests[0]!.body.response_format.type, 'json_schema');
  assert.equal(requests[0]!.body.response_format.json_schema.name, 'Answer');
  assert.equal(requests[0]!.body.response_format.json_schema.description, 'Result');
  assert.equal(requests[0]!.body.response_format.json_schema.strict, true);
  assert.deepEqual(result.commonOutputs.response?.value, { ok: true });
});

void it('OpenRouter rejected structured responses retain the reported physical-call cost', async () => {
  mockRequests(() => Response.json(response({ role: 'assistant', content: 'not JSON' })));
  const calls: any[] = [];
  const configured = await runtime(
    { responseFormat: 'json_schema' },
    { responseSchema: { type: 'object', value: { type: 'object' } } } as Inputs,
    context({ onChatV2CallFinished: (call: unknown) => calls.push(call) }),
  );
  await assert.rejects(() => configured.runPipeline(configured.runOptions), /response validation failed/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pricing.costUsd, 0.004);
});

for (const mode of ['generate', 'stream'] as const) {
  void it(`OpenRouter ${mode} tools preserve encrypted reasoning through native continuation and message re-entry`, async () => {
    const details = [
      { type: 'reasoning.encrypted', data: 'opaque-proof', id: 'reason-1', format: 'openai-responses-v1', index: 0 },
    ];
    const requests = mockRequests((_body, index) => {
      const reply =
        index === 0
          ? response(
              {
                role: 'assistant',
                content: '',
                reasoning_details: details,
                tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }],
              },
              'tool_calls',
            )
          : response();
      if (mode === 'generate') return Response.json(reply);
      const { tool_calls, ...message } = reply.choices[0]!.message;
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                ...message,
                ...(tool_calls
                  ? { tool_calls: (tool_calls as Record<string, unknown>[]).map((call, i) => ({ ...call, index: i })) }
                  : {}),
              },
              finish_reason: reply.choices[0]!.finish_reason,
            },
          ],
        },
        { choices: [], usage: reply.usage },
      ]);
    });
    const configured = await runtime(
      { useToolCalling: true, parallelToolCalls: true, toolChoice: 'function', toolChoiceFunction: 'lookup' },
      {
        functions: {
          type: 'gpt-function[]',
          value: [
            {
              name: 'lookup',
              description: 'Look up',
              parameters: {
                type: 'object',
                properties: { id: { type: 'number' } },
                required: ['id'],
              },
            },
          ],
        },
      } as Inputs,
    );
    const result = await runChatV2PipelineWithToolContinuation({
      ...configured.runOptions,
      emitPartialOutputs: mode === 'stream',
      autoContinue: true,
      maxToolRounds: 2,
      functions: configured.functions,
      runPipeline: configured.runPipeline,
      delegateToolCall: async () => ({
        type: 'chat-message',
        value: {
          type: 'function',
          name: 'call-1',
          toolName: 'lookup',
          message: 'Found',
        },
      }),
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]!.body.tool_choice, { type: 'function', function: { name: 'lookup' } });
    assert.equal(requests[0]!.body.parallel_tool_calls, true);
    assert.equal(requests[0]!.body.tools[0].function.name, 'lookup');
    assert.deepEqual(
      requests[1]!.body.messages.find((message: any) => message.role === 'assistant').reasoning_details,
      details,
    );
    assert.equal(requests[1]!.body.messages.at(-1).role, 'tool');
    assert.equal(result.response, 'Hello back');
    assert.equal(result.usage?.totalCost, 0.008);
    const assistant = result.allMessages.find((message) => message.type === 'assistant');
    assert.deepEqual(assistant?.type === 'assistant' && assistant.openRouterReasoningDetails, details);
  });
}

void it('OpenRouter streaming preserves text, reasoning, detailed usage and reported cost', async () => {
  mockRequests(() => {
    return sseResponse([
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'Thinking' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'Hello back' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: response().usage },
    ]);
  });
  const configured = await runtime({ outputUsage: true, outputReasoning: true });
  const result = await configured.runPipeline({ ...configured.runOptions, emitPartialOutputs: true });
  assert.equal(result.response, 'Hello back');
  assert.equal(result.commonOutputs.reasoning?.value, 'Thinking');
  assert.equal(result.usage?.totalCost, 0.004);
  assert.equal(result.usage?.reasoningTokens, 3);
});

void it('OpenRouter streamed outage errors retain status and retry without accepting partial text', async () => {
  const requests = mockRequests((_body, index) =>
    sseResponse(
      index === 0
        ? [
            { choices: [{ index: 0, delta: { content: 'Incomplete' }, finish_reason: null }] },
            { error: { code: 503, message: 'upstream unavailable' } },
          ]
        : [
            {
              choices: [{ index: 0, delta: { content: 'Recovered' }, finish_reason: 'stop' }],
              usage: response().usage,
            },
          ],
    ),
  );
  const configured = await runtime({
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
    retryOnNon200CooldownMs: 1,
  });
  const result = await configured.runPipeline({ ...configured.runOptions, emitPartialOutputs: true });
  assert.equal(requests.length, 2);
  assert.equal(result.response, 'Recovered');
});

void it('OpenRouter non-streamed HTTP 200 errors retain the embedded outage status for retry', async () => {
  const requests = mockRequests((_body, index) =>
    index === 0 ? Response.json({ error: { code: 503, message: 'upstream unavailable' } }) : Response.json(response()),
  );
  const configured = await runtime({
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
    retryOnNon200CooldownMs: 1,
  });
  const result = await configured.runPipeline(configured.runOptions);
  assert.equal(requests.length, 2);
  assert.equal(result.response, 'Hello back');
});

for (const delta of [
  { content: 'Incomplete' },
  { tool_calls: [{ index: 0, id: 'partial-tool', type: 'function', function: { name: 'lookup', arguments: '{' } }] },
]) {
  void it(`OpenRouter rejects premature stream closure with ${'content' in delta ? 'text' : 'tool arguments'}`, async () => {
    mockRequests(
      () =>
        new Response(
          `data: ${JSON.stringify({ id: 'truncated', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    let delegated = 0;
    const configured = await runtime({ useToolCalling: true }, {
      functions: {
        type: 'gpt-function[]',
        value: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} } }],
      },
    } as Inputs);
    await assert.rejects(
      () =>
        runChatV2PipelineWithToolContinuation({
          ...configured.runOptions,
          emitPartialOutputs: true,
          autoContinue: true,
          maxToolRounds: 2,
          functions: configured.functions,
          runPipeline: configured.runPipeline,
          delegateToolCall: async () => {
            delegated++;
            throw new Error('Incomplete tool calls must never execute');
          },
        }),
      (error: unknown) => {
        assert.match((error as Error).message, /stream ended before.*finish reason/i);
        assert.equal(getChatV2ProviderErrorStatusCode(error), undefined);
        assert.equal(isUnhealthyLLMProfileProviderFailure(error), true);
        return true;
      },
    );
    assert.equal(delegated, 0);
  });
}

void it('OpenRouter rejects an explicit error finish reason without an error payload', async () => {
  mockRequests(() =>
    sseResponse([{ choices: [{ index: 0, delta: { content: 'Incomplete' }, finish_reason: 'error' }] }]),
  );
  const configured = await runtime();
  await assert.rejects(
    () => configured.runPipeline({ ...configured.runOptions, emitPartialOutputs: true }),
    /OpenRouter reported an unsuccessful stream/,
  );
});

for (const finish of ['stop', 'length', 'content_filter', 'provider_specific_reason']) {
  void it(`OpenRouter accepts an explicitly completed ${finish} stream`, async () => {
    mockRequests(() =>
      sseResponse([{ choices: [{ index: 0, delta: { content: 'Complete' }, finish_reason: finish }] }]),
    );
    const configured = await runtime();
    const result = await configured.runPipeline({ ...configured.runOptions, emitPartialOutputs: true });
    assert.equal(result.response, 'Complete');
  });
}

for (const [code, expectedStatus, unhealthy] of [
  [401, 401, false],
  ['429', 429, true],
  [503, 503, true],
  ['invalid_parameter', undefined, false],
] as const) {
  void it(`OpenRouter streamed error ${code} preserves diagnostics and correct suspension classification`, async () => {
    mockRequests(() => sseResponse([{ error: { code, message: 'Provider-specific failure' } }]));
    const configured = await runtime();
    await assert.rejects(
      () => configured.runPipeline({ ...configured.runOptions, emitPartialOutputs: true }),
      (error: unknown) => {
        assert.match((error as Error).message, /Provider-specific failure/);
        assert.equal(getChatV2ProviderErrorStatusCode(error), expectedStatus);
        assert.equal(isUnhealthyLLMProfileProviderFailure(error), unhealthy);
        return true;
      },
    );
  });

  void it(`OpenRouter non-streamed embedded error ${code} preserves status and suspension classification`, async () => {
    mockRequests(() => Response.json({ error: { code, message: 'Provider-specific failure' } }));
    const configured = await runtime();
    await assert.rejects(
      () => configured.runPipeline(configured.runOptions),
      (error: unknown) => {
        assert.match((error as Error).message, /Provider-specific failure/);
        assert.equal(getChatV2ProviderErrorStatusCode(error), expectedStatus ?? 200);
        assert.equal(isUnhealthyLLMProfileProviderFailure(error), unhealthy);
        return true;
      },
    );
  });
}

void it('OpenRouter cancellation during a live stream aborts transport and never retries or reports success', async () => {
  const controller = new AbortController();
  const reason = new Error('Stopped by user');
  let requests = 0;
  let transportAborted = false;
  const calls: any[] = [];
  mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ id: 'live', choices: [{ index: 0, delta: { content: 'Partial' }, finish_reason: null }] })}\n\n`,
            ),
          );
          init?.signal?.addEventListener(
            'abort',
            () => {
              transportAborted = true;
              stream.error(reason);
            },
            { once: true },
          );
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const configured = await runtime(
    {
      retryOnNon200: true,
      retryOnNon200RepeatTimes: 2,
    },
    {},
    context({
      signal: controller.signal,
      onPartialOutputs: () => controller.abort(reason),
      onChatV2CallFinished: (call: unknown) => calls.push(call),
    }),
  );
  await assert.rejects(
    () => configured.runPipeline({ ...configured.runOptions, emitPartialOutputs: true }),
    /Stopped by user/,
  );
  assert.equal(transportAborted, true);
  assert.equal(requests, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].outcome, 'aborted');
});

void it('OpenRouter credentials are isolated and alternative names are respected', () => {
  const ctx = context({ settings: { openAiApiKey: 'not-router', customAiApiKey: 'not-router' } });
  assert.throws(() => resolveChatV2Credential({ provider: 'openrouter', context: ctx }), /OPENROUTER_API_KEY/);
  const configured = resolveChatV2Credential({
    provider: 'openrouter',
    context: context({
      settings: { pluginEnv: { ROUTER_TEAM_KEY: 'team-secret' } },
    }),
    providerApiKeyNames: {
      openrouter: { programmaticName: 'teamRouterKey', environmentVariableName: 'ROUTER_TEAM_KEY' },
    },
  });
  assert.equal(configured.value, 'team-secret');
});

void it('OpenRouter preserves developer roles, cache breakpoints and multimodal evidence', async () => {
  const requests = mockRequests();
  const configured = await runtime({}, {
    prompt: {
      type: 'chat-message[]',
      value: [
        { type: 'developer', message: 'Be precise', isCacheBreakpoint: true },
        { type: 'user', message: ['Inspect', { type: 'url', url: 'https://image.test/a.png' }] },
      ],
    },
  } as Inputs);
  await configured.runPipeline(configured.runOptions);
  assert.equal(requests[0]!.body.messages[0].role, 'developer');
  assert.deepEqual(requests[0]!.body.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(requests[0]!.body.messages[1].content[1].image_url.url, 'https://image.test/a.png');
  const otherProvider = await chatMessagesToModelMessages(
    [
      {
        type: 'assistant',
        message: 'Hello',
        function_call: undefined,
        function_calls: undefined,
        openRouterReasoningDetails: [{ data: 'opaque' }],
      },
    ],
    { provider: 'openai' },
  );
  assert.equal(otherProvider[0]?.providerOptions, undefined, 'OpenRouter continuity never leaks to other providers');
});

void it('OpenRouter retries retain configured parameters; absent pricing stays unknown', async () => {
  const requests = mockRequests((_body, index) =>
    index === 0
      ? Response.json({ error: { message: 'busy', code: 503 } }, { status: 503 })
      : Response.json({ ...response(), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  );
  const configured = await runtime({
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
    retryOnNon200CooldownMs: 1,
    outputUsage: true,
  });
  const result = await configured.runPipeline(configured.runOptions);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.body, requests[0]!.body);
  assert.equal(result.usage?.totalCost, undefined);
});

void it('OpenRouter health identity distinguishes routing, not generation edits, and exposes no secret', () => {
  const configuration = new LLMProfileNodeImpl({ ...LLMProfileNodeImpl.create(), data: node().data }).data;
  const credential = { value: 'router-secret', reference: { source: 'settings' as const } };
  const identity = (extraProviderOptions: string) =>
    createRivetLLMProfileHealthIdentity({ configuration: { ...configuration, extraProviderOptions }, credential });
  const first = identity('{"provider":{"order":["A"]},"temperature":0.1}');
  assert.equal(first.key, identity('{"temperature":0.9,"provider":{"order":["A"]}}').key);
  assert.equal(identity('').key, identity('{"temperature":0.1}').key);
  assert.notEqual(first.key, identity('{"provider":{"order":["B"]}}').key);
  assert.doesNotMatch(JSON.stringify(first), /router-secret|order/);
});

void it('OpenRouter JSON object output, caught failures and cancellation follow node semantics', async () => {
  const requests = mockRequests(() => Response.json(response({ role: 'assistant', content: '{"ok":true}' })));
  const chat = new LLMChatV2NodeImpl(node({ responseFormat: 'json' }));
  const outputs = await chat.process({ prompt: { type: 'string', value: 'JSON please' } } as Inputs, context());
  assert.equal(requests[0]!.body.response_format.type, 'json_object');
  assert.deepEqual(outputs.response?.value, { ok: true });
  mock.restoreAll();
  mockRequests(() => Response.json({ error: { code: 503, message: 'busy' } }, { status: 503 }));
  const failing = new LLMChatV2NodeImpl(node({ catchRequestFailed: true, outputLLMAttempts: true }));
  const failed = await failing.process({ prompt: { type: 'string', value: 'Hello' } } as Inputs, context());
  assert.equal(failed.runFailed?.value, true);
  assert.ok(failed.llmAttempts?.value);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => failing.process({}, context({ signal: controller.signal })), { name: 'AbortError' });
});

for (const mode of ['generate', 'stream'] as const) {
  void it(`OpenRouter ${mode} Profile → Array → Chat executes a real graph with fallback and shared suspension`, async () => {
    const { GraphProcessor, globalRivetNodeRegistry, ArrayNodeImpl, TextNodeImpl, GraphOutputNodeImpl } = await import(
      '../../../src/index.js'
    );
    const requests = mockRequests((body) => {
      if (mode === 'stream') {
        return sseResponse(
          body.model === 'test/unavailable'
            ? [{ error: { message: 'busy', code: 503 } }]
            : [
                {
                  choices: [{ index: 0, delta: { content: 'Hello back' }, finish_reason: 'stop' }],
                  usage: response().usage,
                },
              ],
        );
      }
      return body.model === 'test/unavailable'
        ? Response.json({ error: { message: 'busy', code: 503 } }, { status: 503 })
        : Response.json(response());
    });
    const primary = LLMProfileNodeImpl.create();
    primary.data = {
      ...primary.data,
      provider: 'openrouter',
      model: 'test/unavailable',
      enableCircuitBreaker: true,
      circuitBreakerFailureThreshold: 1,
    };
    const backup = LLMProfileNodeImpl.create();
    backup.data = { ...backup.data, provider: 'openrouter', model: 'test/model' };
    const profiles = ArrayNodeImpl.create();
    const chat = node({
      configurationMode: 'profile',
      outputLLMAttempts: true,
      outputUsage: true,
      useAsGraphPartialOutput: mode === 'stream',
    });
    const prompt = TextNodeImpl.create();
    prompt.data.text = 'Hello';
    const output = GraphOutputNodeImpl.create();
    const project = {
      metadata: { id: 'router-graph-project', title: 'Router graph', description: '', mainGraphId: 'router-graph' },
      graphs: {
        'router-graph': {
          metadata: { id: 'router-graph', name: 'Router graph', description: '' },
          nodes: [primary, backup, profiles, chat, prompt, output],
          connections: [
            [primary.id, 'profile', profiles.id, 'input1'],
            [backup.id, 'profile', profiles.id, 'input2'],
            [profiles.id, 'output', chat.id, 'llmProfile'],
            [prompt.id, 'output', chat.id, 'prompt'],
            [chat.id, 'response', output.id, 'value'],
          ].map(([outputNodeId, outputId, inputNodeId, inputId]) => ({ outputNodeId, outputId, inputNodeId, inputId })),
        },
      },
    } as unknown as Project;
    const processor = new GraphProcessor(project, project.metadata.mainGraphId!, globalRivetNodeRegistry);
    const host = {
      ...testProcessContext(),
      settings: { openRouterApiKey: 'router-secret' },
      llmProfileHealthStore: new InMemoryRivetLLMProfileHealthStore(),
    };
    assert.equal((await processor.processGraph(host)).output?.value, 'Hello back');
    assert.deepEqual(
      requests.map((request) => request.body.model),
      ['test/unavailable', 'test/model'],
    );
    assert.equal((await processor.processGraph(host)).output?.value, 'Hello back');
    assert.deepEqual(
      requests.map((request) => request.body.model),
      ['test/unavailable', 'test/model', 'test/model'],
    );
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMChatV2NodeImpl } from '../../../src/model/nodes/LLMChatV2Node.js';
import { LLMProfileNodeImpl } from '../../../src/model/nodes/LLMProfileNode.js';
import { resolveLLMChatV2RuntimeConfig } from '../../../src/model/chat-v2/llmChatV2NodeRuntime.js';
import type { LLMChatV2NodeData } from '../../../src/model/chat-v2/llmChatV2NodeData.js';
import type { Inputs } from '../../../src/model/GraphProcessor.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';
import { RunCostLedger } from '../../../src/model/RunCostLedger.js';

const variants: Array<{ label: string; data: Partial<LLMChatV2NodeData> }> = [
  { label: 'OpenAI', data: { provider: 'openai' } },
  { label: 'Anthropic', data: { provider: 'anthropic' } },
  { label: 'Google', data: { provider: 'google' } },
  { label: 'OpenRouter', data: { provider: 'openrouter' } },
  { label: 'Custom Completions', data: { provider: 'custom', customProviderApi: 'completions' } },
  { label: 'Custom Responses', data: { provider: 'custom', customProviderApi: 'responses' } },
];

function successfulResponse(provider: string, api?: string) {
  const text = 'Fixture answer';
  if (provider === 'anthropic')
    return {
      id: 'msg-fixture',
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3 },
    };
  if (provider === 'google')
    return {
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
      modelVersion: 'fixture-model',
    };
  if (provider === 'openai' || api === 'responses')
    return {
      id: 'resp-fixture',
      object: 'response',
      created_at: 1,
      model: 'fixture-model',
      status: 'completed',
      output: [
        {
          id: 'msg-fixture',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        total_tokens: 13,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
  return {
    id: 'chat-fixture',
    object: 'chat.completion',
    created: 1,
    model: 'fixture-model',
    provider: 'Fixture',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
}

for (const { label, data } of variants) {
  for (const successful of [false, true]) {
    test(`${label} preserves native requests and ${successful ? 'successful results' : 'authentication failure'} from Inline to Profile`, async (t) => {
      const requests: Array<{ url: string; headers: Array<[string, string]>; body: unknown }> = [];
      t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          headers: [...new Headers(init?.headers)],
          body: JSON.parse(String(init?.body)),
        });
        // Exercise the actual SDK request and native success/failure parsing
        // using provider-native response fixtures, without paid network calls.
        return successful
          ? Response.json(successfulResponse(data.provider!, data.customProviderApi))
          : Response.json({ error: { message: 'fixture authentication failure' } }, { status: 401 });
      });
      const base = LLMChatV2NodeImpl.create();
      const configuration: LLMChatV2NodeData = {
        ...base.data,
        ...data,
        model: 'fixture-model',
        apiKeySource: 'input' as const,
        temperature: 0.2,
        topP: 0.8,
        maxTokens: 50,
        parallelToolCalls: false,
        customProviderBaseURL: 'https://fixture.invalid/v1',
        enableCircuitBreaker: false,
      };
      const context = {
        settings: { chatNodeHeaders: {} },
        getPluginConfig: () => '',
        signal: new AbortController().signal,
        node: base,
        processId: 'fixture-process',
        trace: () => {},
      } as unknown as InternalProcessContext;
      const inputs = {
        prompt: { type: 'string', value: 'Same evidence' },
        apiKey: { type: 'string', value: 'fixture-secret' },
      } as Inputs;
      const inline = await resolveLLMChatV2RuntimeConfig({
        data: configuration,
        nodeId: base.id,
        context,
        inputs,
      });
      inline.runOptions.emitPartialOutputs = false;
      const inlineResult = successful ? await inline.runPipeline(inline.runOptions) : undefined;
      if (!successful) await assert.rejects(inline.runPipeline(inline.runOptions));
      assert.equal(requests.length, 1, 'an authentication failure must not retry');

      const profileBase = LLMProfileNodeImpl.create();
      const profile = new LLMProfileNodeImpl({ ...profileBase, data: configuration });
      const profileOutputs = await profile.process(inputs, context);
      const fromProfile = await resolveLLMChatV2RuntimeConfig({
        data: {
          ...configuration,
          configurationMode: 'profile',
          model: 'stale-inline-model',
          tokenPricing: { inputPerMillionTokens: -1, outputPerMillionTokens: -1 },
        },
        nodeId: base.id,
        context,
        inputs: { ...inputs, llmProfile: profileOutputs.profile! } as Inputs,
      });
      fromProfile.runOptions.emitPartialOutputs = false;
      const profileResult = successful ? await fromProfile.runPipeline(fromProfile.runOptions) : undefined;
      if (!successful) await assert.rejects(fromProfile.runPipeline(fromProfile.runOptions));
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1], requests[0], 'URL, authentication, native options and evidence stay equivalent');
      if (successful) {
        assert.equal(inlineResult?.response, 'Fixture answer');
        assert.equal(inlineResult?.rawUsage?.inputTokens, 10);
        assert.equal(inlineResult?.rawUsage?.outputTokens, 3);
        assert.deepEqual(profileResult, inlineResult, 'successful native parsing, usage and outputs stay equivalent');
        const pricedProfile = new LLMProfileNodeImpl({
          ...profileBase,
          data: { ...configuration, tokenPricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 8 } },
        });
        const pricedOutputs = await pricedProfile.process(inputs, context);
        for (const mode of ['inline', 'profile'] as const) {
          const ledger = new RunCostLedger();
          const authoredRates = { inputPerMillionTokens: mode === 'inline' ? 2 : 999, outputPerMillionTokens: 8 };
          const priced = await resolveLLMChatV2RuntimeConfig({
            data: { ...configuration, configurationMode: mode, tokenPricing: authoredRates },
            nodeId: base.id,
            context: { ...context, onChatV2CallFinished: (event) => ledger.observeChat(event) },
            inputs: mode === 'profile' ? ({ ...inputs, llmProfile: pricedOutputs.profile! } as Inputs) : inputs,
          });
          authoredRates.inputPerMillionTokens = 123;
          priced.runOptions.emitPartialOutputs = false;
          const result = await priced.runPipeline(priced.runOptions);
          assert.deepEqual(requests.at(-1), requests[0], 'pricing never enters provider requests');
          assert.equal(result.usage?.totalCost, 0.000044, `${mode} uses only its active configuration prices`);
          assert.deepEqual(ledger.snapshot(), { status: 'complete', knownCostUsd: result.usage?.totalCost });
        }
      }
    });
  }
}

test('invalid inline LLM pricing fails before HTTP, rather than making a paid call with unknown cost', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new Error('Unexpected HTTP');
  });
  const node = LLMChatV2NodeImpl.create();
  const context = {
    settings: { chatNodeHeaders: {} },
    getPluginConfig: () => '',
    node,
    signal: new AbortController().signal,
  } as unknown as InternalProcessContext;
  await assert.rejects(
    resolveLLMChatV2RuntimeConfig({
      data: {
        ...node.data,
        configurationMode: 'inline',
        tokenPricing: { inputPerMillionTokens: -1, outputPerMillionTokens: 0 },
      },
      nodeId: node.id,
      context,
      inputs: { prompt: { type: 'string', value: 'Fixture' } } as Inputs,
    }),
    /Token pricing/,
  );
  assert.equal(calls, 0);
});

test('LLM fallback does not reuse the previous candidate token prices', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? Response.json({ error: { message: 'fixture rejected' } }, { status: 401 })
      : Response.json(successfulResponse('custom', 'completions')),
  );
  const node = LLMChatV2NodeImpl.create();
  const context = {
    settings: { chatNodeHeaders: {} },
    getPluginConfig: () => '',
    signal: new AbortController().signal,
    node,
    processId: 'process',
    trace: () => {},
  } as unknown as InternalProcessContext;
  const inputs = {
    prompt: { type: 'string', value: 'Fixture' },
    apiKey: { type: 'string', value: 'fixture-key' },
  } as Inputs;
  const profiles = [];
  for (const rate of [2, 5]) {
    const base = LLMProfileNodeImpl.create();
    const profile = new LLMProfileNodeImpl({
      ...base,
      data: {
        ...base.data,
        provider: 'custom',
        model: 'private',
        apiKeySource: 'input',
        customProviderBaseURL: 'https://fixture.invalid/v1',
        tokenPricing: { inputPerMillionTokens: rate, outputPerMillionTokens: 0 },
      },
    });
    profiles.push((await profile.process(inputs, context)).profile!.value);
  }
  const ledger = new RunCostLedger();
  const runtime = await resolveLLMChatV2RuntimeConfig({
    data: { ...node.data, configurationMode: 'profile' },
    nodeId: node.id,
    context: { ...context, onChatV2CallFinished: (event) => ledger.observeChat(event) },
    inputs: { ...inputs, llmProfile: { type: 'llm-config[]', value: profiles } } as Inputs,
  });
  runtime.runOptions.emitPartialOutputs = false;
  const result = await runtime.runPipeline(runtime.runOptions);
  assert.equal(calls, 2);
  assert.equal(result.usage?.totalCost, 0.00005);
  assert.deepEqual(ledger.snapshot(), { status: 'partial', knownCostUsd: 0.00005 });
});

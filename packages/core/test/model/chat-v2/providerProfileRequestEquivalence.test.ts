import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMChatV2NodeImpl } from '../../../src/model/nodes/LLMChatV2Node.js';
import { LLMProfileNodeImpl } from '../../../src/model/nodes/LLMProfileNode.js';
import { resolveLLMChatV2RuntimeConfig } from '../../../src/model/chat-v2/llmChatV2NodeRuntime.js';
import type { LLMChatV2NodeData } from '../../../src/model/chat-v2/llmChatV2NodeData.js';
import type { Inputs } from '../../../src/model/GraphProcessor.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';

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
        data: { ...configuration, configurationMode: 'profile', model: 'stale-inline-model' },
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
      }
    });
  }
}

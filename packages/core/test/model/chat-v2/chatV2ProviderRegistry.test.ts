import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { supportsLLMChatV2ParallelToolCalls } from '../../../src/model/chat-v2/parallelToolCalls.js';
import {
  getChatV2ProviderCapabilities,
  chatV2ProviderDescriptors,
  chatV2ProviderOptions,
} from '../../../src/model/chat-v2/chatV2ProviderRegistry.js';
import {
  getDefaultChatV2Model,
  getChatV2ProviderLabel,
  getChatV2ModelOptions,
  parseChatV2Provider,
} from '../../../src/model/chat-v2/providerOptions.js';

void describe('Chat V2 provider registry', () => {
  void it('preserves provider order, labels, defaults and fail-closed parsing', () => {
    assert.deepEqual(chatV2ProviderOptions, [
      { value: 'openai', label: 'OpenAI' },
      { value: 'anthropic', label: 'Anthropic' },
      { value: 'google', label: 'Google' },
      { value: 'openrouter', label: 'OpenRouter' },
      { value: 'custom', label: 'Custom provider' },
    ]);
    for (const { value, label } of chatV2ProviderOptions) {
      assert.equal(parseChatV2Provider(value), value);
      assert.equal(getChatV2ProviderLabel(value), label);
      assert.equal(getDefaultChatV2Model(value), chatV2ProviderDescriptors[value].defaultModel);
    }
    assert.deepEqual(
      Object.fromEntries(chatV2ProviderOptions.map(({ value }) => [value, getDefaultChatV2Model(value)])),
      {
        openai: 'gpt-5',
        anthropic: 'claude-sonnet-4-20250514',
        google: 'gemini-2.5-flash',
        openrouter: 'openrouter/auto',
        custom: 'model-id',
      },
    );
    for (const unknown of ['constructor', '__proto__', 'toString', 'OpenAI', '']) {
      assert.throws(() => parseChatV2Provider(unknown), /Unsupported LLM Chat provider/);
    }
    assert.deepEqual(getChatV2ModelOptions('openrouter'), [{ value: 'openrouter/auto', label: 'OpenRouter Auto' }]);
    const options = getChatV2ModelOptions('openrouter');
    options[0]!.label = 'Changed by caller';
    assert.equal(getChatV2ModelOptions('openrouter')[0]!.label, 'OpenRouter Auto');
  });
  void it('owns parallel tool capability decisions for every bundled provider', () => {
    assert.equal(supportsLLMChatV2ParallelToolCalls('openai'), true);
    assert.equal(supportsLLMChatV2ParallelToolCalls('anthropic'), true);
    assert.equal(supportsLLMChatV2ParallelToolCalls('custom'), true);
    assert.equal(supportsLLMChatV2ParallelToolCalls('google'), false);
    assert.deepEqual(
      Object.fromEntries(chatV2ProviderOptions.map(({ value }) => [value, getChatV2ProviderCapabilities(value)])),
      {
        openai: { builtInTools: true, parallelToolCalls: true, structuredOutput: true },
        anthropic: { builtInTools: false, parallelToolCalls: true, structuredOutput: true },
        google: { builtInTools: true, parallelToolCalls: false, structuredOutput: true },
        openrouter: { builtInTools: false, parallelToolCalls: true, structuredOutput: true },
        custom: { builtInTools: false, parallelToolCalls: true, structuredOutput: true },
      },
    );
  });
});

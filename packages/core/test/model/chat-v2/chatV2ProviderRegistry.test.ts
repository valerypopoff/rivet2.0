import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getChatV2ProviderCapabilities } from '../../../src/model/chat-v2/chatV2ProviderRegistry.js';
import { supportsLLMChatV2ParallelToolCalls } from '../../../src/model/chat-v2/parallelToolCalls.js';

describe('Chat V2 provider registry', () => {
  it('owns parallel tool capability decisions for every bundled provider', () => {
    assert.equal(supportsLLMChatV2ParallelToolCalls('openai'), true);
    assert.equal(supportsLLMChatV2ParallelToolCalls('anthropic'), true);
    assert.equal(supportsLLMChatV2ParallelToolCalls('custom'), true);
    assert.equal(supportsLLMChatV2ParallelToolCalls('google'), false);
    assert.equal(getChatV2ProviderCapabilities('openai').builtInTools, true);
  });
});

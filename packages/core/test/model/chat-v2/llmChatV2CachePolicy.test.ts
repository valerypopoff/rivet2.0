import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { getLLMChatV2EditorCacheEligibility } from '../../../src/model/chat-v2/llmChatV2CachePolicy.js';
import { createLLMChatV2NodeData } from '../../../src/model/chat-v2/llmChatV2NodeData.js';

describe('LLM Chat v2 editor cache policy', () => {
  it('allows only ordinary cache-enabled model calls', () => {
    assert.deepEqual(getLLMChatV2EditorCacheEligibility({ ...createLLMChatV2NodeData(), cache: true }), {
      eligible: true,
    });
    assert.deepEqual(getLLMChatV2EditorCacheEligibility({ ...createLLMChatV2NodeData(), cache: false }), {
      eligible: false,
      reason: 'disabled',
    });
  });

  it('bypasses legacy replay for Rivet and provider-native tools', () => {
    assert.deepEqual(
      getLLMChatV2EditorCacheEligibility({ ...createLLMChatV2NodeData(), cache: true, useToolCalling: true }),
      { eligible: false, reason: 'rivet-tools' },
    );
    assert.deepEqual(
      getLLMChatV2EditorCacheEligibility({
        ...createLLMChatV2NodeData(),
        cache: true,
        enableOpenAIWebSearch: true,
      }),
      { eligible: false, reason: 'provider-native-tools' },
    );
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { writeLLMChatV2EditorCache } from '../../../src/model/chat-v2/llmChatV2CacheBoundary.js';

function createRuntime(editorCache: Map<string, unknown>) {
  return {
    cacheKey: 'cache-key',
    editorCache,
    isProfileFallbackExhausted: () => false,
  } as any;
}

describe('LLM Chat v2 editor cache boundary', () => {
  it('does not cache diagnostic provider-failure outputs', () => {
    const editorCache = new Map<string, unknown>();

    writeLLMChatV2EditorCache({
      runtime: createRuntime(editorCache),
      result: {
        terminalOutcome: 'provider-failure',
        commonOutputs: {
          response: { type: 'string', value: 'partial diagnostic text' },
          requestError: { type: 'string', value: 'Provider failed' },
        },
      } as any,
    });

    assert.equal(editorCache.size, 0);
  });

  it('caches final model-answer outputs', () => {
    const editorCache = new Map<string, unknown>();

    writeLLMChatV2EditorCache({
      runtime: createRuntime(editorCache),
      result: {
        commonOutputs: { response: { type: 'string', value: 'healthy answer' } },
      } as any,
    });

    assert.deepEqual(editorCache.get('cache-key'), {
      response: { type: 'string', value: 'healthy answer' },
    });
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  writeLLMChatV2EditorCache,
  projectLLMChatV2EditorCacheHit,
} from '../../../src/model/chat-v2/llmChatV2CacheBoundary.js';

function createRuntime(editorCache: Map<string, unknown>) {
  return {
    cacheKey: 'cache-key',
    editorCache,
    isProfileFallbackExhausted: () => false,
  } as any;
}

void describe('LLM Chat v2 editor cache boundary', () => {
  void it('does not re-charge cached model or delegated classifier costs or mutate cached evidence', () => {
    const cachedOutputs = {
      response: { type: 'string', value: 'cached answer' },
      cost: { type: 'number', value: 0.23 },
      costBreakdown: { type: 'object', value: { llm: 0.2, classifier: 0.03, other: 0 } },
      usage: { type: 'object', value: { totalCost: 0.2 } },
    };
    const runtime = { ...createRuntime(new Map()), cachedOutputs };
    for (let run = 0; run < 2; run++) {
      const outputs = projectLLMChatV2EditorCacheHit(runtime)!;
      assert.equal(outputs.cost?.value, 0);
      assert.equal(outputs.costBreakdown, undefined);
      assert.equal(outputs.response?.value, 'cached answer');
      assert.deepEqual(outputs.usage?.value, { totalCost: 0.2 });
      assert.notEqual(outputs, cachedOutputs);
    }
    assert.equal(cachedOutputs.cost.value, 0.23);
    assert.equal(cachedOutputs.costBreakdown.value.classifier, 0.03);
  });

  void it('does not cache legacy provider-failure results', () => {
    const editorCache = new Map<string, unknown>();

    writeLLMChatV2EditorCache({
      runtime: createRuntime(editorCache),
      result: {
        terminalOutcome: 'provider-failure',
        commonOutputs: {
          response: { type: 'string', value: 'partial diagnostic text' },
        },
      } as any,
    });

    assert.equal(editorCache.size, 0);
  });

  void it('caches final model-answer outputs', () => {
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

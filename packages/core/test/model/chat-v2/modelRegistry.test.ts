import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { calculatePromptAndCompletionCost } from '../../../src/model/chat/chatCost.js';
import {
  calculateChatV2Cost,
  calculateChatV2UsageCost,
  getChatV2ModelInfo,
  getChatV2ModelRegistry,
} from '../../../src/model/chat-v2/modelRegistry.js';
import { getChatV2ModelOptions } from '../../../src/model/chat-v2/providerOptions.js';
import { openaiModels } from '../../../src/utils/openai.js';

void describe('LLM Chat V2 model pricing registry', () => {
  void it('normalizes legacy OpenAI per-thousand rates before Chat V2 multiplies raw token counts', () => {
    const tokenCount = 1_000_000;

    assert.equal(
      calculatePromptAndCompletionCost(tokenCount, tokenCount, openaiModels['gpt-4o-mini'].cost).totalCost,
      0.75,
    );
    assert.equal(calculateChatV2Cost('openai', 'gpt-4o-mini', tokenCount, tokenCount), 0.75);

    assert.equal(calculatePromptAndCompletionCost(tokenCount, tokenCount, openaiModels['gpt-5'].cost).totalCost, 11.25);
    assert.equal(calculateChatV2Cost('openai', 'gpt-5', tokenCount, tokenCount), 11.25);

    assert.ok(
      Math.abs(calculatePromptAndCompletionCost(tokenCount, tokenCount, openaiModels.o1.cost).totalCost - 75) <
        Number.EPSILON * 1_000,
    );
    assert.ok(
      Math.abs((calculateChatV2Cost('openai', 'o1', tokenCount, tokenCount) ?? 0) - 75) < Number.EPSILON * 1_000,
    );
  });

  void it('registers the GPT-5.6 family with per-token pricing for model selection and accounting', () => {
    const luna = getChatV2ModelInfo('openai', 'gpt-5.6-luna');

    assert.equal(luna?.maxTokens, 1_050_000);
    assert.equal(luna?.displayName, 'GPT-5.6 Luna');
    assert.ok(Math.abs((luna?.cost?.prompt ?? 0) - 0.2e-6) < Number.EPSILON);
    assert.ok(Math.abs((luna?.cost?.completion ?? 0) - 1.2e-6) < Number.EPSILON);
    assert.equal(calculateChatV2Cost('openai', 'gpt-5.6-luna', 1_000_000, 1_000_000), 1.4);
    assert.equal(calculateChatV2Cost('openai', 'gpt-5.6-terra', 1_000_000, 1_000_000), 14);
    assert.equal(calculateChatV2Cost('openai', 'gpt-5.6-sol', 1_000_000, 1_000_000), 35);
    assert.equal(getChatV2ModelRegistry().openai['gpt-5.6']?.displayName, 'GPT-5.6');
  });

  void it('keeps unknown models and incomplete provider usage unpriced instead of reporting zero', () => {
    assert.equal(calculateChatV2Cost('custom', 'private-model', 10, 5), undefined);
    assert.equal(calculateChatV2UsageCost('openai', 'gpt-5.6-luna', { inputTokens: 10 }), undefined);
    assert.equal(calculateChatV2UsageCost('openai', 'gpt-5.6-luna', { outputTokens: 5 }), undefined);
  });

  void it('keeps explicitly unpriced legacy models selectable without inventing a zero cost', () => {
    const options = getChatV2ModelOptions('google');
    for (const [modelId, displayName] of [
      ['gemini-1.5-pro', 'Gemini 1.5 Pro'],
      ['gemini-1.5-flash', 'Gemini 1.5 Flash'],
    ] as const) {
      const model = getChatV2ModelInfo('google', modelId);

      assert.equal(model?.displayName, displayName);
      assert.equal(model?.cost, undefined);
      assert.equal(calculateChatV2Cost('google', modelId, 10, 5), undefined);
      assert.ok(options.some((option) => option.value === modelId));
    }
  });

  void it('uses current Anthropic base rates in the shared per-token catalog', () => {
    for (const [modelId, expectedCost] of [
      ['claude-instant-1', 7.14],
      ['claude-sonnet-4-20250514', 18],
      ['claude-opus-4-20250514', 90],
    ] as const) {
      const cost = calculateChatV2Cost('anthropic', modelId, 1_000_000, 1_000_000);

      assert.ok(Math.abs((cost ?? 0) - expectedCost) < Number.EPSILON * 1_000, modelId);
    }
  });

  void it('contains only finite, non-negative normalized pricing', () => {
    for (const models of Object.values(getChatV2ModelRegistry())) {
      for (const model of Object.values(models)) {
        if (model.cost == null) {
          continue;
        }

        assert.ok(Number.isFinite(model.cost.prompt) && model.cost.prompt >= 0, `${model.displayName} input pricing`);
        assert.ok(
          Number.isFinite(model.cost.completion) && model.cost.completion >= 0,
          `${model.displayName} output pricing`,
        );
      }
    }
  });
});

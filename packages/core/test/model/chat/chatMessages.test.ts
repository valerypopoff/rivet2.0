import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { coercePromptToChatMessages, prependSystemPrompt } from '../../../src/model/chat/chatMessages.js';
import { clampMaxTokensToModelLimit, setRequestAndResponseTokenOutputs } from '../../../src/model/chat/tokenBudget.js';
import { getWarnings } from '../../../src/utils/outputs.js';

describe('chatMessages helpers', () => {
  it('coerces string arrays into user chat messages', () => {
    assert.deepEqual(coercePromptToChatMessages({ type: 'string[]', value: ['a', 'b'] }), [
      { type: 'user', message: 'a' },
      { type: 'user', message: 'b' },
    ]);
  });

  it('prepends the dedicated system prompt without replacing prompt messages', () => {
    assert.deepEqual(
      prependSystemPrompt(
        [
          { type: 'system', message: 'old' },
          { type: 'user', message: 'hello' },
        ],
        { type: 'string', value: 'new' },
      ),
      [
        { type: 'system', message: 'new' },
        { type: 'system', message: 'old' },
        { type: 'user', message: 'hello' },
      ],
    );
  });
});

describe('tokenBudget helpers', () => {
  it('clamps max tokens and adds a warning when prompt plus max tokens exceed the model limit', () => {
    const output: Record<string, any> = {};
    const maxTokens = clampMaxTokensToModelLimit(output as never, 'test-model', 900, 200, 1000);

    assert.equal(maxTokens, 95);
    assert.match(getWarnings(output as never)![0]!, /max tokens together exceed this limit/i);
  });

  it('writes request and response token outputs', () => {
    const output: Record<string, any> = {};
    setRequestAndResponseTokenOutputs(output as never, 12, 34);

    assert.deepEqual(output['requestTokens'], { type: 'number', value: 12 });
    assert.deepEqual(output['responseTokens'], { type: 'number', value: 34 });
  });
});

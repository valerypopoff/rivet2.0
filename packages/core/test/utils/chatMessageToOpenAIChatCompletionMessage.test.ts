import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { chatMessageToOpenAIChatCompletionMessage } from '../../src/utils/chatMessageToOpenAIChatCompletionMessage.js';

describe('chatMessageToOpenAIChatCompletionMessage', () => {
  it('preserves explicit developer messages regardless of system prompt mode', async () => {
    const developerMessage = {
      type: 'developer' as const,
      message: 'Follow developer instructions.',
    };

    assert.deepEqual(
      await chatMessageToOpenAIChatCompletionMessage(developerMessage, {
        useDeveloperPrompts: false,
      }),
      {
        role: 'developer',
        content: 'Follow developer instructions.',
      },
    );
    assert.deepEqual(
      await chatMessageToOpenAIChatCompletionMessage(developerMessage, {
        useDeveloperPrompts: true,
      }),
      {
        role: 'developer',
        content: 'Follow developer instructions.',
      },
    );
  });
});

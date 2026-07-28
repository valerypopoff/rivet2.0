import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { getVertexGenerativeModelOptions } from '../../../../src/plugins/google/google.js';
import { getChatGoogleNodeMessages } from '../../../../src/plugins/google/nodes/ChatGoogleNode.js';

describe('legacy Google instruction messages', () => {
  it('combines dedicated, system, and developer instructions outside the conversation', () => {
    assert.deepEqual(
      getChatGoogleNodeMessages({
        systemPrompt: { type: 'string', value: 'Dedicated system' },
        prompt: {
          type: 'chat-message[]',
          value: [
            { type: 'system', message: 'Prompt system' },
            { type: 'developer', message: 'Prompt developer' },
            { type: 'user', message: 'Question' },
          ],
        },
      } as any),
      {
        messages: [{ type: 'user', message: 'Question' }],
        systemPrompt: 'Dedicated system\n\nPrompt system\n\nPrompt developer',
      },
    );
  });

  it('keeps an empty dedicated system input from creating an empty instruction block', () => {
    assert.deepEqual(
      getChatGoogleNodeMessages({
        systemPrompt: { type: 'string', value: '' },
        prompt: {
          type: 'chat-message',
          value: { type: 'developer', message: 'Developer only' },
        },
      } as any),
      {
        messages: [],
        systemPrompt: 'Developer only',
      },
    );
  });

  it('forwards the combined instruction through the Vertex model configuration', () => {
    assert.deepEqual(
      getVertexGenerativeModelOptions({
        model: 'gemini-pro',
        systemPrompt: 'System and developer instructions',
        max_output_tokens: 2048,
        temperature: 0.4,
        top_p: 0.9,
        top_k: 32,
      }),
      {
        model: 'gemini-pro',
        systemInstruction: 'System and developer instructions',
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.4,
          topP: 0.9,
          topK: 32,
        },
      },
    );
  });
});

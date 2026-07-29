import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  chatMessagesToClaude3ChatMessages,
  getSystemPrompt,
} from '../../../../src/plugins/anthropic/nodes/ChatAnthropicNode.js';

describe('legacy Anthropic instruction messages', () => {
  it('combines the dedicated system input with system and developer prompt messages', () => {
    assert.deepEqual(
      getSystemPrompt({
        system: { type: 'string', value: 'Dedicated system' },
        prompt: {
          type: 'chat-message[]',
          value: [
            { type: 'system', message: 'Prompt system', isCacheBreakpoint: true },
            { type: 'developer', message: 'Prompt developer' },
            { type: 'user', message: 'Question' },
          ],
        },
      } as any),
      [
        { type: 'text', text: 'Dedicated system', cache_control: null },
        { type: 'text', text: 'Prompt system', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Prompt developer', cache_control: null },
      ],
    );
  });

  it('removes instruction messages from the conversational message list', async () => {
    assert.deepEqual(
      await chatMessagesToClaude3ChatMessages([
        { type: 'system', message: 'System' },
        { type: 'developer', message: 'Developer' },
        { type: 'user', message: 'Question' },
      ]),
      [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Question', cache_control: null }],
        },
      ],
    );
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { resolveChatTools } from '../../../src/model/chat/openAIChatRequest.js';
import type { Inputs } from '../../../src/model/GraphProcessor.js';
import type { PortId } from '../../../src/model/NodeBase.js';

describe('resolveChatTools', () => {
  it('omits Rivet-only result handling from Legacy Chat provider tools', () => {
    const inputs: Inputs = {
      ['functions' as PortId]: {
        type: 'gpt-function[]',
        value: [
          {
            name: 'export_json',
            description: 'Exports JSON',
            parameters: { type: 'object' },
            strict: true,
            resultHandling: 'return-direct',
          },
        ],
      },
    };

    assert.deepEqual(resolveChatTools(inputs), [
      {
        type: 'function',
        function: {
          name: 'export_json',
          description: 'Exports JSON',
          parameters: { type: 'object' },
          strict: true,
        },
      },
    ]);
  });
});

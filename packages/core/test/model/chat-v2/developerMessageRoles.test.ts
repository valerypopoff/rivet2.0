import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  getInstructionMessageRoles,
  restoreOpenAICompatibleInstructionRoles,
} from '../../../src/model/chat-v2/developerMessageRoles.js';

describe('developer message roles', () => {
  it('collects system and developer roles in prompt order', () => {
    assert.deepEqual(
      getInstructionMessageRoles([
        { type: 'system', message: 'System' },
        { type: 'developer', message: 'Developer' },
        { type: 'user', message: 'User' },
      ]),
      ['system', 'developer'],
    );
  });

  it('restores mixed instruction roles in chat-completions request bodies', () => {
    assert.deepEqual(
      restoreOpenAICompatibleInstructionRoles(
        {
          model: 'model-id',
          messages: [
            { role: 'system', content: 'System' },
            { role: 'system', content: 'Developer' },
            { role: 'user', content: 'User' },
          ],
        },
        ['system', 'developer'],
      ),
      {
        model: 'model-id',
        messages: [
          { role: 'system', content: 'System' },
          { role: 'developer', content: 'Developer' },
          { role: 'user', content: 'User' },
        ],
      },
    );
  });

  it('restores roles in Responses request bodies and rejects mismatches', () => {
    const body = {
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'System' }] },
        { role: 'developer', content: [{ type: 'input_text', text: 'Developer' }] },
      ],
    };

    assert.deepEqual(restoreOpenAICompatibleInstructionRoles(body, ['system', 'developer']), {
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'System' }] },
        { role: 'developer', content: [{ type: 'input_text', text: 'Developer' }] },
      ],
    });
    assert.throws(
      () => restoreOpenAICompatibleInstructionRoles(body, ['developer']),
      /expected 1 instruction message\(s\), but the provider request contains 2/,
    );
  });

  it('rejects unfamiliar request shapes without including request content in the error', () => {
    const secret = 'do-not-expose-this-content';

    assert.throws(
      () => restoreOpenAICompatibleInstructionRoles({ prompt: secret }, ['developer']),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('has no messages or input array') &&
        !error.message.includes(secret),
    );
  });
});

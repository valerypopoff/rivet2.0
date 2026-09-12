import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ChatLoopNodeImpl, chatLoopLegacyDisplayName } from '../../../src/index.js';

describe('ChatLoopNode', () => {
  it('labels newly created nodes as legacy without changing the persisted node type', () => {
    const node = ChatLoopNodeImpl.create();

    assert.equal(node.title, chatLoopLegacyDisplayName);
    assert.equal(node.type, 'chatLoop');
    assert.equal(node.data.userPrompt, 'Your response:');
  });

  it('keeps projects saved with the former title loadable as chatLoop nodes', () => {
    const currentNode = ChatLoopNodeImpl.create();
    const legacyNode = new ChatLoopNodeImpl({ ...currentNode, title: 'Chat Loop' });

    assert.deepEqual(
      legacyNode.getOutputDefinitions().map(({ id }) => id),
      ['conversation', 'lastMessage'],
    );
  });
});

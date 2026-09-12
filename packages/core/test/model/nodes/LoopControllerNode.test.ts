import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  LoopControllerNodeImpl,
  loopControllerLegacyDisplayName,
  loopControllerNode,
} from '../../../src/index.js';

describe('LoopControllerNode', () => {
  it('labels new nodes as legacy without changing the persisted type or old-node behavior', () => {
    const node = LoopControllerNodeImpl.create();

    assert.equal(node.type, 'loopController');
    assert.equal(node.title, loopControllerLegacyDisplayName);
    assert.equal(loopControllerNode.displayName, loopControllerLegacyDisplayName);
    assert.equal(LoopControllerNodeImpl.getUIData().contextMenuTitle, loopControllerLegacyDisplayName);

    const savedWithFormerTitle = new LoopControllerNodeImpl({ ...node, title: 'Loop Controller' });
    assert.deepEqual(
      savedWithFormerTitle.getOutputDefinitions([], {}).map(({ id }) => id),
      ['break', 'iteration'],
    );
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AssembleMessageNodeImpl, type PortId } from '../../../src/index.js';

describe('AssembleMessageNode', () => {
  it('orders numbered parts numerically instead of lexicographically', async () => {
    const node = new AssembleMessageNodeImpl(AssembleMessageNodeImpl.create());

    const result = await node.process({
      ['part10' as PortId]: { type: 'string', value: 'Ten' },
      ['part2' as PortId]: { type: 'string', value: 'Two' },
      ['part1' as PortId]: { type: 'string', value: 'One' },
    });

    assert.deepEqual(result.message?.value, {
      type: 'user',
      message: ['One', 'Two', 'Ten'],
    });
  });
});

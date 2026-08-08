import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createRivetToolRegistry } from '../../../src/model/chat-v2/rivetToolRegistry.js';
import type { GptFunction } from '../../../src/model/DataValue.js';

describe('Rivet tool registry', () => {
  it('ignores blank declarations and preserves last-declaration-wins compatibility', () => {
    const first = makeTool('lookup', 'first');
    const replacement = makeTool('lookup', 'replacement');
    const registry = createRivetToolRegistry([first, makeTool('   ', 'blank'), replacement]);

    assert.deepEqual([...registry.names], ['lookup']);
    assert.equal(registry.byName.get('lookup'), replacement);
  });
});

function makeTool(name: string, description: string): GptFunction {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
  };
}

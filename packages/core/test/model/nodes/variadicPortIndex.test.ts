import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { getHighestVariadicPortIndex, getNextVariadicPortIndex } from '../../../src/model/nodes/variadicPortIndex.js';
import type { NodeConnection, NodeId, PortId } from '../../../src/index.js';

const nodeId = 'variadic-node' as NodeId;

function connection(inputNodeId: NodeId, inputId: string): NodeConnection {
  return { inputNodeId, inputId: inputId as PortId } as NodeConnection;
}

void describe('variadic port index helpers', () => {
  void it('uses the highest matching input connection and creates the next trailing slot', () => {
    const connections = [
      connection(nodeId, 'input1'),
      connection(nodeId, 'input3'),
      connection('other-node' as NodeId, 'input99'),
      connection(nodeId, 'other2'),
    ];

    assert.strictEqual(getNextVariadicPortIndex(connections, nodeId, 'input', 'decimal'), 4);
  });

  void it('preserves legacy no-radix parsing for older numbered port ids', () => {
    assert.strictEqual(getNextVariadicPortIndex([connection(nodeId, 'part0x10')], nodeId, 'part', 'legacy'), 17);
    assert.strictEqual(getNextVariadicPortIndex([connection(nodeId, 'part3extra')], nodeId, 'part', 'legacy'), 4);
  });

  void it('preserves decimal parsing for numbered input nodes', () => {
    assert.strictEqual(
      getNextVariadicPortIndex(
        [connection(nodeId, 'input0x10'), connection(nodeId, 'input2')],
        nodeId,
        'input',
        'decimal',
      ),
      3,
    );
  });

  void it('keeps Coalesce strict about positive, safe, fully numbered ports', () => {
    assert.strictEqual(
      getNextVariadicPortIndex(
        [
          connection(nodeId, 'input0'),
          connection(nodeId, 'input2'),
          connection(nodeId, 'input3extra'),
          connection(nodeId, `input${'9'.repeat(100)}`),
        ],
        nodeId,
        'input',
        'strict-positive',
      ),
      3,
    );
  });

  void it('returns the existing highest index when a node does not create a trailing port', () => {
    assert.strictEqual(
      getHighestVariadicPortIndex(
        [connection(nodeId, 'input1'), connection(nodeId, 'input4')],
        nodeId,
        'input',
        'legacy',
      ),
      4,
    );
  });
});

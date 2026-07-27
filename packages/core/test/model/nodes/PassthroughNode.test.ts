import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  canRenderPassthroughAsDataBus,
  isPassthroughDataBusNode,
  PassthroughNodeImpl,
  type Inputs,
  type NodeConnection,
  type NodeId,
  type PortId,
} from '../../../src/index.js';

function connection(options: {
  inputNodeId?: string;
  inputId?: string;
  outputNodeId?: string;
  outputId?: string;
}): NodeConnection {
  return {
    inputNodeId: (options.inputNodeId ?? 'target') as NodeId,
    inputId: (options.inputId ?? 'input') as PortId,
    outputNodeId: (options.outputNodeId ?? 'source') as NodeId,
    outputId: (options.outputId ?? 'output') as PortId,
  };
}

void describe('PassthroughNode', () => {
  void it('keeps a channel repairable when only its output remains connected', () => {
    const chartNode = PassthroughNodeImpl.create();
    const node = new PassthroughNodeImpl(chartNode);
    const connections = [
      connection({
        outputNodeId: chartNode.id,
        outputId: 'output3',
      }),
    ];

    assert.deepStrictEqual(
      node.getInputDefinitions(connections).map((definition) => definition.id),
      ['input1', 'input2', 'input3', 'input4'],
    );
    assert.deepStrictEqual(
      node.getOutputDefinitions(connections).map((definition) => definition.id),
      ['output1', 'output2', 'output3'],
    );
  });

  void it('passes sparse variadic inputs to their matching outputs', async () => {
    const node = new PassthroughNodeImpl(PassthroughNodeImpl.create());
    const input = { type: 'string', value: 'third channel' } as const;

    const result = await node.process({
      input3: input,
      unrelated: { type: 'boolean', value: true },
    } as Inputs);

    assert.deepStrictEqual(result, { output3: input });
  });

  void it('does not expand pathological imported port indexes', async () => {
    const chartNode = PassthroughNodeImpl.create();
    const node = new PassthroughNodeImpl(chartNode);
    const connections = [
      connection({
        outputNodeId: chartNode.id,
        outputId: 'output1000000000',
      }),
    ];

    assert.deepStrictEqual(
      node.getInputDefinitions(connections).map((definition) => definition.id),
      ['input1'],
    );
    assert.deepStrictEqual(node.getOutputDefinitions(connections), []);
    assert.deepStrictEqual(
      await node.process({
        input1000000000: { type: 'string', value: 'untrusted' },
      } as Inputs),
      {},
    );
  });

  void it('treats data-bus mode as presentation metadata and rejects hidden conditional or split modes', () => {
    const chartNode = {
      ...PassthroughNodeImpl.create(),
      data: { renderAsDataBus: true },
    };

    assert.equal(isPassthroughDataBusNode(chartNode), true);
    assert.equal(canRenderPassthroughAsDataBus(chartNode), true);
    assert.equal(canRenderPassthroughAsDataBus({ ...chartNode, isConditional: true }), false);
    assert.equal(canRenderPassthroughAsDataBus({ ...chartNode, isSplitRun: true }), false);
    assert.equal(canRenderPassthroughAsDataBus({ ...chartNode, disabled: true }), false);
    assert.equal(
      canRenderPassthroughAsDataBus({ ...chartNode, variants: [{ id: 'variant', name: 'Variant' }] }),
      false,
    );
    assert.equal(isPassthroughDataBusNode({ ...chartNode, data: undefined as never }), false);
  });
});

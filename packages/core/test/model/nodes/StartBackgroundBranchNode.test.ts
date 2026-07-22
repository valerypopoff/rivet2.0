import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { NodeConnection, PortId } from '../../../src/index.js';
import { StartBackgroundBranchNodeImpl } from '../../../src/index.js';

void describe('StartBackgroundBranchNodeImpl', () => {
  void it('creates an async branch node with no settings', () => {
    const chartNode = StartBackgroundBranchNodeImpl.create();
    const node = new StartBackgroundBranchNodeImpl(chartNode);

    assert.equal(chartNode.type, 'startBackgroundBranch');
    assert.equal(chartNode.title, 'Start Async Branch');
    assert.deepEqual(chartNode.data, {});
    assert.deepEqual(node.getEditors({} as never), []);
    assert.match(node.getBody(), /asynchronously/i);
    assert.match(node.getBody(), /root run still waits/i);
  });

  void it('mirrors every connected input with an async output and retains a trailing input', () => {
    const chartNode = StartBackgroundBranchNodeImpl.create();
    const node = new StartBackgroundBranchNodeImpl(chartNode);
    const connections = [
      { inputNodeId: chartNode.id, inputId: 'input1' as PortId },
      { inputNodeId: chartNode.id, inputId: 'input3' as PortId },
    ] as NodeConnection[];

    assert.deepEqual(
      node.getInputDefinitions(connections).map(({ id, title }) => ({ id, title })),
      [
        { id: 'input1', title: 'Async Input 1' },
        { id: 'input2', title: 'Async Input 2' },
        { id: 'input3', title: 'Async Input 3' },
        { id: 'input4', title: 'Async Input 4' },
      ],
    );
    assert.deepEqual(
      node.getOutputDefinitions(connections).map(({ id, title }) => ({ id, title })),
      [
        { id: 'output1', title: 'Async Output 1' },
        { id: 'output2', title: 'Async Output 2' },
        { id: 'output3', title: 'Async Output 3' },
      ],
    );
  });

  void it('forwards each input value to its mirrored output', async () => {
    const node = new StartBackgroundBranchNodeImpl(StartBackgroundBranchNodeImpl.create());
    const first = { type: 'string', value: 'status' } as const;
    const second = { type: 'number', value: 42 } as const;

    assert.deepEqual(
      await node.process({
        input1: first,
        input2: second,
      }),
      {
        output1: first,
        output2: second,
      },
    );
  });

  void it('preserves sparse variadic port indexes', async () => {
    const node = new StartBackgroundBranchNodeImpl(StartBackgroundBranchNodeImpl.create());
    const first = { type: 'string', value: 'status' } as const;
    const third = { type: 'number', value: 42 } as const;

    assert.deepEqual(
      await node.process({
        input1: first,
        input3: third,
      }),
      {
        output1: first,
        output3: third,
      },
    );
  });
});

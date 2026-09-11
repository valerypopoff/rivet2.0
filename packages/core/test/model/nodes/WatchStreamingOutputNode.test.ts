import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { WatchStreamingOutputNodeImpl } from '../../../src/index.js';

describe('WatchStreamingOutputNode', () => {
  it('keeps stable output IDs while presenting stream snapshots as chunks', () => {
    const node = WatchStreamingOutputNodeImpl.create();
    const outputs = new WatchStreamingOutputNodeImpl(node).getOutputDefinitions();

    assert.deepEqual(
      outputs.map(({ id, title }) => ({ id, title })),
      [
        { id: 'value', title: 'Chunk' },
        { id: 'allStreamedOutput', title: 'All Chunks' },
        { id: 'updateIndex', title: 'Chunk Index' },
        { id: 'isFinal', title: 'Is Final' },
      ],
    );
  });

  it('shows only the scheduling controls that apply to the selected modes', () => {
    const node = WatchStreamingOutputNodeImpl.create();
    const editors = new WatchStreamingOutputNodeImpl(node).getEditors();
    const interval = editors.find((editor) => 'dataKey' in editor && editor.dataKey === 'intervalMs');
    const maxParallelRuns = editors.find((editor) => 'dataKey' in editor && editor.dataKey === 'maxParallelRuns');
    const queueOverflowBehavior = editors.find((editor) => 'dataKey' in editor && editor.dataKey === 'queueOverflowBehavior');

    assert.equal(interval?.hideIf?.({ ...node.data, triggerMode: 'every-update' }), true);
    assert.equal(interval?.hideIf?.({ ...node.data, triggerMode: 'interval' }), false);
    assert.equal(maxParallelRuns?.hideIf?.({ ...node.data, executionMode: 'sequential' }), true);
    assert.equal(maxParallelRuns?.hideIf?.({ ...node.data, executionMode: 'parallel' }), false);
    assert.deepEqual(queueOverflowBehavior?.options, [
      { label: 'Fail run', value: 'fail' },
      { label: 'Drop new update', value: 'drop' },
    ]);
    assert.equal(queueOverflowBehavior?.defaultValue, 'fail');
    assert.equal(node.data.queueOverflowBehavior, 'fail');
  });
});

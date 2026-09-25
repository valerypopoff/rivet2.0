import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  StreamValueNodeImpl,
  MAX_CAUGHT_STREAMING_CHUNKS,
  StopWatchingStreamingOutputNodeImpl,
  CatchStreamingChunksNodeImpl,
  WatchStreamingOutputNodeImpl,
  type InternalProcessContext,
  type PortId,
} from '../../../src/index.js';

describe('WatchStreamingOutputNode', () => {
  it('places every streaming node in the Streaming group only', () => {
    for (const implementation of [
      StreamValueNodeImpl,
      CatchStreamingChunksNodeImpl,
      WatchStreamingOutputNodeImpl,
      StopWatchingStreamingOutputNodeImpl,
    ]) {
      assert.deepEqual(implementation.getUIData().group, ['Streaming']);
    }
  });

  it('changes Watch display names without changing saved node types', () => {
    assert.equal(WatchStreamingOutputNodeImpl.create().type, 'watchStreamingOutput');
    assert.equal(StopWatchingStreamingOutputNodeImpl.create().type, 'stopWatchingStreamingOutput');
    assert.equal(WatchStreamingOutputNodeImpl.create().title, 'Watch streaming');
    assert.equal(StopWatchingStreamingOutputNodeImpl.create().title, 'Stop watching streaming');
    assert.equal(WatchStreamingOutputNodeImpl.getUIData().contextMenuTitle, 'Watch streaming');
    assert.equal(StopWatchingStreamingOutputNodeImpl.getUIData().contextMenuTitle, 'Stop watching streaming');
  });

  it('emits one partial update and retains an ordinary output with the same type and value', async () => {
    const node = new StreamValueNodeImpl(StreamValueNodeImpl.create());
    const partials: unknown[] = [];
    const input = { type: 'object' as const, value: { name: 'ready' } };
    const outputs = await node.process(
      { ['value' as PortId]: input },
      { onPartialOutputs: (partial) => partials.push(partial) } as InternalProcessContext,
    );
    assert.deepEqual(partials, [outputs]);
    assert.equal(outputs['value' as PortId], input);
  });

  it('configures a bounded count while keeping the Catch output port stable', () => {
    const node = CatchStreamingChunksNodeImpl.create();
    const implementation = new CatchStreamingChunksNodeImpl(node);
    assert.equal(node.data.count, 1);
    assert.deepEqual(implementation.getOutputDefinitions(), [{ id: 'value', title: 'Value', dataType: 'any' }]);
    assert.deepEqual(implementation.getEditors(), [
      { type: 'number', dataKey: 'count', label: 'Number of chunks', min: 1, max: MAX_CAUGHT_STREAMING_CHUNKS },
    ]);
  });

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

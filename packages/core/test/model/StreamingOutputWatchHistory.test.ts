import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ProcessEvents } from '../../src/model/GraphProcessor.js';
import { StreamingOutputWatchHistory } from '../../src/model/StreamingOutputWatchHistory.js';
import type { GraphRunId } from '../../src/model/ProcessContext.js';

const runtimeSummary = {
  receivedUpdates: 6,
  coalescedUpdates: 0,
  droppedUpdates: 0,
  maximumQueuedUpdates: 1,
};

void describe('StreamingOutputWatchHistory', () => {
  void it('retains the first three started iterations and the latest one while omitting intervening successes', async () => {
    const history = new StreamingOutputWatchHistory();
    const forwarded: string[] = [];
    const start = (index: number) => history.start(`iteration-${index}` as GraphRunId, index);
    const forward = async <K extends keyof ProcessEvents>(event: K, data: ProcessEvents[K]) => {
      forwarded.push(`${event}:${String(data)}`);
    };

    for (let index = 1; index <= 6; index += 1) {
      const iteration = start(index);
      await history.forward(iteration, 'trace', String(index), forward);
      history.complete(iteration);
    }

    const summary = await history.finalize(runtimeSummary, forward);

    assert.deepEqual(forwarded, ['trace:1', 'trace:2', 'trace:3', 'trace:6']);
    assert.deepEqual(summary.retainedIterationUpdateIndexes, [1, 2, 3, 6]);
    assert.equal(summary.omittedIterations, 2);
    assert.deepEqual(summary.selectedIteration, { updateIndex: 6, reason: 'latest' });
  });

  void it('retains the first failure in preference to a later Stop winner or latest iteration', async () => {
    const history = new StreamingOutputWatchHistory();
    const forwarded: string[] = [];
    const forward = async <K extends keyof ProcessEvents>(event: K, data: ProcessEvents[K]) => {
      forwarded.push(`${event}:${String(data)}`);
    };

    for (const index of [1, 2, 3]) {
      const initial = history.start(`iteration-${index}` as GraphRunId, index);
      await history.forward(initial, 'trace', `initial-${index}`, forward);
      history.complete(initial);
    }

    const failure = history.start('iteration-4' as GraphRunId, 4);
    await history.forward(failure, 'trace', 'failure', forward);
    history.fail(failure);
    history.complete(failure);

    const winner = history.start('iteration-5' as GraphRunId, 5);
    await history.forward(winner, 'trace', 'winner', forward);
    history.acceptStop(winner);
    history.complete(winner);

    const summary = await history.finalize(runtimeSummary, forward);

    assert.deepEqual(forwarded, ['trace:initial-1', 'trace:initial-2', 'trace:initial-3', 'trace:failure']);
    assert.deepEqual(summary.retainedIterationUpdateIndexes, [1, 2, 3, 4]);
    assert.deepEqual(summary.selectedIteration, { updateIndex: 4, reason: 'failure' });
    assert.equal(summary.completedIterations, 4);
    assert.equal(summary.failedIterations, 1);
  });

  void it('snapshots a deferred iteration at its original occurrence time', async () => {
    let now = 41_000;
    const history = new StreamingOutputWatchHistory({ now: () => now });
    const forwarded: Array<{ event: keyof ProcessEvents; data: unknown }> = [];
    const forward = async <K extends keyof ProcessEvents>(event: K, data: ProcessEvents[K]) => {
      forwarded.push({ event, data });
    };

    // The first three runs are retained immediately. The fourth is held until
    // finalization, exactly like a later selected Watch iteration.
    for (const index of [1, 2, 3]) {
      const iteration = history.start(`initial-${index}` as GraphRunId, index);
      await history.forward(iteration, 'trace', `initial-${index}`, forward);
      history.complete(iteration);
    }

    const deferred = history.start('deferred' as GraphRunId, 4);
    const payload = {
      outputs: { output: { type: 'object', value: { state: 'at-finish' } } },
    } as unknown as ProcessEvents['nodeFinish'];
    await history.forward(deferred, 'nodeFinish', payload, forward);
    (payload.outputs.output!.value as { state: string }).state = 'mutated-after-finish';
    now = 99_000;
    history.complete(deferred);

    await history.finalize(runtimeSummary, forward);

    const deferredEvent = forwarded.find((event) => event.event === 'nodeFinish')?.data as {
      eventOccurredAt?: number;
      outputs: { output: { value: { state: string } } };
    };
    assert.equal(deferredEvent.eventOccurredAt, 41_000);
    assert.equal(deferredEvent.outputs.output.value.state, 'at-finish');
  });
});

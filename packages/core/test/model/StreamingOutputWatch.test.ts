import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  StreamingOutputWatch,
  streamingOutputWatchDefaults,
  type StreamingOutputWatchSnapshot,
} from '../../src/model/StreamingOutputWatch.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

void describe('StreamingOutputWatch', () => {
  void it('does not start scheduled work after an immediate stop or queue failure', async () => {
    for (const overflow of [false, true]) {
      let runs = 0;
      const failures: Error[] = [];
      const watch = new StreamingOutputWatch(
        { ...streamingOutputWatchDefaults, triggerMode: 'every-update', executionMode: 'sequential', maxQueuedUpdates: 1 },
        async () => { runs += 1; },
        (error) => failures.push(error),
      );
      const snapshot: StreamingOutputWatchSnapshot = { outputs: {}, updateIndex: 1, isFinal: false };
      watch.publish(snapshot);
      if (overflow) {
        watch.publish(snapshot);
        watch.publish(snapshot);
      } else {
        watch.stop();
      }
      await withTimeout(watch.drain(), 'work stopped before the first microtask');
      assert.equal(runs, 0);
      assert.equal(failures.length, overflow ? 1 : 0);
    }
  });

  void it('cancels a run even when its cancellation callback is registered after stop', async () => {
    const started = deferred();
    const register = deferred();
    const cancelled = deferred();
    const watch = new StreamingOutputWatch(
      { ...streamingOutputWatchDefaults, triggerMode: 'every-update', executionMode: 'sequential' },
      async (_snapshot, registerCancel) => {
        started.resolve();
        await register.promise;
        registerCancel(cancelled.resolve);
        await cancelled.promise;
      },
      (error) => assert.fail(error.message),
    );
    watch.publish({ outputs: {}, updateIndex: 1, isFinal: false });
    await started.promise;
    watch.stop();
    register.resolve();
    try {
      await withTimeout(cancelled.promise, 'late cancellation registration');
    } finally {
      cancelled.resolve();
      await watch.drain();
    }
  });

  void it('falls back to finite bounded defaults for malformed persisted settings', async () => {
    const releaseRuns = deferred();
    const defaultConcurrencyReached = deferred();
    let activeRuns = 0;
    let maximumActiveRuns = 0;

    const watch = new StreamingOutputWatch(
      {
        executionMode: 'parallel',
        intervalMs: Number.NaN,
        maxParallelRuns: Number.POSITIVE_INFINITY,
        maxQueuedUpdates: Number.POSITIVE_INFINITY,
        queueOverflowBehavior: 'fail',
        triggerMode: 'every-update',
      },
      async () => {
        activeRuns += 1;
        maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
        if (activeRuns === streamingOutputWatchDefaults.maxParallelRuns) {
          defaultConcurrencyReached.resolve();
        }
        await releaseRuns.promise;
        activeRuns -= 1;
      },
      (error) => assert.fail(error.message),
    );

    for (let updateIndex = 0; updateIndex < streamingOutputWatchDefaults.maxParallelRuns + 1; updateIndex += 1) {
      watch.publish({
        isFinal: false,
        outputs: { value: { type: 'number', value: updateIndex } },
        updateIndex,
      } satisfies StreamingOutputWatchSnapshot);
    }

    await withTimeout(defaultConcurrencyReached.promise, 'the bounded default watch concurrency');
    assert.equal(maximumActiveRuns, streamingOutputWatchDefaults.maxParallelRuns);

    releaseRuns.resolve();
    await withTimeout(watch.drain(), 'the drained bounded watch');
    assert.equal(maximumActiveRuns, streamingOutputWatchDefaults.maxParallelRuns);
  });

  void it('counts an interval snapshot superseded by the final output as coalesced', async () => {
    const processedUpdates: number[] = [];
    const watch = new StreamingOutputWatch(
      {
        ...streamingOutputWatchDefaults,
        triggerMode: 'interval',
        intervalMs: 1_000,
      },
      async (snapshot) => {
        processedUpdates.push(snapshot.updateIndex);
      },
      (error) => assert.fail(error.message),
      { requiresAcceptedStop: false },
    );

    watch.publish({ outputs: {}, updateIndex: 1, isFinal: false });
    watch.finish({ outputs: {}, updateIndex: 2, isFinal: true });

    await withTimeout(watch.drain(), 'the final interval watch snapshot');
    assert.deepEqual(processedUpdates, [2]);
    assert.deepEqual(watch.runtimeSummary, {
      receivedUpdates: 2,
      coalescedUpdates: 1,
      droppedUpdates: 0,
      maximumQueuedUpdates: 1,
    });
  });

  void it('preserves the winning run until a later cancellation stops it exactly once', async () => {
    const started = deferred();
    const register = deferred();
    const finished = deferred();
    let cancellations = 0;
    const watch = new StreamingOutputWatch({}, async (_snapshot, registerCancel) => {
      started.resolve();
      await register.promise;
      registerCancel(() => { cancellations += 1; finished.resolve(); });
      await finished.promise;
    }, (error) => assert.fail(error.message));
    watch.publish({ outputs: {}, updateIndex: 1, isFinal: false });
    await started.promise;
    watch.stop(1);
    register.resolve();
    await Promise.resolve();
    assert.equal(cancellations, 0);
    watch.stop();
    watch.stop();
    await withTimeout(watch.drain(), 'winning run cancelled by its owner');
    assert.equal(cancellations, 1);
  });

  void it('retains the bounded default queue for a manually inflated persisted limit', async () => {
    const firstRunStarted = deferred();
    const releaseFirstRun = deferred();
    let failure: Error | undefined;
    const watch = new StreamingOutputWatch(
      {
        executionMode: 'sequential',
        intervalMs: streamingOutputWatchDefaults.intervalMs,
        maxParallelRuns: streamingOutputWatchDefaults.maxParallelRuns,
        maxQueuedUpdates: Number.POSITIVE_INFINITY,
        queueOverflowBehavior: 'fail',
        triggerMode: 'every-update',
      },
      async () => {
        firstRunStarted.resolve();
        await releaseFirstRun.promise;
      },
      (error) => {
        failure = error;
      },
    );

    watch.publish({
      isFinal: false,
      outputs: { value: { type: 'number', value: 0 } },
      updateIndex: 0,
    });
    await withTimeout(firstRunStarted.promise, 'the first queued watch run');

    for (let updateIndex = 1; updateIndex <= streamingOutputWatchDefaults.maxQueuedUpdates + 1; updateIndex += 1) {
      watch.publish({
        isFinal: false,
        outputs: { value: { type: 'number', value: updateIndex } },
        updateIndex,
      });
    }

    assert.match(failure?.message ?? '', /32-update queue limit/);
    assert.equal(watch.stopped, true);
    assert.equal(watch.runtimeSummary.failureKind, 'queue-overflow');
    releaseFirstRun.resolve();
    await withTimeout(watch.drain(), 'the stopped bounded watch');
  });

  void it('reports a missing Stop as a coordinator failure without inventing a child failure', async () => {
    const failures: Error[] = [];
    const watch = new StreamingOutputWatch(
      streamingOutputWatchDefaults,
      async () => undefined,
      (error) => failures.push(error),
    );

    watch.finish({ outputs: {}, updateIndex: 1, isFinal: true });
    await withTimeout(watch.drain(), 'the final watch snapshot without Stop');

    assert.match(failures[0]?.message ?? '', /before Stop Watching Streaming Output accepted a value/);
    assert.deepEqual(watch.runtimeSummary, {
      receivedUpdates: 1,
      coalescedUpdates: 0,
      droppedUpdates: 0,
      maximumQueuedUpdates: 1,
      failureKind: 'missing-stop',
    });
  });

  void it('drops only the incoming update when its bounded queue is full', async () => {
    const firstRunStarted = deferred();
    const releaseFirstRun = deferred();
    const processedUpdates: number[] = [];
    const failures: Error[] = [];
    const watch = new StreamingOutputWatch(
      {
        executionMode: 'sequential',
        intervalMs: streamingOutputWatchDefaults.intervalMs,
        maxParallelRuns: streamingOutputWatchDefaults.maxParallelRuns,
        maxQueuedUpdates: 1,
        queueOverflowBehavior: 'drop',
        triggerMode: 'every-update',
      },
      async (snapshot) => {
        processedUpdates.push(snapshot.updateIndex);
        if (snapshot.updateIndex === 0) {
          firstRunStarted.resolve();
          await releaseFirstRun.promise;
        }
      },
      (error) => failures.push(error),
      { requiresAcceptedStop: false },
    );

    watch.publish({
      isFinal: false,
      outputs: { value: { type: 'number', value: 0 } },
      updateIndex: 0,
    });
    await withTimeout(firstRunStarted.promise, 'the first watch run');

    watch.publish({
      isFinal: false,
      outputs: { value: { type: 'number', value: 1 } },
      updateIndex: 1,
    });
    watch.publish({
      isFinal: false,
      outputs: { value: { type: 'number', value: 2 } },
      updateIndex: 2,
    });

    releaseFirstRun.resolve();
    await withTimeout(watch.drain(), 'the dropped-update watch');

    assert.deepEqual(processedUpdates, [0, 1]);
    assert.deepEqual(failures, []);
    assert.equal(watch.stopped, false);
  });

  void it('retains the final snapshot by replacing the stalest queued partial in drop mode', async () => {
    const firstRunStarted = deferred();
    const releaseFirstRun = deferred();
    const processedUpdates: number[] = [];
    const failures: Error[] = [];
    const watch = new StreamingOutputWatch(
      {
        executionMode: 'sequential',
        intervalMs: streamingOutputWatchDefaults.intervalMs,
        maxParallelRuns: streamingOutputWatchDefaults.maxParallelRuns,
        maxQueuedUpdates: 1,
        queueOverflowBehavior: 'drop',
        triggerMode: 'every-update',
      },
      async (snapshot) => {
        processedUpdates.push(snapshot.updateIndex);
        if (snapshot.updateIndex === 0) {
          firstRunStarted.resolve();
          await releaseFirstRun.promise;
        }
      },
      (error) => failures.push(error),
      { requiresAcceptedStop: false },
    );

    watch.publish({
      isFinal: false,
      outputs: { value: { type: 'number', value: 0 } },
      updateIndex: 0,
    });
    await withTimeout(firstRunStarted.promise, 'the first watch run');
    watch.publish({
      isFinal: false,
      outputs: { value: { type: 'number', value: 1 } },
      updateIndex: 1,
    });
    watch.finish({
      isFinal: true,
      outputs: { value: { type: 'number', value: 2 } },
      updateIndex: 2,
    });

    releaseFirstRun.resolve();
    await withTimeout(watch.drain(), 'the final snapshot retained through queue overflow');

    assert.deepEqual(processedUpdates, [0, 2]);
    assert.deepEqual(failures, []);
  });
});

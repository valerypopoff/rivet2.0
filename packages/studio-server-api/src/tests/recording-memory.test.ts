import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionRecorder, type GraphProcessor, type PortId } from '@valerypopoff/rivet2-core';
import { RecordingMemoryBudget, RecordingMemoryCapacityError } from '../routes/workflows/recording-memory.js';

void test('native codec workspace shares the byte limit and is released after failure', async () => {
  const budget = new RecordingMemoryBudget({ bytes: 32 });
  await budget.workspace(24, async () => {
    assert.equal(budget.snapshot().estimatedBytes, 24);
    assert.equal(budget.snapshot().captures, 0);
    await assert.rejects(
      budget.workspace(16, async () => {}),
      RecordingMemoryCapacityError,
    );
  });
  await assert.rejects(
    budget.workspace(32, async () => {
      throw new Error('codec failed');
    }),
    /codec failed/,
  );
  assert.equal(budget.snapshot().estimatedBytes, 0);
  assert.equal(budget.snapshot().captures, 0);
});

function capture(budget?: RecordingMemoryBudget) {
  let listener: (type: string, data: unknown) => void = () => {};
  let finish: () => void = () => {};
  const recorder = new ExecutionRecorder(budget ? { createCapturePolicy: budget.createCapturePolicy } : {});
  recorder.record({
    onAny(callback: typeof listener) {
      listener = callback;
      return () => {
        listener = () => {};
      };
    },
    on(_event: string, callback: () => void) {
      finish = callback;
      return () => {};
    },
  } as unknown as GraphProcessor);
  return {
    recorder,
    emit(value: unknown) {
      listener('nodeFinish', {
        node: { id: 'node' },
        processId: 'process',
        outputs: { output: { type: 'any', value } },
      });
    },
    finish: () => finish(),
  };
}

void test('capture limits discard only replay data, keep terminal handling and share capacity across roots', () => {
  const budget = new RecordingMemoryBudget({ bytes: 5000, captureBytes: 4500 });
  const first = capture(budget),
    second = capture(budget);
  first.emit('a'.repeat(1000));
  assert.equal(first.recorder.events.length, 1);
  second.emit('b'.repeat(1000));
  assert.equal(second.recorder.captureDiscarded, true);
  assert.equal(second.recorder.events.length, 0);
  assert.throws(() => second.recorder.serialize(), /unavailable/);
  assert.doesNotThrow(() => {
    second.emit('later');
    second.finish();
  });
  assert.equal(first.recorder.captureDiscarded, false);
  assert.ok(budget.snapshot().estimatedBytes > 0);
  budget.discard(first.recorder);
  budget.discard(first.recorder);
  assert.equal(budget.snapshot().estimatedBytes, 0);
  assert.equal(budget.snapshot().captures, 0);
});

void test('captures account backing buffers and event counts, without reading accessors or proxy traps', () => {
  const budget = new RecordingMemoryBudget({ captureBytes: 8000, events: 1 });
  const largeView = capture(budget);
  largeView.emit(new Uint8Array(new ArrayBuffer(16000), 0, 1));
  assert.equal(largeView.recorder.captureDiscarded, true);
  class CustomView extends Uint8Array {
    get buffer(): ArrayBuffer {
      throw new Error('User getter must not run');
    }
  }
  const customView = capture(budget);
  customView.emit(new CustomView(new ArrayBuffer(16000), 0, 1));
  assert.equal(customView.recorder.captureDiscarded, true);
  let reads = 0;
  const normal = capture(budget);
  normal.emit({
    get value() {
      reads++;
      return 'unchanged';
    },
  });
  assert.equal(reads, 0);
  normal.emit('second event');
  assert.equal(normal.recorder.captureDiscarded, true);
  const proxy = capture(budget);
  proxy.emit(
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('Must not inspect the proxy');
        },
      },
    ),
  );
  assert.equal(proxy.recorder.captureDiscarded, false);
  budget.discard(proxy.recorder);
  const previousStackFormatter = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = () => {
      reads++;
      return 'formatted';
    };
    const error = capture(budget);
    error.emit(new Error('opaque error output'));
    assert.equal(reads, 0, 'Accounting must not format lazy native error stacks.');
    budget.discard(error.recorder);
  } finally {
    Error.prepareStackTrace = previousStackFormatter;
  }
  assert.equal(budget.snapshot().captures, 0);
});

void test('settled capture rechecks mutable data and rejects before serializing oversized data', () => {
  const budget = new RecordingMemoryBudget({ bytes: 15000, captureBytes: 4000 });
  const run = capture(budget);
  const value = { text: 'small' };
  run.emit(value);
  assert.equal(budget.retain(run.recorder, []), true);
  value.text = 'large'.repeat(1000);
  assert.throws(() => budget.serialize(run.recorder), RecordingMemoryCapacityError);
  assert.equal(run.recorder.captureDiscarded, true);
  assert.equal(budget.snapshot().estimatedBytes, 0);
  assert.equal(budget.snapshot().captures, 0);

  const replaced = capture(budget);
  replaced.emit('small');
  const event = replaced.recorder.events[0]!;
  assert.equal(event.type, 'nodeFinish');
  if (event.type === 'nodeFinish')
    event.data.outputs = { ['large' as PortId]: { type: 'string', value: 'x'.repeat(5000) } };
  assert.throws(() => budget.serialize(replaced.recorder), RecordingMemoryCapacityError);
  assert.equal(budget.snapshot().captures, 0);
});

void test('settled queue admission rechecks intermediate values mutated after their last event', () => {
  const budget = new RecordingMemoryBudget({ bytes: 15000, captureBytes: 4000 });
  const run = capture(budget);
  const value = { text: 'small' };
  run.emit(value);
  value.text = 'large'.repeat(1000);
  // The completed graph may only return a scalar while an earlier event still
  // retains the mutated object. Do not queue it using its old capture estimate.
  assert.equal(budget.retain(run.recorder, []), false);
  assert.equal(run.recorder.captureDiscarded, true);
  assert.equal(budget.snapshot().estimatedBytes, 0);
  assert.equal(budget.snapshot().captures, 0);
});

void test('native collections, array properties and error causes cannot hide retained buffers', () => {
  class HostileMap extends Map<unknown, unknown> {
    get size(): number {
      throw new Error('User size getter must not run');
    }
    forEach(): never {
      throw new Error('User iterator must not run');
    }
  }
  const large = new Uint8Array(16000);
  for (const value of [
    new HostileMap([['buffer', large]]),
    new Set([large]),
    new Error('failed', { cause: large }),
    Object.defineProperty({}, 'hidden', { value: large }),
    { [Symbol('hidden')]: large },
    Object.assign([], { hidden: large }),
    Object.defineProperty([], Symbol('hidden'), { value: large }),
    Object.setPrototypeOf([large], null),
    Object.setPrototypeOf(new Map([['buffer', large]]), Array.prototype),
  ]) {
    const budget = new RecordingMemoryBudget({ captureBytes: 8000 });
    const run = capture(budget);
    run.emit(value);
    assert.equal(run.recorder.captureDiscarded, true);
    assert.equal(budget.snapshot().captures, 0);
  }
  const cyclic = new HostileMap();
  cyclic.set('self', cyclic);
  const budget = new RecordingMemoryBudget();
  const run = capture(budget);
  run.emit(cyclic);
  assert.equal(run.recorder.captureDiscarded, false);
  assert.doesNotThrow(() => budget.serialize(run.recorder));
  budget.discard(run.recorder);
});

void test('oversized arrays are rejected before allocating their property-key list', (t) => {
  const array = new Array(10001);
  let enumeratedArray = false;
  for (const name of ['getOwnPropertyNames', 'getOwnPropertySymbols'] as const) {
    const original = Object[name];
    t.mock.method(Object, name, (value: object) => {
      if (value === array) enumeratedArray = true;
      return original(value);
    });
  }
  const budget = new RecordingMemoryBudget({ inspectedValues: 10000 });
  const run = capture(budget);
  run.emit(array);
  assert.equal(run.recorder.captureDiscarded, true);
  assert.equal(enumeratedArray, false);
});

void test('unchanged codec preserves custom toJSON, binary data and long strings without a worker copy', () => {
  const budget = new RecordingMemoryBudget();
  const run = capture(budget);
  class Custom {
    toJSON() {
      return { label: 'public' };
    }
  }
  run.emit({ custom: new Custom(), bytes: new Uint8Array([1, 2, 3]), text: 'text'.repeat(100) });
  const expected = ExecutionRecorder.deserializeFromString(run.recorder.serialize()).getRecording();
  const actual = ExecutionRecorder.deserializeFromString(budget.serialize(run.recorder)).getRecording();
  assert.deepEqual(actual, expected);
  assert.ok(budget.snapshot().estimatedBytes > 0, 'Persistence still owns its bytes after encoding.');
  budget.discard(run.recorder);
  assert.equal(budget.snapshot().estimatedBytes, 0);
});

void test('prepared writes hold capacity until actual settlement, including failed IO', async () => {
  const budget = new RecordingMemoryBudget({ bytes: 5000 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = budget.prepared(['payload'], async () => {
    await gate;
    throw new Error('storage offline');
  });
  assert.equal(budget.snapshot().captures, 1);
  await assert.rejects(
    budget.prepared(['another'], async () => {}),
    RecordingMemoryCapacityError,
  );
  assert.equal(budget.snapshot().captures, 1, 'Rejected work cannot release the first write.');
  release();
  await assert.rejects(first, /storage offline/);
  assert.equal(budget.snapshot().captures, 0);
  assert.equal(budget.snapshot().estimatedBytes, 0);
});

void test('a hostile thrown value cannot bypass capture/write cleanup or replace the original failure', async () => {
  const budget = new RecordingMemoryBudget();
  const run = capture(budget);
  run.emit('recorded');
  let inspected = false;
  const failure = new Proxy(
    {},
    {
      getPrototypeOf() {
        inspected = true;
        throw new Error('Do not inspect the thrown value');
      },
    },
  );
  run.recorder.serialize = () => {
    throw failure;
  };
  assert.throws(
    () => budget.serialize(run.recorder),
    (error) => error === failure,
  );
  assert.equal(budget.snapshot().captures, 0);
  assert.equal(budget.snapshot().estimatedBytes, 0);
  await assert.rejects(
    budget.prepared([], () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(budget.snapshot().captures, 0);
  assert.equal(budget.snapshot().estimatedBytes, 0);
  assert.equal(inspected, false);
});

void test('constructor admission and policy errors cannot prevent graph events from completing', () => {
  const denied = new ExecutionRecorder({
    createCapturePolicy: () => {
      throw new Error('no capacity');
    },
  });
  assert.equal(denied.captureDiscarded, true);
  assert.doesNotThrow(() => denied.discard());
  const normal = capture();
  normal.emit('default Core behavior');
  assert.equal(normal.recorder.captureDiscarded, false);
  assert.equal(normal.recorder.events.length, 1);
});

void test('each rejected admission is counted once across capture and prepared writes', async () => {
  const budget = new RecordingMemoryBudget({ captures: 1 });
  const accepted = capture(budget);
  assert.equal(capture(budget).recorder.captureDiscarded, true);
  await assert.rejects(
    budget.prepared([], async () => {}),
    RecordingMemoryCapacityError,
  );
  assert.equal(budget.retain(capture().recorder, 'payload'), false);
  assert.throws(() => budget.serialize(capture().recorder), RecordingMemoryCapacityError);
  assert.equal(budget.snapshot().rejections, 4);
  budget.discard(accepted.recorder);
  assert.equal(budget.snapshot().captures, 0);
});

void test('the writer borrows a capture reservation until its owner releases the settled recording', async () => {
  const budget = new RecordingMemoryBudget();
  const run = capture(budget);
  run.emit('recorded');
  budget.serialize(run.recorder);
  const before = budget.snapshot().estimatedBytes;
  await budget.prepared(
    [],
    async () => {
      assert.equal(budget.snapshot().captures, 1);
      assert.ok(budget.snapshot().estimatedBytes >= before * 2);
    },
    run.recorder,
  );
  assert.equal(budget.snapshot().captures, 1);
  assert.ok(budget.snapshot().estimatedBytes >= before * 2);
  const once = budget.snapshot().estimatedBytes;
  await budget.prepared([], async () => {}, run.recorder);
  assert.equal(budget.snapshot().estimatedBytes, once, 'An identical write retry reuses its reservation.');
  budget.serialize(run.recorder);
  const reencoded = budget.snapshot().estimatedBytes;
  await budget.prepared([], async () => {}, run.recorder);
  assert.ok(budget.snapshot().estimatedBytes >= reencoded * 2, 'A fresh encoding needs fresh write headroom.');
  await assert.rejects(
    budget.prepared(
      [],
      () => {
        throw new Error('writer setup failed');
      },
      run.recorder,
    ),
    /writer setup failed/,
  );
  assert.equal(budget.snapshot().rejections, 0, 'A writer failure is not a capacity rejection.');
  budget.discard(run.recorder);
  assert.equal(budget.snapshot().estimatedBytes, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHaProofTiming } from './lib/ha-proof-timing.mjs';

test('overlapping observation spans are counted once and leave actual gaps visible', async () => {
  let time = 0,
    finishA,
    finishB;
  const timer = createHaProofTiming({ now: () => time, artifact: async () => {}, log: () => {} });
  try {
    const a = timer.measure(
      'read-a',
      () =>
        new Promise((resolve) => {
          finishA = resolve;
        }),
    );
    time = 10;
    const b = timer.measure(
      'read-b',
      () =>
        new Promise((resolve) => {
          finishB = resolve;
        }),
    );
    time = 20;
    finishA();
    await a;
    time = 30;
    finishB();
    await b;
    time = 40;
    const result = await timer.close();
    assert.equal(result.elapsedMs, 40);
    assert.equal(result.measuredMs, 30);
    assert.equal(result.unmeasuredMs, 10);
    assert.deepEqual(
      result.phases.map((p) => p.elapsedMs),
      [20, 20],
    );
  } finally {
    await timer.close();
  }
});

test('overlapping phases serialize timing writes and a failed write cannot prevent the final receipt', async () => {
  let releaseWrite;
  const started = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let active = 0,
    peak = 0,
    calls = 0,
    final;
  const timer = createHaProofTiming({
    log: () => {},
    artifact: async (_name, bytes) => {
      active++;
      peak = Math.max(peak, active);
      const call = ++calls;
      try {
        if (call === 1) {
          await started;
          throw Error('Timing output unavailable');
        }
        final = JSON.parse(bytes);
      } finally {
        active--;
      }
    },
  });
  try {
    const a = timer.measure('a', async () => {});
    const b = timer.measure('b', async () => {});
    await new Promise(setImmediate);
    releaseWrite();
    await Promise.all([a, b]);
    timer.status('complete');
    await timer.close();
    assert.equal(peak, 1, 'Concurrent writes to the same receipt can truncate or overwrite one another');
    assert.equal(active, 0);
    assert.equal(calls, 3);
    assert.equal(final.status, 'complete');
    assert.deepEqual(
      final.phases.map((phase) => phase.outcome),
      ['passed', 'passed'],
    );
  } finally {
    releaseWrite();
    await timer.close();
  }
});

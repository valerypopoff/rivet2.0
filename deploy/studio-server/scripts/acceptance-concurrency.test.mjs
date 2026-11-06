import test from 'node:test';
import assert from 'node:assert/strict';
import { settleAcceptanceReads, runLongProbeCohorts } from './lib/acceptance-concurrency.mjs';

test('acceptance overlaps independent journeys and joins a slow sibling after failure', async () => {
  let release,
    settled = false,
    returned = false;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const work = settleAcceptanceReads([
    async () => {
      throw Error('browser failed');
    },
    async () => {
      await slow;
      settled = true;
      return 'workflow';
    },
  ]).finally(() => {
    returned = true;
  });
  const outcome = assert.rejects(work, /acceptance journeys failed/);
  await new Promise(setImmediate);
  assert.equal(returned, false);
  release();
  await outcome;
  assert.equal(settled, true);
  assert.deepEqual(await settleAcceptanceReads([async () => 1, async () => 2]), [1, 2]);
});

test('closing long admission finishes the current cohort and keeps the observer alive until final stop', async () => {
  let stop = false,
    stopLong = false,
    count = 0,
    wake,
    finished = false;
  const task = runLongProbeCohorts({
    shouldStop: async () => stop,
    shouldStopLong: async () => stopLong,
    runCohort: async () => {
      count++;
      stopLong = true;
    },
    wait: () =>
      new Promise((resolve) => {
        wake = resolve;
      }),
  }).then(() => {
    finished = true;
  });
  await new Promise(setImmediate);
  assert.equal(count, 1);
  assert.equal(finished, false);
  stop = true;
  wake();
  await task;
  assert.equal(finished, true);
});

test('final stop cannot settle the observer before an already accepted cohort finishes', async () => {
  let stop = false,
    release,
    finished = false;
  const accepted = new Promise((resolve) => {
    release = resolve;
  });
  const task = runLongProbeCohorts({
    shouldStop: async () => stop,
    shouldStopLong: async () => false,
    runCohort: () => accepted,
    wait: async () => {},
  }).then(() => {
    finished = true;
  });
  await new Promise(setImmediate);
  stop = true;
  await new Promise(setImmediate);
  assert.equal(finished, false);
  release();
  await task;
  assert.equal(finished, true);
});

test('a closed admission gate starts no extra cohort and still waits for final observer shutdown', async () => {
  let stop = false,
    waits = 0;
  await runLongProbeCohorts({
    shouldStop: async () => stop,
    shouldStopLong: async () => true,
    runCohort: async () => assert.fail('No late long batch'),
    wait: async () => {
      waits++;
      stop = true;
    },
  });
  assert.equal(waits, 1);
});

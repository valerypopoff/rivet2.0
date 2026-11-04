import test from 'node:test';
import assert from 'node:assert/strict';
import { readConcurrently } from './lib/read-concurrently.mjs';

const deferred = () => Promise.withResolvers();

test('observations overlap with a four-read ceiling and preserve result order', async () => {
  const gates = Array.from({ length: 9 }, deferred);
  const started = [];
  let active = 0;
  let maximum = 0;
  const result = readConcurrently(
    gates.map((gate, index) => async () => {
      started.push(index);
      maximum = Math.max(maximum, ++active);
      await gate.promise;
      active--;
      return index;
    }),
  );
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[3].resolve();
  await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  for (const gate of gates) gate.resolve();
  assert.deepEqual(
    await result,
    gates.map((_, index) => index),
  );
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.deepEqual(await readConcurrently([]), []);
});

test('a failed read stops queued observations and waits for active siblings before rejection', async () => {
  const gates = Array.from({ length: 5 }, deferred);
  const failure = Error('observation failed');
  const started = [];
  let settled = false;
  const result = readConcurrently(
    gates.map((gate, index) => async () => {
      started.push(index);
      return gate.promise;
    }),
  );
  const rejected = assert
    .rejects(result, (error) => error === failure)
    .then(() => {
      settled = true;
    });
  gates[1].reject(failure);
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[0].resolve();
  gates[2].reject(Error('second read failed'));
  gates[3].resolve();
  await rejected;
  assert.equal(settled, true);
  assert.deepEqual(started, [0, 1, 2, 3]);
  await assert.rejects(
    readConcurrently([
      () => {
        throw failure;
      },
    ]),
    (error) => error === failure,
  );
});

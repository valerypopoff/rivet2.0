import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupVerification } from './verification-cleanup.mjs';

test('a cleanup failure cannot prevent later owned resources from being cleaned', async () => {
  const removed = [];
  const failure = new Error('volume still in use');
  await assert.rejects(
    cleanupVerification([
      () => {
        throw failure;
      },
      () => removed.push('second volume'),
      () => removed.push('signal listeners'),
    ]),
    (error) => error instanceof AggregateError && error.errors[0] === failure,
  );
  assert.deepEqual(removed, ['second volume', 'signal listeners']);
});

test('cleanup diagnostics do not replace the original verification failure', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (error) => warnings.push(error));
  const original = new Error('browser assertion failed');
  await cleanupVerification(
    [
      () => {
        throw new Error('cleanup failed');
      },
    ],
    original,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /cleanup failed/);
});

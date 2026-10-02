import assert from 'node:assert/strict';
import test from 'node:test';
import { runLatestProjectActivation, supersedeProjectActivation } from './projectActivationCoordinator.js';

test('new selections supersede obsolete preparation without waiting for it', async () => {
  const owner = {};
  const events: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = runLatestProjectActivation(owner, async (isCurrent) => {
    events.push('first-start');
    started();
    await gate;
    assert.equal(isCurrent(), false);
    events.push('first-end');
    return false;
  });
  await start;
  const skipped = runLatestProjectActivation(owner, async () => {
    assert.fail('An obsolete queued restore must not start');
  });
  const latest = runLatestProjectActivation(owner, async (isCurrent) => {
    assert.equal(isCurrent(), true);
    events.push('latest');
    return true;
  });
  assert.equal(await latest, true);
  assert.deepEqual(events, ['first-start', 'latest']);
  assert.equal(await first, false);
  release();
  assert.deepEqual(await Promise.all([first, skipped, latest]), [false, false, true]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['first-start', 'latest', 'first-end']);
});

test('a preparation deadline releases even a provider that ignores cancellation', async () => {
  const owner = {};
  let signal: AbortSignal | undefined;
  assert.equal(
    await runLatestProjectActivation(
      owner,
      async (_current, nextSignal) => {
        signal = nextSignal;
        return new Promise<boolean>(() => {});
      },
      { timeoutMs: 5 },
    ),
    false,
  );
  assert.equal(signal?.aborted, true);
  assert.equal(await runLatestProjectActivation(owner, async () => true), true);
});

test('failed activation does not poison subsequent selections or other stores', async () => {
  const owner = {};
  await assert.rejects(
    runLatestProjectActivation(owner, async () => {
      throw new Error('IO failed');
    }),
    /IO failed/,
  );
  assert.equal(await runLatestProjectActivation(owner, async () => true), true);
  assert.equal(await runLatestProjectActivation({}, async () => true), true);
});

test('selecting a loading placeholder cancels queued restores without starting another load', async () => {
  const owner = {};
  const pending = runLatestProjectActivation(owner, async () => {
    assert.fail('Placeholder selection must supersede this queued restore');
  });
  supersedeProjectActivation(owner);
  assert.equal(await pending, false);
  assert.equal(await runLatestProjectActivation(owner, async () => true), true);
});

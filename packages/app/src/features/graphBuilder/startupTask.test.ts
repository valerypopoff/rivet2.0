import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForGraphBuilderStartupTask } from './startupTask.js';

test('startup wait returns promptly when an injected task ignores cancellation', async () => {
  const abortController = new AbortController();
  const neverSettles = new Promise<never>(() => undefined);
  const waiting = waitForGraphBuilderStartupTask(neverSettles, abortController.signal);

  abortController.abort();

  assert.deepEqual(await waiting, { status: 'aborted' });
});

test('startup wait observes a late rejection after cancellation', async () => {
  const abortController = new AbortController();
  let rejectTask: (error: unknown) => void = () => undefined;
  const task = new Promise<never>((_resolve, reject) => {
    rejectTask = reject;
  });
  const waiting = waitForGraphBuilderStartupTask(task, abortController.signal);

  abortController.abort();
  assert.deepEqual(await waiting, { status: 'aborted' });

  rejectTask(new Error('late provider failure'));
  await Promise.resolve();
});

test('startup wait preserves successful values and task failures before cancellation', async () => {
  assert.deepEqual(
    await waitForGraphBuilderStartupTask(Promise.resolve({ setting: 'value' }), new AbortController().signal),
    {
      status: 'completed',
      value: { setting: 'value' },
    },
  );

  await assert.rejects(
    waitForGraphBuilderStartupTask(Promise.reject(new Error('settings failed')), new AbortController().signal),
    /settings failed/,
  );
});

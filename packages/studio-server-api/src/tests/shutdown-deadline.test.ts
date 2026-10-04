import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleBeforeDeadline } from '../shutdown-deadline.js';

test('settled and rejected operations release their shutdown deadline timers', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const before = timers();
  await settleBeforeDeadline(Promise.resolve(), Date.now() + 120_000);
  assert.equal(timers(), before);
  await assert.rejects(
    settleBeforeDeadline(Promise.reject(new Error('fixture failure')), Date.now() + 120_000),
    /fixture failure/,
  );
  assert.equal(timers(), before);
});
test('an unsettled operation releases the timer when its deadline expires', async () => {
  await settleBeforeDeadline(new Promise(() => {}), Date.now() + 10);
});

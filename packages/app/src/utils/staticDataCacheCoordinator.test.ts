import assert from 'node:assert/strict';
import test from 'node:test';
import { runStaticDataCacheOperation } from './staticDataCacheCoordinator.js';

test('cache operations serialize per provider without blocking other workspaces', async () => {
  const cache = {};
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const clear = runStaticDataCacheOperation(cache, async () => {
    events.push('clear');
    await gate;
    events.push('hydrate');
  });
  const edit = runStaticDataCacheOperation(cache, async () => {
    events.push('edit');
  });
  await runStaticDataCacheOperation({}, async () => {
    events.push('independent');
  });
  assert.deepEqual(events, ['clear', 'independent']);
  release();
  await Promise.all([clear, edit]);
  assert.deepEqual(events, ['clear', 'independent', 'hydrate', 'edit']);
});

test('cache failure is observable but cannot poison subsequent operations', async () => {
  const cache = {};
  await assert.rejects(
    runStaticDataCacheOperation(cache, async () => {
      throw new Error('Cache unavailable');
    }),
    /Cache unavailable/,
  );
  assert.equal(await runStaticDataCacheOperation(cache, async () => 'restored'), 'restored');
});

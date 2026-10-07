import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  createWebAppSocketPolicyLookupCoordinator,
  createWebAppSocketPolicyRecheckScheduler,
} from '../web-app-action-websocket.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

test('web-app socket policy lookups share background reads but never reuse them for fresh commands', async () => {
  const lookups = createWebAppSocketPolicyLookupCoordinator(1, 100);
  const first = deferred<string>();
  let reads = 0;

  const background = lookups.read('app', async () => {
    reads += 1;
    return first.promise;
  });
  const shared = lookups.read('app', async () => {
    reads += 1;
    return 'unexpected';
  });

  assert.strictEqual(shared, background);
  await assert.rejects(() => lookups.read('app', async () => 'fresh', { fresh: true }), /capacity is exhausted/);
  assert.equal(reads, 1);

  first.resolve('current');
  assert.equal(await background, 'current');
  assert.equal(await lookups.read('app', async () => 'fresh', { fresh: true }), 'fresh');
  lookups.dispose();
});

test('timed-out policy lookups retain their slot until the underlying read settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lookups = createWebAppSocketPolicyLookupCoordinator(1, 10);
  t.after(() => lookups.dispose());
  const first = deferred<string>();
  const pending = lookups.read('app', () => first.promise);

  const timedOut = assert.rejects(() => pending, /timed out/);
  t.mock.timers.tick(9);
  await assert.rejects(() => lookups.read('other-app', async () => 'unexpected'), /capacity is exhausted/);
  t.mock.timers.tick(1);
  await timedOut;
  await assert.rejects(
    () => lookups.read('other-app', async () => 'unexpected', { fresh: true }),
    /capacity is exhausted/,
  );

  first.resolve('late');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await lookups.read('other-app', async () => 'available', { fresh: true }), 'available');
  lookups.dispose();
});

test('one recheck scheduler serves every subscribed socket and stops when they leave', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const scheduler = createWebAppSocketPolicyRecheckScheduler(5);
  let first = 0;
  let second = 0;
  const unsubscribeFirst = scheduler.subscribe(() => {
    first += 1;
  });
  const unsubscribeSecond = scheduler.subscribe(() => {
    second += 1;
  });
  t.after(unsubscribeFirst);
  t.after(unsubscribeSecond);

  t.mock.timers.tick(4);
  assert.equal(first, 0);
  assert.equal(second, 0);
  t.mock.timers.tick(1);
  assert.equal(first, 1);
  assert.equal(second, 1);

  unsubscribeFirst();
  t.mock.timers.tick(5);
  assert.equal(first, 1, 'The departed subscriber is not rechecked.');
  assert.equal(second, 2, 'Remaining subscribers still share the next tick.');
  unsubscribeSecond();
  const settledFirst = first;
  const settledSecond = second;
  t.mock.timers.tick(10_000);
  assert.equal(first, settledFirst);
  assert.equal(second, settledSecond);
});

test('one failing recheck subscriber does not prevent the remaining sockets from being checked', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const scheduler = createWebAppSocketPolicyRecheckScheduler(5);
  let healthyChecks = 0;
  const stopFailing = scheduler.subscribe(() => {
    throw new Error('simulated socket failure');
  });
  const stopHealthy = scheduler.subscribe(() => {
    healthyChecks += 1;
  });
  t.after(stopFailing);
  t.after(stopHealthy);

  t.mock.timers.tick(5);
  assert.equal(healthyChecks, 1);
  t.mock.timers.tick(5);
  assert.equal(healthyChecks, 2, 'A failed subscriber cannot stop later ticks either.');

  stopFailing();
  stopHealthy();
});

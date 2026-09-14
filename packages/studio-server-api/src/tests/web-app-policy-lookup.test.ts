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
  await assert.rejects(
    () => lookups.read('app', async () => 'fresh', { fresh: true }),
    /capacity is exhausted/,
  );
  assert.equal(reads, 1);

  first.resolve('current');
  assert.equal(await background, 'current');
  assert.equal(await lookups.read('app', async () => 'fresh', { fresh: true }), 'fresh');
  lookups.dispose();
});

test('timed-out policy lookups retain their slot until the underlying read settles', async () => {
  const lookups = createWebAppSocketPolicyLookupCoordinator(1, 10);
  const first = deferred<string>();
  const pending = lookups.read('app', () => first.promise);

  // The production deadline is intentionally unref'ed; retain the test event
  // loop while asserting that deadline rather than making the runtime timer
  // artificially keep a production process alive.
  const timedOut = assert.rejects(() => pending, /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 20));
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

test('one recheck scheduler serves every subscribed socket and stops when they leave', async () => {
  const scheduler = createWebAppSocketPolicyRecheckScheduler(5);
  let first = 0;
  let second = 0;
  const unsubscribeFirst = scheduler.subscribe(() => { first += 1; });
  const unsubscribeSecond = scheduler.subscribe(() => { second += 1; });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(first > 0);
  assert.ok(second > 0);

  unsubscribeFirst();
  unsubscribeSecond();
  const settledFirst = first;
  const settledSecond = second;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(first, settledFirst);
  assert.equal(second, settledSecond);
});

test('one failing recheck subscriber does not prevent the remaining sockets from being checked', async () => {
  const scheduler = createWebAppSocketPolicyRecheckScheduler(5);
  let healthyChecks = 0;
  const stopFailing = scheduler.subscribe(() => {
    throw new Error('simulated socket failure');
  });
  const stopHealthy = scheduler.subscribe(() => {
    healthyChecks += 1;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(healthyChecks > 0);

  stopFailing();
  stopHealthy();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { HA_ROUTING_PROPAGATION_MS, hasHaPublicEndpoint, waitForHaRoutingWithdrawal } from './lib/ha-routing-withdrawal.mjs';

function fixture() {
  let time = 0;
  const pod = { name: 'execution-0', uid: 'owned-uid' };
  const options = {
    pod, publicServices: new Set(['public']), timeoutMs: 10_000,
    clock: { now: () => time, wait: async () => { time += 1000; } },
    observePod: async () => pod,
    readSlices: async () => [],
  };
  return { options, now: () => time };
}
const slices = (ready, service = 'public', uid = 'owned-uid') => [{
  metadata: { labels: { 'kubernetes.io/service-name': service } },
  endpoints: [{ targetRef: { uid }, conditions: { ready } }],
}];

test('routing withdrawal keeps admission open for a full minute after endpoint exclusion', async () => {
  const f = fixture(); let reads = 0;
  f.options.readSlices = async () => { reads++; return []; };
  await waitForHaRoutingWithdrawal(f.options);
  assert.equal(f.now(), HA_ROUTING_PROPAGATION_MS);
  assert.equal(reads, 61, 'do not sleep blindly without rechecking actual endpoint state');
});

test('a returning endpoint resets the propagation observation without extending the deadline', async () => {
  const f = fixture();
  f.options.readSlices = async () => f.now() === 5000 ? slices(true) : [];
  await waitForHaRoutingWithdrawal(f.options);
  assert.equal(f.now(), 66_000);
  const repeated = fixture();
  repeated.options.readSlices = async () => repeated.now() % 20_000 === 19_000 ? slices(true) : [];
  await assert.rejects(waitForHaRoutingWithdrawal(repeated.options), /endpoint withdrawal propagation/);
  assert.equal(repeated.now(), 70_000, 'routing flaps cannot extend the operation indefinitely');
});

for (const ready of [undefined, null, true]) test(`readiness ${ready} is still routable and never fences admission`, async () => {
  const f = fixture(); f.options.readSlices = async () => slices(ready);
  await assert.rejects(waitForHaRoutingWithdrawal(f.options), /endpoint withdrawal propagation/);
  assert.equal(f.now(), 10_000);
});

test('only public Service membership for the exact owner counts', async () => {
  const f = fixture();
  assert.equal(hasHaPublicEndpoint(slices(false), f.options.publicServices, f.options.pod.uid), false);
  f.options.readSlices = async () => [...slices(true, 'headless'), ...slices(true, 'public', 'other-uid')];
  await waitForHaRoutingWithdrawal(f.options);
  assert.equal(f.now(), 60_000);
});

test('owner replacement, missing owner or observation errors abort without fencing admission', async () => {
  for (const replacement of [null, { uid: 'replacement' }]) {
    const f = fixture(); f.options.observePod = async () => f.now() >= 2000 ? replacement : f.options.pod;
    await assert.rejects(waitForHaRoutingWithdrawal(f.options), /owner changed/);
  }
  const f = fixture(); f.options.readSlices = async () => { throw Error('API unavailable'); };
  await assert.rejects(waitForHaRoutingWithdrawal(f.options), /API unavailable/);
});

test('explicit recovery observes a new full window, not a stale sleep receipt', async () => {
  const f = fixture(); await waitForHaRoutingWithdrawal(f.options);
  await waitForHaRoutingWithdrawal(f.options);
  assert.equal(f.now(), 120_000);
});

test('invalid observation inputs fail closed', async () => {
  for (const change of [{ timeoutMs: 0 }, { timeoutMs: NaN }, { pod: {} }, { publicServices: new Set() }])
    await assert.rejects(waitForHaRoutingWithdrawal({ ...fixture().options, ...change }), /Invalid HA endpoint/);
});

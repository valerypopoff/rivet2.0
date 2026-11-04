import test from 'node:test';
import assert from 'node:assert/strict';
import { journalForReleaseOperation } from './lib/release-operation-journal.mjs';
import { readReleaseOperationJournal } from './lib/release-operation-journal-reader.mjs';

const identity = { release: 'rivet', namespace: 'rivet' };
const snapshot = (changes = {}, uid = 'journal-uid') => ({
  uid,
  record: {
    autoscalingProtocol: 1,
    ...identity,
    phase: 'complete',
    resourceVersion: '1',
    leaseExpiresAt: 2000,
    token: 'sample-token',
    runner: 'autoscaler',
    manifestDigest: 'installed-manifest',
    policyDigest: 'installed-policy',
    ...changes,
  },
});
const observe = (values, options = {}) => {
  let time = 1000,
    calls = 0;
  const run = () =>
    readReleaseOperationJournal({
      kind: 'ha',
      identity,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      read: async () => values[Math.min(calls++, values.length - 1)],
      ...options,
    });
  return { run, calls: () => calls, time: () => time };
};

test('HA waits for a completed sampling lease and retains the fresh CAS version', async () => {
  const busy = snapshot(),
    released = snapshot({ leaseExpiresAt: 1000, resourceVersion: '2' });
  assert.throws(() => journalForReleaseOperation(busy.record, 'ha', identity, () => 1000), /owns this release/);
  const f = observe([busy, released]);
  assert.equal(await f.run(), null);
  assert.equal(f.calls(), 2);
  assert.equal(released.record.resourceVersion, '2');
});

test('an unfinished autoscaling operation is rejected immediately', async () => {
  for (const phase of ['scaling', 'fencing', 'withdrawing', 'draining', 'removing', 'unfencing']) {
    const f = observe([snapshot({ phase })]);
    await assert.rejects(f.run, /owns this release/);
    assert.equal(f.calls(), 1);
    const next = observe([snapshot(), snapshot({ phase })]);
    await assert.rejects(next.run, /owns this release/);
    assert.equal(next.calls(), 2);
  }
});

test('a sampling deadline never permits taking a live lease', async () => {
  const f = observe([snapshot({ leaseExpiresAt: 100000 })], { waitMs: 500 });
  await assert.rejects(f.run, /owns this release/);
  assert.equal(f.time(), 1500);
});

test('waiting preserves journal UID, installation, manifest and policy bindings', async () => {
  for (const changed of [
    { record: null },
    snapshot({}, 'replacement-uid'),
    snapshot({ manifestDigest: 'different' }),
    snapshot({ policyDigest: 'different' }),
    snapshot({ namespace: 'other' }),
  ])
    await assert.rejects(observe([snapshot(), changed]).run, /identity changed/);
});

test('invalid journal formats and failed reads are not hidden by sampling waits', async () => {
  const f = observe([snapshot({ token: '' })]);
  await assert.rejects(f.run, /identity or format/);
  assert.equal(f.calls(), 1);
  await assert.rejects(
    observe([], {
      read: async () => {
        throw Error('read failed');
      },
    }).run,
    /read failed/,
  );
});

test('an absent journal and the selected strategy retain their existing behavior', async () => {
  assert.equal(await observe([{ record: null }]).run(), null);
  const own = snapshot({ autoscalingProtocol: undefined, protocol: 1, leaseExpiresAt: 1000 });
  assert.equal(await observe([own]).run(), own.record);
  assert.equal(
    await observe([snapshot()], { kind: 'autoscaling' })
      .run()
      .then((r) => r.autoscalingProtocol),
    1,
  );
});

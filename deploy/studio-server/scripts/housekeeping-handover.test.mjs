import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handoverHousekeeping } from './lib/housekeeping-handover.mjs';

function fixture(fault) {
  const source = { name: 'backend-0', uid: randomUUID() },
    target = { name: 'backend-1', uid: randomUUID() };
  const states = new Map(
    [source, target].map((p, i) => {
      const incarnation = randomUUID();
      return [
        p.uid,
        { incarnation, housekeeping: { protocol: 1, podUid: p.uid, incarnation, state: i ? 'standby' : 'owner' } },
      ];
    }),
  );
  const commands = [];
  const operation = {
    record: { token: randomUUID(), owner: {} },
    assertLease() {},
    async checkpoint(patch) {
      Object.assign(this.record, structuredClone(patch));
    },
  };
  const options = {
    source,
    target,
    operation,
    timeoutMs: 1,
    wait: async () => {},
    status: async (pod) => states.get(pod.uid),
    confirmReady: async () => {},
    command: async (pod, action, operationId) => {
      commands.push(action);
      states.get(pod.uid).housekeeping.state = action === 'release' ? 'released' : 'owner';
      states.get(pod.uid).housekeeping.operationId = operationId;
      if (fault === action) throw Error('lost acknowledgement');
    },
  };
  return { options, states, commands };
}
test('handover confirms new owner before completion', async () => {
  const f = fixture();
  await handoverHousekeeping(f.options);
  assert.deepEqual(f.commands, ['release', 'acquire']);
  assert.equal(f.options.operation.record.owner.housekeeping.complete, true);
});
for (const fault of ['release', 'acquire'])
  test(`lost ${fault} acknowledgement resumes by observation without replay`, async () => {
    const f = fixture(fault);
    await assert.rejects(handoverHousekeeping(f.options), /lost acknowledgement/);
    await handoverHousekeeping(f.options);
    assert.deepEqual(f.commands, ['release', 'acquire']);
  });
test('failed developer acceptance cannot release the old owner', async () => {
  const f = fixture();
  f.options.confirmReady = async () => {
    throw Error('session failed');
  };
  await assert.rejects(handoverHousekeeping(f.options), /session failed/);
  assert.deepEqual(f.commands, []);
});
test('changed target UID blocks recovery before further commands', async () => {
  const f = fixture('release');
  await assert.rejects(handoverHousekeeping(f.options));
  f.options.target = { ...f.options.target, uid: randomUUID() };
  await assert.rejects(handoverHousekeeping(f.options), /identity changed/);
  assert.deepEqual(f.commands, ['release']);
});

for (const fault of ['release', 'acquire'])
  test(`foreign operation cannot satisfy an uncertain ${fault}`, async () => {
    const f = fixture(fault);
    await assert.rejects(handoverHousekeeping(f.options), /lost acknowledgement/);
    const pod = fault === 'release' ? f.options.source : f.options.target;
    f.states.get(pod.uid).housekeeping.operationId = randomUUID();
    await assert.rejects(handoverHousekeeping(f.options), /operation identity changed/);
    assert.deepEqual(f.commands, fault === 'release' ? ['release'] : ['release', 'acquire']);
  });

for (const identity of ['podUid', 'incarnation', 'protocol'])
  test(`unconfirmed ${identity} blocks initial handover without issuing commands`, async () => {
    const f = fixture();
    f.states.get(f.options.source.uid).housekeeping[identity] = identity === 'protocol' ? 2 : randomUUID();
    await assert.rejects(handoverHousekeeping(f.options), /protocol\/owner is unconfirmed/);
    assert.deepEqual(f.commands, []);
  });

for (const state of ['failed', 'acquiring', 'waiting', 'draining', 'owner', 'stopped', 'unknown'])
  test(`a ${state} target cannot release the healthy housekeeping owner`, async () => {
    const f = fixture();
    f.states.get(f.options.target.uid).housekeeping.state = state;
    await assert.rejects(handoverHousekeeping(f.options), /target cannot acquire ownership/);
    assert.deepEqual(f.commands, [], 'developer readiness alone never permits releasing housekeeping');
    assert.equal(f.states.get(f.options.source.uid).housekeeping.state, 'owner');
    assert.equal(f.options.operation.record.owner.housekeeping, undefined, 'no handover intent was recorded');
  });

test('a previously released target can accept a new handover', async () => {
  const f = fixture();
  Object.assign(f.states.get(f.options.target.uid).housekeeping, {
    state: 'released',
    operationId: randomUUID(),
  });
  await handoverHousekeeping(f.options);
  assert.deepEqual(f.commands, ['release', 'acquire']);
  assert.equal(f.options.operation.record.owner.housekeeping.complete, true);
});

for (const failure of ['failed', 'acquiring', 'restarted'])
  test(`recovery checks a ${failure} target again before releasing the old worker`, async () => {
    const f = fixture();
    const checkpoint = f.options.operation.checkpoint;
    f.options.operation.checkpoint = async function (patch) {
      await checkpoint.call(this, patch);
      throw Error('interrupted after initial handover checkpoint');
    };
    await assert.rejects(handoverHousekeeping(f.options), /interrupted after initial/);
    f.options.operation.checkpoint = checkpoint;
    const peer = f.states.get(f.options.target.uid);
    if (failure === 'restarted') {
      peer.incarnation = randomUUID();
      peer.housekeeping.incarnation = peer.incarnation;
    } else peer.housekeeping.state = failure;
    await assert.rejects(handoverHousekeeping(f.options), /target cannot acquire ownership|incarnation changed/);
    assert.deepEqual(f.commands, []);
    assert.equal(f.states.get(f.options.source.uid).housekeeping.state, 'owner');
    assert.equal(f.options.operation.record.owner.housekeeping.releaseIssued, false);
  });

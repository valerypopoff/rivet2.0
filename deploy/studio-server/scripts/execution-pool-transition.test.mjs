import test from 'node:test';
import assert from 'node:assert/strict';
import { runExecutionPoolTransition } from './lib/execution-pool-transition.mjs';

test('pinned work starts after both routing withdrawals and before each admission fence', async () => {
  const f = fixture();
  const withdrawn = new Set();
  f.io.waitForRoutingWithdrawal = async (pod) => {
    withdrawn.add(pod.uid);
  };
  f.io.prepareFence = async (pod) => {
    assert.equal(withdrawn.size, 2);
    assert.equal(f.participants.get(pod.name).state, 'withdrawing');
    f.calls.push('pinned:' + pod.name);
  };
  await f.run();
  for (const ordinal of [0, 1]) {
    const name = 'execution-' + ordinal;
    assert.ok(f.calls.indexOf('pinned:' + name) < f.calls.indexOf('begin:' + name));
  }
});

test('failed pinned admission never closes execution admission', async () => {
  const f = fixture();
  f.io.prepareFence = async () => {
    throw Error('pinned admission failed');
  };
  await assert.rejects(f.run(), /pinned admission failed/);
  assert.ok(!f.calls.some((call) => call.startsWith('begin:')));
});

test('legacy routing preparation and per-owner guard precede every unsafe withdrawal', async () => {
  const f = fixture();
  let prepared = false;
  f.io.prepareHttpHandoff = async () => {
    prepared = true;
  };
  f.io.beforeHttpWithdrawal = async () => {
    assert.equal(prepared, true);
    throw Error('legacy route is unconfirmed');
  };
  await assert.rejects(f.run(), /legacy route is unconfirmed/);
  assert.ok(!f.calls.some((call) => /^(withdraw:|begin:|scale)/.test(call)));
});

function fixture(ownerCount = 2) {
  const plan = {
    protocol: 1,
    previous: { name: 'execution', uid: 'previous', replicas: ownerCount },
    candidate: { name: 'execution-next' },
    maxReplicas: Math.max(7, ownerCount * 2),
  };
  const participants = new Map(
    Array.from({ length: ownerCount }, (_, i) => [
      'execution-' + i,
      {
        name: 'execution-' + i,
        uid: 'owner-' + i,
        ready: true,
        incarnation: 'incarnation-' + i,
        state: 'serving',
        operationId: null,
      },
    ]),
  );
  const calls = [],
    begun = new Set();
  let replicas = ownerCount,
    time = 0;
  const operation = {
    record: {},
    assertLease() {},
    async checkpoint(changes) {
      operation.record = structuredClone({ ...operation.record, ...changes });
    },
  };
  const io = {
    observe: async (name) => participants.get(name) ?? null,
    status: async (pod) => ({
      ...participants.get(pod.name),
      state: begun.size === ownerCount ? 'drained' : participants.get(pod.name).state,
    }),
    candidate: async () => ({ uid: 'candidate' }),
    assertCapacity: async () => {},
    prepare: async (pod) => {
      calls.push('probe:' + pod.name);
    },
    withdraw: async (pod, operationId) => {
      calls.push('withdraw:' + pod.name);
      Object.assign(participants.get(pod.name), { state: 'withdrawing', operationId });
    },
    waitForRoutingWithdrawal: async () => {},
    begin: async (pod) => {
      calls.push('begin:' + pod.name);
      begun.add(pod.name);
      participants.get(pod.name).state = 'draining';
    },
    previous: async () => ({ uid: 'previous', replicas }),
    scalePrevious: async () => {
      calls.push('scale');
      replicas = 0;
      participants.clear();
    },
    waitForWithdrawal: async () => {},
    verify: async () => {
      assert.equal(replicas, 0);
    },
  };
  return {
    operation,
    plan,
    io,
    calls,
    participants,
    run: () =>
      runExecutionPoolTransition({
        operation,
        plan,
        io,
        timeoutMs: 10000,
        now: () => time,
        pause: async () => {
          time += 1000;
        },
      }),
  };
}

for (const count of [3, 4, 7])
  test(`all ${count} old workers start draining before any is removed; recovery never repeats scale`, async () => {
    const f = fixture(count);
    await f.run();
    assert.equal(f.operation.record.executionPool.owners.length, count);
    assert.equal(f.operation.record.executionPool.phase, 'complete');
    const scaleAt = f.calls.indexOf('scale');
    for (let index = 0; index < count; index++) assert.ok(f.calls.indexOf(`begin:execution-${index}`) < scaleAt);
    await f.run();
    assert.equal(f.calls.filter((call) => call === 'scale').length, 1);
  });

test('insufficient overlap capacity is rejected before probes or mutations', async () => {
  const f = fixture(4);
  f.plan.maxReplicas = 7;
  await assert.rejects(f.run());
  assert.deepEqual(f.calls, []);
});

test('both accepted jobs and drains overlap, and the candidate pool becomes steady capacity', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.calls, [
    'probe:execution-0',
    'probe:execution-1',
    'withdraw:execution-0',
    'withdraw:execution-1',
    'begin:execution-0',
    'begin:execution-1',
    'scale',
  ]);
  assert.equal(f.operation.record.executionPool.phase, 'complete');
  await f.run();
  assert.equal(f.calls.filter((call) => call === 'scale').length, 1);
});

test('candidate capacity loss blocks fencing and preserves both old owners', async () => {
  const f = fixture();
  f.io.assertCapacity = async () => {
    if (f.calls.some((call) => call.startsWith('withdraw:'))) throw Error('capacity lost');
  };
  await assert.rejects(f.run(), /capacity lost/);
  assert.equal(f.participants.size, 2);
  assert.equal(
    f.calls.some((call) => call.startsWith('begin:')),
    false,
  );
});

for (const count of [2, 3])
  for (const action of ['withdraw', 'begin', 'scalePrevious'])
    test(`lost ${action} acknowledgement with ${count} workers is observed during recovery without replay`, async () => {
      const f = fixture(count),
        original = f.io[action];
      let lost = false;
      f.io[action] = async (...args) => {
        await original(...args);
        if (!lost) {
          lost = true;
          throw Error('ack lost');
        }
      };
      await assert.rejects(f.run(), /ack lost/);
      await f.run();
      assert.equal(f.operation.record.executionPool.phase, 'complete');
      assert.equal(f.calls.filter((call) => call === 'withdraw:execution-0').length, 1);
      assert.equal(f.calls.filter((call) => call === 'begin:execution-0').length, 1);
      assert.equal(f.calls.filter((call) => call === 'scale').length, 1);
    });

test('an issued but unapplied withdrawal is not retried, and foreign pod replacement blocks removal', async () => {
  const f = fixture();
  f.io.withdraw = async () => {
    throw Error('unknown dispatch');
  };
  await assert.rejects(f.run(), /unknown dispatch/);
  await assert.rejects(f.run(), /Withdrawal acknowledgement is unknown/);
  assert.equal(f.participants.size, 2);
  f.participants.get('execution-0').uid = 'foreign';
  await assert.rejects(f.run(), /Original execution owner changed/);
});

test('accepted work that has not settled times out without scaling away either original owner', async () => {
  const f = fixture();
  const original = f.io.status;
  f.io.status = async (pod) => {
    const status = await original(pod);
    return { ...status, state: status.state === 'drained' ? 'draining' : status.state };
  };
  await assert.rejects(f.run(), /completion timed out; owners retained/);
  assert.equal(f.participants.size, 2);
  assert.ok(!f.calls.includes('scale'));
});

test('a failed routing observation joins its sibling before returning and never fences admission', async () => {
  const f = fixture();
  let release,
    returned = false,
    joined = false;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  f.io.waitForRoutingWithdrawal = async (pod) => {
    if (pod.name.endsWith('-0')) throw Error('routing failed');
    await barrier;
    joined = true;
  };
  const outcome = assert.rejects(
    f.run().finally(() => {
      returned = true;
    }),
    /routing failed/,
  );
  await new Promise(setImmediate);
  assert.equal(returned, false);
  release();
  await outcome;
  assert.equal(joined, true);
  assert.ok(!f.calls.some((call) => call.startsWith('begin:')));
});

test('malformed recovered owner sets cannot authorize pool completion', async () => {
  const f = fixture();
  await f.run();
  f.operation.record.executionPool.owners.pop();
  await assert.rejects(f.run());
  assert.equal(f.calls.filter((call) => call === 'scale').length, 1);
});

test('scale-down refreshes its resource version after drain evidence and journal persistence', async () => {
  const f = fixture();
  let version = 1;
  const checkpoint = f.operation.checkpoint;
  f.operation.checkpoint = async (changes) => {
    await checkpoint(changes);
    version++;
  };
  const previous = f.io.previous,
    scale = f.io.scalePrevious;
  f.io.previous = async () => ({ ...(await previous()), resourceVersion: String(version) });
  f.io.waitForWithdrawal = async () => {
    version++;
  };
  f.io.scalePrevious = async (current) => {
    assert.equal(current.resourceVersion, String(version));
    await scale();
  };
  await f.run();
  assert.equal(f.operation.record.executionPool.phase, 'complete');
});

test('a replacement appearing during final capacity checks is never scaled away as the retired owner', async () => {
  const f = fixture();
  f.io.assertCapacity = async () => {
    if (f.operation.record.executionPool.phase === 'removing')
      f.participants.get('execution-0').uid = 'new-unretired-owner';
  };
  await assert.rejects(f.run(), /Original execution owner changed/);
  assert.equal(f.participants.size, 2);
  assert.ok(!f.calls.includes('scale'));
});

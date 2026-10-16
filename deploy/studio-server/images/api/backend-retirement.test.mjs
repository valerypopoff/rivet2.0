import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createBackendRetirement } from './backend-retirement.mjs';
import { retireBackend } from './retire-backend.mjs';

function fixture() {
  const incarnation = randomUUID();
  const events = [];
  let available = true;
  let fenced = false;
  let resolve;
  let waiting;
  const wait = () => {
    waiting = new Promise((done) => {
      resolve = done;
    });
    return waiting;
  };
  function participant(name) {
    const status = { protocol: 1, withdrawalProtocol: 1, incarnation, operationId: null, state: 'serving' };
    return {
      value: status,
      async status() {
        return { ...status };
      },
      async begin(operationId) {
        events.push(name);
        Object.assign(status, { operationId, state: 'draining' });
      },
      async withdraw(operationId) {
        Object.assign(status, { operationId, state: 'withdrawing' });
        return { ...status };
      },
    };
  }
  const api = participant('api'),
    executor = participant('executor');
  const owner = createBackendRetirement({
    incarnation,
    api,
    executor,
    wait,
    available: () => available,
    onRetiring: () => {
      fenced = true;
    },
  });
  return {
    owner,
    api,
    executor,
    events,
    loseOwner: () => {
      available = false;
    },
    wake: () => resolve?.(),
    isFenced: () => fenced,
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('routing withdrawal preserves admission until the owner confirms endpoint removal', async () => {
  const f = fixture(),
    id = randomUUID(),
    incarnation = f.owner.snapshot().incarnation;
  f.owner.withdraw(id, incarnation);
  await tick();
  assert.equal(f.owner.snapshot().state, 'withdrawing');
  assert.equal(f.api.value.state, 'withdrawing');
  assert.equal(f.executor.value.state, 'serving');
  assert.deepEqual(f.events, []);
  assert.equal(f.isFenced(), true, 'only supervisor readiness is withdrawn');
  f.owner.begin(id, incarnation);
  await tick();
  assert.deepEqual(f.events, ['executor']);
  f.executor.value.state = 'drained';
  f.wake();
  await tick();
  f.api.value.state = 'drained';
  f.wake();
  assert.equal((await f.owner.wait()).state, 'drained');
});

test('executor finishes before API retirement; long and paused work blocks replacement without a kill deadline', async () => {
  const f = fixture();
  const id = randomUUID();
  assert.equal(f.owner.begin(id, f.owner.snapshot().incarnation).state, 'checking');
  await tick();
  assert.deepEqual(f.events, ['executor']);
  f.wake();
  await tick();
  assert.equal(f.owner.snapshot().state, 'draining');
  assert.deepEqual(f.events, ['executor']);
  f.executor.value.state = 'drained';
  f.wake();
  await tick();
  assert.deepEqual(f.events, ['executor', 'api']);
  f.api.value.state = 'drained';
  f.wake();
  assert.equal((await f.owner.wait()).state, 'drained');
  f.owner.begin(id, f.owner.snapshot().incarnation);
  assert.deepEqual(f.events, ['executor', 'api']);
});

for (const failure of ['protocol', 'incarnation', 'operation', 'cleanup', 'owner-loss', 'lost-begin-ack']) {
  test(`retirement blocks replacement on ${failure}`, async () => {
    const f = fixture();
    if (failure === 'protocol') f.api.value.protocol = 2;
    if (failure === 'incarnation') f.executor.value.incarnation = randomUUID();
    if (failure === 'lost-begin-ack')
      f.executor.begin = async () => {
        throw new Error('network');
      };
    f.owner.begin(randomUUID(), f.owner.snapshot().incarnation);
    await tick();
    if (failure === 'operation') f.executor.value.operationId = randomUUID();
    if (failure === 'cleanup') f.executor.value.state = 'failed';
    if (failure === 'owner-loss') {
      f.executor.value.state = 'drained';
      f.wake();
      await tick();
      f.api.value.state = 'drained';
      f.loseOwner();
    }
    f.wake();
    assert.equal((await f.owner.wait()).state, 'failed');
    if (['protocol', 'incarnation'].includes(failure)) assert.deepEqual(f.events, []);
    if (['protocol', 'incarnation'].includes(failure)) assert.equal(f.isFenced(), false);
  });
}

test('stale and competing operation IDs cannot replace a retirement owner', async () => {
  const f = fixture();
  const id = randomUUID();
  assert.throws(() => f.owner.begin(id, randomUUID()), /identity/);
  assert.equal(f.owner.snapshot().state, 'serving');
  f.owner.begin(id, f.owner.snapshot().incarnation);
  assert.throws(() => f.owner.begin(randomUUID(), f.owner.snapshot().incarnation), /owns/);
  await tick();
  f.executor.value.state = 'failed';
  f.wake();
  await f.owner.wait();
});

test('operator wait expiry never terminates a child or repeats a retirement command', async () => {
  const operationId = randomUUID(),
    incarnation = randomUUID();
  let time = 0,
    begins = 0;
  const status = { protocol: 1, incarnation, operationId: null, state: 'serving' };
  await assert.rejects(
    retireBackend({
      socketPath: '/fixture.sock',
      operationId,
      incarnation,
      timeoutMs: 10,
      now: () => time,
      wait: async () => {
        time += 5;
      },
      requestStatus: async (_path, method) => {
        if (method === 'POST') {
          begins++;
          Object.assign(status, { operationId, state: 'draining' });
        }
        return { ...status };
      },
    }),
    /not terminated/,
  );
  assert.equal(begins, 1);
  assert.equal(status.state, 'draining');
});

test('operator rejects replacement incarnations before sending retirement', async () => {
  let commands = 0;
  await assert.rejects(
    retireBackend({
      socketPath: '/fixture.sock',
      operationId: randomUUID(),
      incarnation: randomUUID(),
      requestStatus: async (_path, method) => {
        if (method === 'POST') commands++;
        return { incarnation: randomUUID() };
      },
    }),
    /process changed/,
  );
  assert.equal(commands, 0);
});

test('supervisor fence failure cannot leave a successful or ownerless retirement', async () => {
  const incarnation = randomUUID(),
    operationId = randomUUID();
  const owner = createBackendRetirement({
    incarnation,
    available: () => true,
    api: {
      status: async () => ({ protocol: 1, incarnation, operationId: null, state: 'serving' }),
      begin: () => assert.fail('No participant may be fenced after a failed supervisor fence.'),
    },
    executor: {
      status: async () => ({ protocol: 1, incarnation, operationId: null, state: 'serving' }),
      begin: () => assert.fail('No participant may be fenced after a failed supervisor fence.'),
    },
    onRetiring: () => {
      throw new Error('fence');
    },
  });
  assert.equal(owner.begin(operationId, incarnation).state, 'checking');
  assert.equal((await owner.wait()).state, 'failed');
  assert.equal(owner.begin(operationId, incarnation).state, 'failed');
});

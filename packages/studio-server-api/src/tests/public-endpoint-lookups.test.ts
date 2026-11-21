import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { PublicEndpointLookups } from '../public-endpoint-lookups.js';
import { createDeferred } from './helpers/managed-backend-harness.js';

class Client extends EventEmitter {
  destroyed = false;
  disconnect() {
    this.destroyed = true;
    this.emit('close');
  }
}

const busy = { status: 503, code: 'endpoint_lookup_busy', retryAfterSeconds: 1 };
const draining = { status: 503, code: 'execution_draining' };

test('limits real operations even after disconnect, hands off in FIFO order, and releases on failure', async () => {
  for (const [pool, width] of [
    [1, 1],
    [2, 1],
    [10, 8],
  ] as const) {
    const gate = new PublicEndpointLookups(pool, 3, 10_000);
    const client = new Client();
    const hold = createDeferred<void>();
    const active = Array.from({ length: width }, () => gate.resolve(client, () => hold.promise));
    const order: number[] = [];
    const next = new Client();
    const queue = (id: number, owner = next) =>
      gate.resolve(owner, async () => {
        order.push(id);
      });
    const first = queue(1);
    const cancelled = new Client();
    const removed = assert.rejects(queue(2, cancelled), /disconnect/i);
    const third = queue(3);
    await assert.rejects(queue(4), busy);
    cancelled.disconnect();
    await removed;
    const fourth = queue(4);
    client.disconnect();
    assert.deepEqual(gate.snapshot, { active: width, queued: 3 });
    hold.resolve();
    await Promise.all(active.map((read) => assert.rejects(read, /disconnect/i)));
    await Promise.all([first, third, fourth]);
    assert.deepEqual(order, [1, 3, 4]);
    assert.equal(next.listenerCount('close'), 0);
    const dbError = Error('database failed');
    await assert.rejects(
      gate.resolve(next, () => {
        throw dbError;
      }),
      (error) => error === dbError,
    );
    assert.deepEqual(gate.snapshot, { active: 0, queued: 0 });
  }
});

test('honors the deadline at dispatch even with delayed timers, and fences queued and active reads on drain', async () => {
  let now = 0;
  const gate = new PublicEndpointLookups(1, 2, 50, () => now);
  const client = new Client();
  const hold = createDeferred<void>();
  const active = gate.resolve(client, () => hold.promise);
  const discarded = async () => assert.fail('An expired or draining request started a database read');
  const expired = assert.rejects(gate.resolve(client, discarded), busy);
  now = 40;
  const second = createDeferred<void>();
  const pending = assert.rejects(gate.resolve(client, () => second.promise), draining);
  now = 50;
  hold.resolve();
  await Promise.all([active, expired]);
  assert.deepEqual(gate.snapshot, { active: 1, queued: 0 });
  const fenced = assert.rejects(gate.resolve(client, discarded), draining);
  gate.beginDrain();
  await fenced;
  await assert.rejects(gate.resolve(client, discarded), draining);
  assert.deepEqual(gate.snapshot, { active: 1, queued: 0 });
  second.resolve();
  await pending;
  assert.equal(client.listenerCount('close'), 0);
  assert.deepEqual(gate.snapshot, { active: 0, queued: 0 });
});

test('a queued lookup expires while all database reads are still outstanding', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = new PublicEndpointLookups(1, 1, 50);
  const client = new Client();
  const hold = createDeferred<void>();
  const read = gate.resolve(client, () => hold.promise);
  const expired = assert.rejects(
    gate.resolve(client, () => assert.fail('Expired read was dispatched')),
    busy,
  );
  t.mock.timers.tick(50);
  await expired;
  assert.deepEqual(gate.snapshot, { active: 1, queued: 0 });
  assert.equal(client.listenerCount('close'), 0);
  hold.resolve();
  await read;
});

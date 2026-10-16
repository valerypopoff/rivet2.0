import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerResourceLifecycle, ServerStartupCancelledError } from '../server-resource-lifecycle.js';
import { RuntimeLibraryServices } from '../runtime-libraries/services.js';
import type { RuntimeLibrariesBackend } from '../runtime-libraries/backend.js';

test('runtime-library retirement retains its existing owner until accepted cleanup settles', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const events: string[] = [];
  const backend = {
    beginDrain() {
      events.push('fence');
    },
    drainAcceptedWork() {
      events.push('wait');
      return pending;
    },
    async dispose() {
      events.push('close');
    },
  } as RuntimeLibrariesBackend;
  const owner = new RuntimeLibraryServices(() => backend);
  assert.equal(owner.get(), backend);
  let drained = false;
  const drain = owner.drainAcceptedWork().then(() => {
    drained = true;
  });
  assert.equal(owner.get(), backend);
  assert.deepEqual(events, ['fence', 'wait']);
  assert.equal(drained, false);
  finish();
  await drain;
  assert.equal(owner.get(), backend, 'graceful retirement is not resource disposal');
  await owner.dispose();
  assert.deepEqual(events, ['fence', 'wait', 'fence', 'close']);
  assert.throws(() => owner.get(), /draining/);
});

test('retirement never allocates a lazy backend and refuses an unconfirmed drain', async () => {
  const empty = new RuntimeLibraryServices(() => {
    throw new Error('must not allocate');
  });
  await empty.drainAcceptedWork();
  assert.throws(() => empty.get(), /draining/);
  const unsupported = new RuntimeLibraryServices(() => ({ beginDrain() {} }) as RuntimeLibrariesBackend);
  unsupported.get();
  await assert.rejects(unsupported.drainAcceptedWork(), /cannot confirm/);
});

test('startup is single-flight and draining fences late acquisition before disposal', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const owner = new ServerResourceLifecycle([
    {
      name: 'store',
      beginDrain() {
        events.push('drain');
      },
      dispose() {
        events.push('close');
      },
    },
  ]);
  const start = owner.initialize(async () => {
    await gate;
    owner.assertStartupActive();
  });
  assert.equal(
    owner.initialize(async () => assert.fail()),
    start,
  );
  owner.beginDrain();
  const close = owner.dispose(true);
  assert.deepEqual(events, ['drain']);
  release();
  await assert.rejects(start, ServerStartupCancelledError);
  await close;
  assert.deepEqual(events, ['drain', 'close']);
  assert.equal(owner.phase, 'disposed');
});

test('failed close retains ownership and downstream stores, and cleanup can retry', async () => {
  let fail = true;
  const events: string[] = [];
  const owner = new ServerResourceLifecycle([
    {
      name: 'producer',
      dispose() {
        events.push('producer');
        if (fail) throw new Error('busy');
      },
    },
    {
      name: 'store',
      dispose() {
        events.push('store');
      },
    },
  ]);
  await owner.initialize(async () => {});
  await assert.rejects(owner.dispose(false), /producer/);
  assert.deepEqual(events, ['producer']);
  assert.deepEqual(owner.pendingResourceNames, ['producer', 'store']);
  fail = false;
  await Promise.all([owner.dispose(true), owner.dispose(true)]);
  assert.deepEqual(events, ['producer', 'producer', 'store']);
  assert.deepEqual(owner.pendingResourceNames, []);
});

test('a failed admission fence is retried before any dependent resource is closed', async () => {
  let fail = true;
  const events: string[] = [];
  const owner = new ServerResourceLifecycle([
    {
      name: 'producer',
      beginDrain() {
        events.push('fence');
        if (fail) throw new Error('busy');
      },
      dispose() {
        events.push('producer');
      },
    },
    {
      name: 'store',
      beginDrain() {
        events.push('store-fence');
      },
      dispose() {
        events.push('store');
      },
    },
  ]);
  assert.throws(() => owner.beginDrain(), /fencing failed/);
  await assert.rejects(owner.dispose(true), /fencing failed/);
  assert.deepEqual(events, ['fence', 'store-fence', 'fence']);
  fail = false;
  await owner.dispose(true);
  assert.deepEqual(events, ['fence', 'store-fence', 'fence', 'fence', 'producer', 'store']);
});

test('runtime libraries retain their backend on failed close and fence late construction', async () => {
  let fail = true;
  const backend = {
    async dispose() {
      if (fail) throw new Error('not terminated');
    },
  } as RuntimeLibrariesBackend;
  const owner = new RuntimeLibraryServices(() => backend);
  assert.equal(owner.get(), backend);
  await assert.rejects(owner.dispose(), /not terminated/);
  assert.equal(owner.get(), backend);
  fail = false;
  await owner.dispose();
  assert.throws(() => owner.get(), /draining/);
  const unused = new RuntimeLibraryServices(() => {
    assert.fail('must not construct during drain');
  });
  unused.beginDrain();
  await unused.dispose();
});

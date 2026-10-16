import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { AcceptedWork, ProcessRetirement } from '../../../studio-server-shared/process-retirement.js';
import { createRequestWorkBarrier } from '../request-work.js';
import { createProcessRetirementRouter } from '../process-retirement-http.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listenTestServer } from './helpers/http-server-harness.js';
import { beginPassiveStreamRetirement, watchVmMigrationPassiveStream } from '../vm-migration-maintenance.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('routing withdrawal is owned but leaves request admission open until explicit fencing', async () => {
  const work = new AcceptedWork();
  let withdrawals = 0;
  const owner = new ProcessRetirement(
    randomUUID(),
    () => work.beginDrain(),
    () => work.drain(),
    () => {
      withdrawals++;
    },
  );
  const id = randomUUID();
  assert.equal(owner.withdraw(id, owner.incarnation).state, 'withdrawing');
  assert.equal(owner.isWithdrawing, true);
  assert.equal(owner.withdraw(id, owner.incarnation).state, 'withdrawing');
  assert.equal(withdrawals, 1);
  const release = work.acquire();
  assert.ok(release);
  assert.throws(() => owner.begin(randomUUID(), owner.incarnation), /owns/);
  assert.equal(owner.begin(id, owner.incarnation).state, 'draining');
  assert.equal(owner.isWithdrawing, false);
  assert.equal(work.acquire(), null);
  release();
  await tick();
  assert.equal(owner.snapshot().state, 'drained');
});

test('retirement closes passive SSE and late setup without canceling durable work', async () => {
  const work = new AcceptedWork(),
    setup = deferred();
  const app = express();
  app.use(createRequestWorkBarrier(work));
  app.get('/events', (_req, res) => {
    res.set('Content-Type', 'text/event-stream').flushHeaders();
    watchVmMigrationPassiveStream(res);
  });
  app.get(
    '/late',
    asyncHandler(async (_req, res) => {
      res.set('Content-Type', 'text/event-stream').flushHeaders();
      await setup.promise;
      watchVmMigrationPassiveStream(res);
    }),
  );
  const http = await listenTestServer(createServer(app));
  try {
    const early = await fetch(`${http.baseUrl}/events`),
      late = await fetch(`${http.baseUrl}/late`);
    work.beginDrain();
    beginPassiveStreamRetirement();
    await early.text();
    let drained = false;
    const completion = work.drain().then(() => {
      drained = true;
    });
    await tick();
    assert.equal(drained, false);
    setup.resolve();
    await late.text();
    await completion;
    assert.equal(drained, true);
  } finally {
    setup.resolve();
    await http.close();
  }
});

test('retirement is fenced synchronously, idempotent and incarnation/operation bound', async () => {
  const work = new AcceptedWork();
  const release = work.acquire()!;
  let calls = 0;
  const owner = new ProcessRetirement(
    randomUUID(),
    () => work.beginDrain(),
    async () => {
      calls++;
      await work.drain();
    },
  );
  const id = randomUUID();
  assert.throws(() => owner.begin(id, randomUUID()), /identity/);
  assert.equal(owner.snapshot().state, 'serving');
  assert.equal(owner.begin(id, owner.incarnation).state, 'draining');
  assert.equal(work.acquire(), null);
  assert.equal(owner.begin(id, owner.incarnation).state, 'draining');
  assert.throws(() => owner.begin(randomUUID(), owner.incarnation), /owns/);
  await tick();
  assert.equal(calls, 1);
  assert.equal(owner.snapshot().state, 'draining');
  release();
  release();
  await tick();
  assert.equal(work.count, 0);
  assert.equal(owner.snapshot().state, 'drained');
});

test('fence and cleanup failures remain failed, not silently drained or retried', async () => {
  for (const failFence of [false, true]) {
    let calls = 0;
    const owner = new ProcessRetirement(
      randomUUID(),
      () => {
        if (failFence) throw new Error('fence');
      },
      async () => {
        calls++;
        throw new Error('unknown write outcome');
      },
    );
    const id = randomUUID();
    owner.begin(id, owner.incarnation);
    await tick();
    assert.equal(owner.snapshot().state, 'failed');
    assert.equal(owner.begin(id, owner.incarnation).state, 'failed');
    assert.equal(calls, failFence ? 0 : 1);
  }
});

test('a failed accepted cleanup blocks drain even after its lifetime count reaches zero', async () => {
  const work = new AcceptedWork();
  const release = work.acquire()!;
  const pending = assert.rejects(work.drain(), /cleanup ownership unknown/);
  work.fail(new Error('cleanup ownership unknown'));
  release();
  await pending;
  assert.equal(work.count, 0);
  assert.equal(work.acquire(), null);
  await assert.rejects(work.drain(), /cleanup ownership unknown/);
});

test('retirement waits for a disconnected response handler and fences new requests', async () => {
  const work = new AcceptedWork();
  const entered = deferred(),
    complete = deferred(),
    settled = deferred();
  const app = express();
  app.use(createRequestWorkBarrier(work));
  app.get(
    '/save',
    asyncHandler(async (_req, res) => {
      res.write('accepted');
      entered.resolve();
      await complete.promise;
      res.end('saved');
      settled.resolve();
    }),
  );
  const server = createServer(app);
  const http = await listenTestServer(server);
  let client: ReturnType<typeof request> | undefined;
  try {
    client = request(`${http.baseUrl}/save`);
    const response = once(client, 'response');
    client.end();
    const [stream] = await response;
    await entered.promise;
    stream.destroy();
    await tick();
    let drained = false;
    const drain = work.drain().then(() => {
      drained = true;
    });
    assert.equal((await fetch(`${http.baseUrl}/save`)).status, 503);
    assert.equal(drained, false);
    assert.equal(work.count, 1);
    complete.resolve();
    await settled.promise;
    await drain;
    assert.equal(work.count, 0);
  } finally {
    complete.resolve();
    client?.destroy();
    await http.close();
  }
});

test('private retirement rejects UI keys, origins, stale identities and conflicting operations', async () => {
  const completion = deferred();
  const owner = new ProcessRetirement(
    randomUUID(),
    () => {},
    () => completion.promise,
  );
  const token = 'private-pod-local-capability-token-32';
  const app = express();
  app.use('/internal/process-retirement', createProcessRetirementRouter(owner, token));
  const http = await listenTestServer(createServer(app));
  const url = `${http.baseUrl}/internal/process-retirement`;
  const headers = { 'content-type': 'application/json', 'x-rivet-retirement-token': token };
  const id = randomUUID();
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://rivet.test' } })).status, 403);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: '' } })).status, 403);
    const begin = (operationId: string, incarnation: string, protocol = 1) =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ protocol, operationId, incarnation }),
      });
    assert.equal((await begin(id, randomUUID())).status, 409);
    assert.equal((await begin(id, owner.incarnation, 2)).status, 409);
    assert.equal(owner.snapshot().state, 'serving');
    const command = (action: string) =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ protocol: 1, operationId: id, incarnation: owner.incarnation, action }),
      });
    assert.equal((await command('typo')).status, 409);
    assert.equal(owner.snapshot().state, 'serving');
    assert.equal((await command('withdraw')).status, 202);
    assert.equal(owner.snapshot().state, 'withdrawing');
    assert.equal((await begin(id, owner.incarnation)).status, 202);
    assert.equal((await begin(randomUUID(), owner.incarnation)).status, 409);
    assert.equal((await begin(id, owner.incarnation)).status, 202);
    completion.resolve();
    await tick();
    const response = await fetch(url, { headers });
    assert.equal((await response.json()).state, 'drained');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    completion.resolve();
    await http.close();
  }
});

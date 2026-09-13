import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import http from 'node:http';
import test from 'node:test';
import { createHostedClientAuthorizer } from '../../../studio-server-executor/src/clientAuthorization.mjs';

function request(token = 'proxy-token') {
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  return { headers: { 'x-rivet-proxy-auth': token }, socket } as unknown as IncomingMessage;
}

function harness(timeoutMs = 3_000) {
  const running: Array<{ signal: AbortSignal; finish(status?: number): void }> = [];
  let peak = 0;
  let active = 0;
  const authorize = createHostedClientAuthorizer({
    url: new URL('http://control/ui-auth/check'),
    getProxyToken: () => 'proxy-token',
    timeoutMs,
    fetch: (async (_url, options) => {
      active++;
      peak = Math.max(peak, active);
      const signal = options!.signal!;
      try {
        return await new Promise<Response>((resolve, reject) => {
          const abort = () => reject(new Error('aborted'));
          signal.addEventListener('abort', abort, { once: true });
          running.push({ signal, finish: (status = 204) => {
            signal.removeEventListener('abort', abort);
            resolve(new Response(null, { status }));
          } });
        });
      } finally { active--; }
    }) as typeof fetch,
  });
  return { authorize, running, peak: () => peak };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('hosted authorization queues a burst instead of rejecting its seventeenth valid client', async () => {
  const { authorize, running, peak } = harness();
  const results = Array.from({ length: 32 }, () => authorize(request()));
  assert.equal(running.length, 16);
  running.slice().forEach((check) => check.finish());
  await flush();
  assert.equal(running.length, 32);
  running.slice(16).forEach((check) => check.finish());
  assert.deepEqual(await Promise.all(results), Array(32).fill(true));
  assert.equal(peak(), 16);
});

test('hosted authorization bounds waiting clients and removes disconnected waiters', async () => {
  const { authorize, running } = harness();
  const requests = Array.from({ length: 80 }, () => request());
  const results = requests.map(authorize);
  assert.equal(await authorize(request()), false);
  requests[16]!.socket.emit('close');
  assert.equal(await results[16], false);
  const replacement = authorize(request());
  // All remaining waiters disconnect without starting a network check.
  requests.slice(17).forEach((req) => req.socket.emit('close'));
  running.slice().forEach((check) => check.finish());
  await flush();
  assert.equal(running.length, 17);
  running[16]!.finish();
  assert.equal(await replacement, true);
  const decisions = await Promise.all(results);
  assert.equal(decisions.filter(Boolean).length, 16);
  requests.forEach((req) => assert.equal(req.socket.listenerCount('close'), 0));
});

test('hosted authorization aborts active checks on disconnect and does not accept HTTP 200', async () => {
  const { authorize, running } = harness();
  assert.equal(await authorize(request('forged')), false);
  assert.equal(running.length, 0);
  const client = request();
  const disconnected = authorize(client);
  client.socket.emit('close');
  assert.equal(await disconnected, false);
  assert.equal(running[0]!.signal.aborted, true);
  const unexpected = authorize(request());
  running[1]!.finish(200);
  assert.equal(await unexpected, false);
  const valid = authorize(request());
  running[2]!.finish();
  assert.equal(await valid, true);
});

test('hosted authorization deadlines cover queue wait and release all capacity', async () => {
  const { authorize, running } = harness(25);
  // Keep the event loop alive while checking intentionally unreferenced deadlines.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.deepEqual(await Promise.all(Array.from({ length: 80 }, () => authorize(request()))), Array(80).fill(false));
    assert.ok(running.every((check) => check.signal.aborted));
    const next = authorize(request());
    running.at(-1)!.finish();
    assert.equal(await next, true);
  } finally { clearInterval(keepAlive); }
});

test('hosted authorization uses the real HTTP check contract and strips unrelated credentials', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/ui-auth/check');
    seen.push(req.headers);
    res.writeHead(seen.length === 1 ? 204 : 200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    const authorize = createHostedClientAuthorizer({ url: new URL(`http://127.0.0.1:${port}/ui-auth/check`), getProxyToken: () => 'proxy-token' });
    const client = request();
    client.headers.cookie = 'rivet_ui_token=test';
    client.headers['x-rivet-client-ip'] = '10.20.1.2';
    client.headers.authorization = 'Bearer must-not-forward';
    client.headers['x-rivet-executor-auth'] = 'must-not-forward';
    assert.equal(await authorize(client), true);
    assert.equal(await authorize(client), false);
    assert.equal(seen[0]!.cookie, 'rivet_ui_token=test');
    assert.equal(seen[0]!['x-rivet-client-ip'], '10.20.1.2');
    assert.equal(seen[0]!.authorization, undefined);
    assert.equal(seen[0]!['x-rivet-executor-auth'], undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { requestRestoreEndpoint } from '../legacy-restore/internal-http.js';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('restore readiness and restart bypass the outbound fetch dispatcher and never follow redirects', async () => {
  const originalFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => {
    outboundCalls++;
    throw new Error('Restored outbound proxy is unavailable.');
  };
  let restartCalls = 0;
  let redirectedCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/restart') {
      restartCalls++;
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['x-rivet-supervisor-token'], 'private-fixture-token');
      res.writeHead(202).end();
    } else if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/unexpected' }).end();
    } else if (req.url === '/unexpected') {
      redirectedCalls++;
      res.end();
    } else {
      assert.equal(req.method, 'GET');
      assert.equal(req.headers['x-rivet-supervisor-token'], undefined);
      res.end(JSON.stringify({ restoreWarmup: true }));
    }
  });
  try {
    const base = await listen(server);
    assert.deepEqual(await requestRestoreEndpoint(`${base}/readyz`), { status: 200, restoreWarmup: true });
    assert.deepEqual(await requestRestoreEndpoint(`${base}/restart`, { supervisorToken: 'private-fixture-token' }), {
      status: 202,
      restoreWarmup: false,
    });
    assert.equal((await requestRestoreEndpoint(`${base}/redirect`)).status, 302);
    assert.equal(outboundCalls, 0);
    assert.equal(restartCalls, 1);
    assert.equal(redirectedCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await close(server);
  }
});

test('restore coordination bounds time and body size and requires a literal warmup acknowledgement', async () => {
  let stalledResponse: ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url === '/stall') stalledResponse = res;
    else if (req.url === '/slow-body') res.write('{');
    else if (req.url === '/truncated') res.writeHead(200, { 'Content-Length': '100' }).end('{');
    else if (req.url === '/large') res.end('x'.repeat(16 * 1024 + 1));
    else if (req.url === '/malformed') res.end('{');
    else if (req.url === '/standby') res.end(JSON.stringify({ restoreWarmup: false }));
    else if (req.url === '/unhealthy') res.writeHead(503).end(JSON.stringify({ restoreWarmup: true }));
    else res.end(JSON.stringify({ restoreWarmup: 'true' }));
  });
  try {
    const base = await listen(server);
    for (const endpoint of ['malformed', 'standby', 'truthy'])
      assert.deepEqual(await requestRestoreEndpoint(`${base}/${endpoint}`), { status: 200, restoreWarmup: false });
    assert.deepEqual(await requestRestoreEndpoint(`${base}/unhealthy`), { status: 503, restoreWarmup: true });
    await assert.rejects(requestRestoreEndpoint(`${base}/large`), /exceeds its limit/);
    await assert.rejects(requestRestoreEndpoint(`${base}/truncated`));
    await assert.rejects(requestRestoreEndpoint(`${base}/slow-body`, { timeoutMs: 50 }), /timed out/);
    await assert.rejects(requestRestoreEndpoint(`${base}/stall`, { timeoutMs: 50 }), /timed out/);
    assert.ok(stalledResponse);
    if (!stalledResponse.destroyed) await once(stalledResponse, 'close');
    assert.throws(() => requestRestoreEndpoint('file:///tmp/readyz'), /Invalid restore/);
    assert.throws(() => requestRestoreEndpoint('http://user:secret@127.0.0.1/readyz'), /Invalid restore/);
    assert.throws(() => requestRestoreEndpoint(base, { timeoutMs: 0 }), /Invalid restore/);
  } finally {
    await close(server);
  }
});

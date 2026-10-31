import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createKubernetesTransport } from './lib/execution-autoscaler-kubernetes.mjs';
const { WebSocket, WebSocketServer } = createRequire(
  new URL('../../../packages/studio-server-api/package.json', import.meta.url),
)('ws');

async function fixture(t, onConnection, timeoutMs = 2000) {
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', onConnection);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return createKubernetesTransport({
    origin: `http://127.0.0.1:${server.address().port}`,
    allowLoopbackHttp: true,
    WebSocketClass: WebSocket,
    token: () => 'local-test-only',
    timeoutMs,
  });
}

test('silent long exec survives an idle peer through ping frames, then requires its successful exit', async (t) => {
  let pings = 0,
    calls = 0;
  const api = await fixture(t, (socket) => {
    calls++;
    let lastActivity = Date.now();
    socket.on('ping', () => {
      pings++;
      lastActivity = Date.now();
    });
    const idle = setInterval(() => {
      if (Date.now() - lastActivity > 150) socket.close(1001);
    }, 25);
    const completion = setTimeout(() => {
      socket.send(Buffer.from([1, ...Buffer.from('complete')]));
      socket.send(Buffer.from([3, ...Buffer.from('{"status":"Success"}')]));
      socket.close();
    }, 500);
    socket.once('close', () => {
      clearInterval(idle);
      clearTimeout(completion);
    });
  });
  assert.equal(
    await api.exec('/api/v1/namespaces/test/pods/test/exec', ['long-command'], { keepAliveMs: 25 }),
    'complete',
  );
  assert.ok(pings >= 3);
  assert.equal(calls, 1);
});

test('keepalive never extends the absolute exec deadline or retries uncertain writes', async (t) => {
  let calls = 0,
    pings = 0;
  const api = await fixture(
    t,
    (socket) => {
      calls++;
      socket.on('ping', () => pings++);
    },
    200,
  );
  await assert.rejects(
    api.exec('/api/v1/namespaces/test/pods/test/exec', ['write'], { keepAliveMs: 20 }),
    /deadline exceeded; command outcome is unknown/,
  );
  assert.equal(calls, 1);
  assert.ok(pings > 0);
});

test('lost exec includes bounded close diagnostics without leaking peer reasons or accepting partial output', async (t) => {
  let calls = 0;
  const api = await fixture(t, (socket) => {
    calls++;
    socket.send(Buffer.from([1, ...Buffer.from('partial private output')]));
    socket.close(1012, 'private credential must not be logged');
  });
  await assert.rejects(api.exec('/api/v1/namespaces/test/pods/test/exec', ['write']), (error) => {
    assert.match(error.message, /close code 1012/);
    assert.match(error.message, /outcome is unknown/);
    assert.ok(!error.message.includes('private'));
    return true;
  });
  assert.equal(calls, 1);
});

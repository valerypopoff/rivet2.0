import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { once } from 'node:events';
import { requestHttp2 } from './qualification/provider-request-continuity.mjs';

async function fixture(t, handle) {
  const server = http2.createServer();
  const connections = new Set();
  server.on('session', (session) => {
    connections.add(session);
    session.on('error', () => {});
    session.once('close', () => connections.delete(session));
  });
  server.on('stream', (stream) => {
    stream.on('error', () => {});
    handle(stream);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
  client.on('error', () => {});
  t.after(async () => {
    client.destroy();
    for (const session of connections) session.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await once(client, 'connect');
  return client;
}

test('HTTP/2 qualification deadline expires even while response bytes keep arriving', { timeout: 5000 }, async (t) => {
  let chunks = 0,
    requests = 0;
  const session = await fixture(t, (stream) => {
    requests++;
    stream.respond({ ':status': 200 });
    const timer = setInterval(() => {
      chunks++;
      stream.write('.');
    }, 5);
    stream.once('close', () => clearInterval(timer));
  });
  await assert.rejects(requestHttp2(session, '/', { body: 'probe', timeoutMs: 500 }), /deadline exceeded/);
  assert.ok(chunks > 1, 'The response stayed active throughout the bounded request');
  assert.equal(requests, 1, 'A failed POST must never be retried');
});

test(
  'HTTP/2 reset before response headers rejects rather than leaving settlement pending',
  { timeout: 5000 },
  async (t) => {
    const session = await fixture(t, (stream) => stream.close(http2.constants.NGHTTP2_CANCEL));
    await assert.rejects(requestHttp2(session, '/', { timeoutMs: 1000 }), /closed before response headers/);
  },
);

test('HTTP/2 partial response cannot count as a complete protected body', { timeout: 5000 }, async (t) => {
  const session = await fixture(t, (stream) => {
    stream.respond({ ':status': 200, 'content-length': '100' });
    stream.write('partial');
    setImmediate(() => stream.close(http2.constants.NGHTTP2_CANCEL));
  });
  await assert.rejects(requestHttp2(session, '/', { timeoutMs: 1000 }), /interrupted|closed|Stream/);
});

test('HTTP/2 complete body settles and releases its deadline', { timeout: 5000 }, async (t) => {
  const session = await fixture(t, (stream) => {
    stream.respond({ ':status': 200 });
    stream.end('complete');
  });
  const response = await requestHttp2(session, '/', { timeoutMs: 1000 });
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), 'complete');
});

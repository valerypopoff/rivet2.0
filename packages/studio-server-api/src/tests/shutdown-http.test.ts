import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, get, type ServerResponse } from 'node:http';
import test from 'node:test';
import { AcceptedWork } from '../../../studio-server-shared/process-retirement.js';
import { closeHttpServerBeforeDeadline } from '../shutdown-deadline.js';
import { listenTestServer } from './helpers/http-server-harness.js';

test('ordinary shutdown flushes an ended response before Node closes idle sockets', { timeout: 10000 }, async (t) => {
  const work = new AcceptedWork();
  const payload = Buffer.alloc(16 * 1024 * 1024, 'r');
  let outgoing!: ServerResponse;
  const server = createServer((_req, res) => {
    outgoing = res;
    const release = work.acquire()!;
    res.once('finish', release);
    res.once('close', release);
    res.setHeader('Content-Length', payload.length);
    res.end(payload);
  });
  const api = await listenTestServer(server);
  const request = get(api.baseUrl);
  t.after(async () => {
    request.destroy();
    server.closeAllConnections();
    if (server.listening) await api.close();
  });
  const [incoming] = await once(request, 'response');
  incoming.pause();
  assert.equal(outgoing.writableEnded, true);
  if (process.platform === 'linux') assert.equal(outgoing.writableFinished, false, 'exercise buffered Linux response');
  const received = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.once('end', () => resolve(Buffer.concat(chunks)));
    incoming.once('error', reject);
  });
  const closing = closeHttpServerBeforeDeadline(server, work, Date.now() + 5000);
  incoming.resume();
  const bytes = await received;
  assert.equal(incoming.complete, true);
  assert.equal(bytes.length, payload.length);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(payload).digest('hex'));
  assert.equal(await closing, true);
  assert.equal(work.count, 0);
  assert.equal(work.isAccepting, false);
});

test('unfinished accepted work cannot extend the shutdown deadline', { timeout: 5000 }, async (t) => {
  const work = new AcceptedWork();
  const server = createServer((_req, res) => {
    const release = work.acquire()!;
    res.once('close', release);
    res.write('accepted');
  });
  const api = await listenTestServer(server);
  const request = get(api.baseUrl);
  t.after(async () => {
    request.destroy();
    server.closeAllConnections();
    if (server.listening) await api.close();
  });
  const [incoming] = await once(request, 'response');
  incoming.on('error', () => {});
  incoming.resume();
  assert.equal(await closeHttpServerBeforeDeadline(server, work, Date.now() + 30), false);
  assert.equal(server.listening, false, 'the listener must still close when grace expires');
  // The caller owns the existing forced-close policy after a false result.
  server.closeAllConnections();
});

test('an unstarted HTTP server needs no shutdown wait', async () => {
  const server = createServer();
  assert.equal(await closeHttpServerBeforeDeadline(server, new AcceptedWork(), Date.now() + 1000), true);
});

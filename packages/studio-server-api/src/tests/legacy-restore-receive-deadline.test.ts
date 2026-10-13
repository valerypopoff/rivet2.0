import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import {
  configureRequestReceiveDeadlines,
  RESTORE_UPLOAD_RECEIVE_TIMEOUT_MS,
} from '../legacy-restore/receive-deadline.js';

async function slowRequest(server: Server, path: string, method = 'POST'): Promise<number | undefined> {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: address.port, path, method,
      headers: { 'content-type': 'application/gzip', 'content-length': '4' },
      signal: AbortSignal.timeout(5_000),
    }, (res) => {
      res.on('error', reject);
      res.on('end', () => { clearTimeout(finishBody); resolve(res.statusCode); });
      res.resume();
    });
    req.on('error', (error) => { clearTimeout(finishBody); reject(error); });
    req.write('a');
    const finishBody = setTimeout(() => req.end('bcd'), 250);
  });
}

test('slow restore uploads survive Express mount rewriting, while ordinary bodies still expire', async () => {
  const app = express();
  const router = express.Router();
  const mountedPaths: string[] = [];
  router.use((req, res) => {
    mountedPaths.push(req.url);
    req.on('error', () => {}); // Expected when an ordinary receive deadline closes the request.
    req.resume();
    req.on('end', () => { if (!res.headersSent) res.end('received'); });
  });
  app.use('/api/legacy-restore', router);
  const server = createServer(app);
  configureRequestReceiveDeadlines(server, true, 50);
  assert.equal(server.requestTimeout, RESTORE_UPLOAD_RECEIVE_TIMEOUT_MS);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    assert.equal(await slowRequest(server, '/api/legacy-restore/upload'), 200);
    assert.equal(await slowRequest(server, '/api/legacy-restore/upload?fixture=1'), 200);
    assert.equal(await slowRequest(server, '/api/legacy-restore/start'), 408);
    assert.equal(await slowRequest(server, '/api/legacy-restore/upload-extra'), 408);
    assert.equal(await slowRequest(server, '/api/legacy-restore/upload', 'PUT'), 408);
    assert.deepEqual(mountedPaths, ['/upload', '/upload?fixture=1', '/start', '/upload-extra', '/upload']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('restore-disabled servers retain the ordinary Node request timeout and no extra listener', () => {
  const server = createServer();
  configureRequestReceiveDeadlines(server, false);
  assert.equal(server.requestTimeout, 120_000);
  assert.equal(server.listenerCount('request'), 0);
});

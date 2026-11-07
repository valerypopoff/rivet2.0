import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { Agent, createServer, get, request, type ServerResponse } from 'node:http';
import test from 'node:test';
import { AcceptedWork, ProcessRetirement } from '../../../studio-server-shared/process-retirement.js';
import { createRetirementHttpConnections } from '../retirement-http-connections.js';
import { listenTestServer } from './helpers/http-server-harness.js';

test(
  'withdrawal and another completed response cannot truncate buffered HTML after end()',
  { timeout: 10000 },
  async (t) => {
    const html = Buffer.alloc(16 * 1024 * 1024, 'h');
    let largeResponse!: ServerResponse;
    const server = createServer((req, res) => {
      connections.observeResponse(res);
      if (req.url === '/apps/large') {
        largeResponse = res;
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Length', html.length);
        res.end(html);
      } else res.end('ok');
    });
    const owner = new ProcessRetirement(
      randomUUID(),
      () => {},
      async () => {},
      () => connections.closeIdleConnections(),
    );
    const connections = createRetirementHttpConnections(server, () => owner.isWithdrawing);
    const http = await listenTestServer(server);
    const client = get(http.baseUrl + '/apps/large');
    t.after(async () => {
      client.destroy();
      await http.close();
    });
    const [response] = await once(client, 'response');
    response.pause();
    assert.equal(largeResponse.writableEnded, true);
    if (process.platform === 'linux')
      assert.equal(largeResponse.writableFinished, false, 'exercise Linux backpressure');
    const completed = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve(Buffer.concat(chunks)));
      response.once('error', reject);
    });
    const id = randomUUID();
    owner.withdraw(id, owner.incarnation);
    const other = await fetch(http.baseUrl + '/healthz');
    assert.equal(other.headers.get('connection'), 'close');
    assert.equal(await other.text(), 'ok');
    owner.begin(id, owner.incarnation);
    response.resume();
    const received = await completed;
    assert.equal(received.length, html.length);
    assert.equal(createHash('sha256').update(received).digest('hex'), createHash('sha256').update(html).digest('hex'));
  },
);

test(
  'idle closure does not wait for an unfinished accepted request or close an upgraded connection',
  { timeout: 10000 },
  async (t) => {
    const work = new AcceptedWork();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered!: () => void;
    const accepted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = createServer((req, res) => {
      connections.observeResponse(res);
      if (req.url === '/idle') return void res.end('idle');
      const release = work.acquire()!;
      res.once('finish', release);
      res.write('accepted');
      entered();
      void pending.then(() => res.end(' completed'));
    });
    let upgradedPeer: import('node:stream').Duplex | undefined;
    server.on('upgrade', (_req, socket) => {
      upgradedPeer = socket;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
    });
    const owner = new ProcessRetirement(
      randomUUID(),
      () => work.beginDrain(),
      () => work.drain(),
      () => connections.closeIdleConnections(),
    );
    const connections = createRetirementHttpConnections(server, () => owner.isWithdrawing);
    const http = await listenTestServer(server);
    const idleAgent = new Agent({ keepAlive: true });
    const idleRequest = get(http.baseUrl + '/idle', { agent: idleAgent });
    const [idleResponse] = await once(idleRequest, 'response');
    const idleSocket = idleResponse.socket!;
    const idleClosed = once(idleSocket, 'close');
    idleResponse.resume();
    await once(idleResponse, 'end');
    const upgradedRequest = request(http.baseUrl, { headers: { connection: 'Upgrade', upgrade: 'test' } });
    let upgradedSocket: import('node:net').Socket | undefined;
    t.after(async () => {
      finish();
      idleAgent.destroy();
      upgradedSocket?.destroy();
      upgradedPeer?.destroy();
      upgradedRequest.destroy();
      await http.close();
    });
    const upgraded = once(upgradedRequest, 'upgrade');
    upgradedRequest.end();
    const [, socket] = await upgraded;
    upgradedSocket = socket;
    const response = await fetch(http.baseUrl);
    await accepted;
    const id = randomUUID();
    owner.withdraw(id, owner.incarnation);
    await idleClosed;
    assert.equal(socket.destroyed, false);
    owner.begin(id, owner.incarnation);
    assert.equal(owner.snapshot().state, 'draining');
    finish();
    assert.equal(await response.text(), 'accepted completed');
    await new Promise(setImmediate);
    assert.equal(owner.snapshot().state, 'drained');
  },
);

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { LatestDebuggerRelay } from '../ha-latest-relay.js';
import type { OwnerRoutingConfig } from '../ha-owner-routing.js';

test('HA peer reconnect acknowledges large history, while old or stale-incarnation peers still receive replay', async () => {
  const servers = [createServer(), createServer()],
    sockets = servers.map(() => new WebSocketServer({ noServer: true }));
  const ports: number[] = [],
    relays: LatestDebuggerRelay[] = [],
    clients: WebSocket[] = [];
  const links: WebSocket[][] = [[], []],
    wire: string[][] = [],
    options: WebSocket.ClientOptions[][] = [[], []];
  const configs: OwnerRoutingConfig[] = [];
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, 'Peer replay did not converge');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    for (const server of servers) {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      ports.push((server.address() as { port: number }).port);
    }
    for (let i = 0; i < 2; i++) {
      const config: OwnerRoutingConfig = {
        pod: `backend-${i}`,
        backendName: 'backend',
        headless: 'unused',
        apiPort: ports[i]!,
        executorPort: 21889,
        installation: 'fixture',
        key: 'k'.repeat(32),
        incarnation: randomUUID(),
      };
      configs.push(config);
      const relay = new LatestDebuggerRelay(config, sockets[i]!, 2, (url, opt) => {
        options[i]!.push(opt);
        const socket = new WebSocket(
          `ws://127.0.0.1:${ports[Number(/backend-(\d)/.exec(url)![1])]}/internal/ha/latest`,
          opt,
        );
        links[i]!.push(socket);
        return socket;
      });
      relays.push(relay);
      sockets[i]!.prependListener('connection', (client, req) => {
        if (i !== 0 || req.url !== '/internal/ha/latest') return;
        const ids: string[] = [];
        wire.push(ids);
        const send = client.send.bind(client);
        client.send = ((payload: string, callback: (error?: Error) => void) => {
          ids.push(JSON.parse(payload).rivetEventId);
          send(payload, callback);
        }) as typeof client.send;
      });
      servers[i]!.on('upgrade', (req, socket, head) => {
        if (!relay.authorize(req) && req.url === '/internal/ha/latest') {
          socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
          return;
        }
        sockets[i]!.handleUpgrade(req, socket, head, (client) => sockets[i]!.emit('connection', client, req));
      });
      if (i === 0)
        for (let n = 0; n < 20; n++)
          relay.transformBroadcast(
            JSON.stringify({ message: 'done', data: { marker: n, padding: 'x'.repeat(1024 * 1024) } }),
          );
    }
    await wait(() => relays.every((r) => r.ready));
    const observer = new WebSocket(`ws://127.0.0.1:${ports[1]}/ws/latest-debugger`);
    clients.push(observer);
    const received: string[] = [];
    observer.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.rivetEventId) received.push(m.rivetEventId);
      assert.notEqual(m.message, 'error');
    });
    await wait(() => received.length === 20);
    assert.equal(new Set(received).size, 20);
    const original = links[1]!.at(-1)!;
    original.terminate();
    await wait(() => links[1]!.at(-1) !== original && links[1]!.at(-1)!.readyState === WebSocket.OPEN);
    assert.equal(
      (options[1]!.at(-1)!.headers as Record<string, string>)['x-rivet-ha-after'],
      `${configs[0]!.incarnation}:20`,
    );
    const next = relays[0]!.transformBroadcast(
      JSON.stringify({ message: 'done', data: { marker: 'after-reconnect' } }),
    );
    for (const client of sockets[0]!.clients) relays[0]!.sendBroadcast(client, next);
    await wait(() => received.length === 21);
    assert.deepEqual(wire.at(-1), [JSON.parse(next).rivetEventId], 'acknowledged history must not be retransmitted');
    assert.equal(new Set(received).size, 21);
    // No header (old peer), wrong incarnation and future cursor all fall back
    // to retained history instead of silently suppressing existing observations.
    for (const after of [undefined, `${randomUUID()}:20`, `${configs[0]!.incarnation}:999999`]) {
      const headers = {
        ...(options[1]![0]!.headers as Record<string, string>),
        ...(after ? { 'x-rivet-ha-after': after } : {}),
      };
      const peer = new WebSocket(`ws://127.0.0.1:${ports[0]}/internal/ha/latest`, { headers });
      clients.push(peer);
      let count = 0;
      peer.on('message', () => count++);
      await wait(() => count === 21);
      assert.equal(peer.readyState, WebSocket.OPEN);
      peer.terminate();
    }
  } finally {
    clients.forEach((s) => {
      s.on('error', () => {});
      s.terminate();
    });
    relays.forEach((r) => r.dispose());
    for (const server of sockets) {
      server.clients.forEach((s) => s.terminate());
      await new Promise<void>((r) => server.close(() => r()));
    }
    for (const server of servers) await new Promise<void>((r) => server.close(() => r()));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { LatestDebuggerRelay } from '../ha-latest-relay.js';
import type { OwnerRoutingConfig } from '../ha-owner-routing.js';

test('singleton debugger readiness needs no absent neighbour and closes on disposal', async () => {
  const previous = process.env.RIVET_HA_CONTROL_PLANE_MODE;
  const server = new WebSocketServer({ noServer: true });
  const relay = new LatestDebuggerRelay({ pod: 'backend-0', backendName: 'backend', headless: 'headless',
    apiPort: 1, executorPort: 21889, installation: 'fixture', key: 'k'.repeat(32), incarnation: randomUUID() },
    server, 2, (_url, options) => new WebSocket('ws://127.0.0.1:1/internal/ha/latest', options));
  try {
    process.env.RIVET_HA_CONTROL_PLANE_MODE = 'replicated';
    assert.equal(relay.ready, false);
    process.env.RIVET_HA_CONTROL_PLANE_MODE = 'singleton';
    assert.equal(relay.ready, true);
    const event = JSON.parse(relay.transformBroadcast(JSON.stringify({ message: 'start', data: { runId: 'local' } })));
    assert.equal(event.data.runId, 'local');
    relay.dispose();
    assert.equal(relay.ready, false);
  } finally {
    relay.dispose();
    if (previous === undefined) delete process.env.RIVET_HA_CONTROL_PLANE_MODE;
    else process.env.RIVET_HA_CONTROL_PLANE_MODE = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('HA latest observation is global, reconnect deduplicates identity, controls traverse each owner once', async () => {
  const servers = [createServer(), createServer()];
  const sockets = servers.map(() => new WebSocketServer({ noServer: true }));
  const ports: number[] = [];
  for (const server of servers) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    ports.push((server.address() as { port: number }).port);
  }
  const relays: LatestDebuggerRelay[] = [], controls = [0, 0], observed: string[] = [];
  const observers: WebSocket[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const config: OwnerRoutingConfig = { pod: `backend-${i}`, backendName: 'backend', headless: 'headless', apiPort: ports[i]!, executorPort: 21889,
        installation: 'fixture', key: 'k'.repeat(32), incarnation: randomUUID() };
      const relay = new LatestDebuggerRelay(config, sockets[i]!, 2, (url, options) => {
        const peer = /backend-(\d)/.exec(url)![1]!;
        return new WebSocket(`ws://127.0.0.1:${ports[Number(peer)]}/internal/ha/latest`, options);
      }); relays.push(relay);
      servers[i]!.on('upgrade', (req, socket, head) => {
        if (req.url === '/internal/ha/latest' && !relay.authorize(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
        sockets[i]!.handleUpgrade(req, socket, head, client => sockets[i]!.emit('connection', client, req));
      });
      sockets[i]!.on('connection', client => client.on('message', raw => {
        controls[i]!++; relay.onControl(client, raw.toString());
      }));
    }
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 6000;
      while (!condition()) { if (Date.now() > deadline) throw Error('Relay did not converge'); await new Promise(r => setTimeout(r, 10)); }
    };
    await waitFor(() => relays.every(r => r.ready));
    const observer = new WebSocket(`ws://127.0.0.1:${ports[1]}/ws/latest-debugger`); observers.push(observer);
    observer.on('message', raw => observed.push(raw.toString()));
    await new Promise<void>(resolve => observer.once('open', resolve));
    const event = relays[0]!.transformBroadcast(JSON.stringify({ message: 'start', data: { runId: 'original-owner' } }));
    for (const client of sockets[0]!.clients) client.send(event);
    await waitFor(() => observed.some(x => x.includes('original-owner')));
    assert.equal(observed.filter(x => x.includes('original-owner')).length, 1);
    observer.send(JSON.stringify({ type: 'abort' }));
    await waitFor(() => controls[0] === 1 && controls[1] === 1);
    await new Promise(r => setTimeout(r, 50)); assert.deepEqual(controls, [1, 1]);
    observer.terminate();
    const resumed = new WebSocket(`ws://127.0.0.1:${ports[0]}/ws/latest-debugger`); observers.push(resumed);
    const replay: string[] = []; resumed.on('message', raw => replay.push(raw.toString()));
    await waitFor(() => replay.some(x => x === event));
    assert.equal(JSON.parse(replay.find(x => x === event)!).rivetEventId, JSON.parse(event).rivetEventId);
    // Model a reconnect whose earliest retained peer event is already past the
    // receiver's cursor. Existing observers need the same explicit warning as
    // observers connecting after truncation; no event or control is replayed.
    relays[1]!.transformBroadcast(JSON.stringify({ message: 'start', data: { runId: 'unavailable-history' } }));
    const afterGap = relays[1]!.transformBroadcast(JSON.stringify({ message: 'done', data: { runId: 'after-gap' } }));
    for (const client of sockets[1]!.clients) client.send(afterGap);
    await waitFor(() => replay.some(x => x.includes('history-gap')) && replay.some(x => x.includes('after-gap')));
    assert.equal(replay.filter(x => x.includes('history-gap')).length, 1);
    for (const client of sockets[1]!.clients) client.send(afterGap);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(replay.filter(x => x.includes('after-gap')).length, 1);
    assert.equal(replay.filter(x => x.includes('history-gap')).length, 1);
    const foreign = new WebSocket(`ws://127.0.0.1:${ports[0]}/internal/ha/latest`, { headers: { origin: 'https://public.invalid' } });
    observers.push(foreign);
    foreign.on('error', () => {});
    await new Promise<void>(resolve => foreign.once('unexpected-response', (_req, response) => { assert.equal(response.statusCode, 401); response.resume(); foreign.terminate(); resolve(); }));
  } finally {
    observers.forEach(s => { s.on('error', () => {}); s.terminate(); }); relays.forEach(r => r.dispose());
    for (const wss of sockets) { wss.clients.forEach(s => s.terminate()); await new Promise<void>(resolve => wss.close(() => resolve())); }
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

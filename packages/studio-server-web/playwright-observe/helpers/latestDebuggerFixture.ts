import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { GraphProcessor } from '@valerypopoff/rivet2-core';
import { startDebuggerServer } from '../../../node/src/debugger.js';
import { LatestDebuggerRelay } from '../../../studio-server-api/src/ha-latest-relay.js';

// Use the owning API's ws version. All sockets and generated data are local;
// browser API/bootstrap responses remain owned by each Playwright scenario.
const { WebSocketServer, WebSocket } = createRequire(
  new URL('../../../studio-server-api/src/ha-latest-relay.ts', import.meta.url),
)('ws') as typeof import('ws');

export async function createLatestDebuggerFixture(options: { ha: boolean; throttlePartialOutputs?: number }) {
  const listeners = [createServer(), ...(options.ha ? [createServer()] : [])];
  const sockets = listeners.map(() => new WebSocketServer({ noServer: true }));
  const ports: number[] = [];
  for (const listener of listeners) {
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    ports.push((listener.address() as { port: number }).port);
  }
  let peerSequence = 0,
    sourceSequence = 0,
    connections = 0,
    observerOwner = options.ha ? 1 : 0;
  const observers = new Set<InstanceType<typeof WebSocket>>();
  const commands: string[] = [];
  const relays = options.ha
    ? sockets.map(
        (server, index) =>
          new LatestDebuggerRelay(
            {
              pod: `backend-${index}`,
              backendName: 'backend',
              headless: 'unused',
              apiPort: ports[index]!,
              executorPort: 21889,
              installation: 'ui-replay-fixture',
              key: 'k'.repeat(32),
              incarnation: randomUUID(),
            },
            server,
            2,
            (url, connectOptions) => {
              const owner = Number(/backend-(\d)/.exec(url)![1]);
              const socket = new WebSocket(`ws://127.0.0.1:${ports[owner]}/internal/ha/latest`, connectOptions);
              if (index === 1)
                socket.on('message', (raw) => {
                  const sequence = /^\{"rivetEventId":"[^" ]+:(\d+)",/.exec(raw.toString())?.[1];
                  if (sequence) peerSequence = Number(sequence);
                });
              return socket;
            },
          ),
      )
    : [];
  const debuggers = sockets.map((server, index) =>
    startDebuggerServer({
      server: server as NonNullable<Parameters<typeof startDebuggerServer>[0]>['server'],
      heartbeatIntervalMs: 0,
      throttlePartialOutputs: options.throttlePartialOutputs,
      transformBroadcast: relays[index]
        ? (payload) => {
            const encoded = relays[index]!.transformBroadcast(payload);
            if (index === 0) {
              const sequence = /^\{"rivetEventId":"[^" ]+:(\d+)",/.exec(encoded)?.[1];
              if (sequence) sourceSequence = Number(sequence);
            }
            return encoded;
          }
        : undefined,
      sendBroadcast: relays[index]?.sendBroadcast,
      onControl: relays[index]?.onControl,
    }),
  );
  listeners.forEach((listener, index) =>
    listener.on('upgrade', (request, socket, head) => {
      const internal = request.url === '/internal/ha/latest';
      if (internal && !relays[index]?.authorize(request)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      // Stable browser address, selectable owner: model an upgrade-time LB handoff.
      const target = sockets[internal ? index : observerOwner]!;
      target.handleUpgrade(request, socket, head, (client) => target.emit('connection', client, request));
    }),
  );
  for (const server of sockets)
    server.on('connection', (client, request) => {
      if (request.url === '/internal/ha/latest') return;
      connections++;
      observers.add(client);
      client.once('close', () => observers.delete(client));
      client.on('message', (data) => commands.push(data.toString()));
    });
  let history = 0;
  return {
    debuggerServer: debuggers[0]!,
    peerDebugger: debuggers[1],
    port: ports[0]!,
    commands,
    ready: () => relays.every((relay) => relay.ready),
    peerSequence: () => peerSequence,
    connectionCount: () => connections,
    clientCount: () => observers.size,
    routeToOwner(index: number) {
      if (!sockets[index]) throw new Error('Unknown local debugger owner');
      observerOwner = index;
    },
    disconnectObservers() {
      for (const client of observers) client.terminate();
    },
    warmHistory() {
      const burst = ++history;
      for (let i = 0; i < 40; i++)
        debuggers[0]!.broadcast({} as GraphProcessor, 'done', {
          execution: { projectId: 'unrelated-history', rootRunId: `history-${burst}-${i}` },
          results: { padding: { type: 'string', value: 'x'.repeat(1024 * 1024) } },
        });
      return sourceSequence;
    },
    async close() {
      relays.forEach((relay) => relay.dispose());
      for (const server of sockets) {
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      for (const listener of listeners) await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

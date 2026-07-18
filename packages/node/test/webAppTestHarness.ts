import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import {
  createRivetWebAppWebSocketGateway,
  type Project,
  type RivetWebAppServerMessage,
  type RivetWebAppSocketSession,
  type UiGraphId,
} from '../src/index.js';

const openServers: Server[] = [];
const openSockets: WebSocket[] = [];

export async function closeWebAppTestHarnesses(): Promise<void> {
  for (const socket of openSockets.splice(0)) socket.close();
  await Promise.all(
    openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
}

export async function createWebAppSocketHarness(
  project: Project,
  onActionStart?: () => void,
  gatewayOptions: Parameters<typeof createRivetWebAppWebSocketGateway>[0] = {},
  sessionOptions: Pick<
    RivetWebAppSocketSession,
    'createProcessorOptions' | 'onProcessorPrepared' | 'onRunFailed' | 'onRunFinished' | 'storedValueStore'
  > = {},
) {
  const server = createServer();
  const socketServer = new WebSocketServer({ server });
  const gateway = createRivetWebAppWebSocketGateway({
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    ...gatewayOptions,
  });
  const uiGraph = project.uiGraphs!['ui-graph' as UiGraphId]!;
  socketServer.on('connection', (socket, request) => {
    const ownerScope =
      new URL(request.url ?? '/', 'http://rivet.local').searchParams.get('owner') ?? 'user:project:app:revision';
    gateway.handleConnection(socket, {
      ...sessionOptions,
      onActionStart,
      ownerScope,
      project,
      revisionKey: 'revision-1',
      uiGraph,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}`;

  return {
    gateway,
    url,
    async connect(ownerScope = 'user:project:app:revision', sendHello = true) {
      const socket = new WebSocket(`${url}?owner=${encodeURIComponent(ownerScope)}`);
      openSockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      if (sendHello) socket.send(JSON.stringify({ type: 'client.hello', protocolVersion: 1 }));
      return socket;
    },
  };
}

export function collectWebAppSocketMessages(socket: WebSocket) {
  const received: RivetWebAppServerMessage[] = [];
  const waiters = new Set<() => void>();
  socket.on('message', (raw) => {
    received.push(JSON.parse(raw.toString()) as RivetWebAppServerMessage);
    for (const wake of waiters) wake();
    waiters.clear();
  });

  const nextOf = async <Type extends RivetWebAppServerMessage['type']>(types: Type[], timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = received.findIndex((message) => types.includes(message.type as Type));
      if (index >= 0) {
        return received.splice(index, 1)[0] as Extract<RivetWebAppServerMessage, { type: Type }>;
      }
      await waitForMessage(waiters, deadline);
    }
    throw new Error(`Timed out waiting for ${types.join(' or ')}.`);
  };

  return {
    next: <Type extends RivetWebAppServerMessage['type']>(type: Type, timeoutMs = 3_000) => nextOf([type], timeoutMs),
    nextOf,
  };
}

export function makeWebAppStartMessage(requestId: string) {
  return {
    type: 'action.start',
    componentId: 'run-button',
    requestId,
    revisionKey: 'revision-1',
    state: { prompt: 'Hello' },
  } as const;
}

export function waitForWebAppSocketClose(socket: WebSocket): Promise<{ code: number; reason: Buffer }> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 1006, reason: Buffer.alloc(0) });
  return new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason })));
}

export function trackWebAppTestSocket(socket: WebSocket): WebSocket {
  openSockets.push(socket);
  return socket;
}

function waitForMessage(waiters: Set<() => void>, deadline: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wake = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(
      () => {
        waiters.delete(wake);
        reject(new Error('Timed out waiting for a WebSocket message.'));
      },
      Math.max(1, deadline - Date.now()),
    );
    waiters.add(wake);
  });
}

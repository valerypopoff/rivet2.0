import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { LatestDebuggerRelay } from '../ha-latest-relay.js';
import type { OwnerRoutingConfig } from '../ha-owner-routing.js';
import { startDebuggerServer } from '@valerypopoff/rivet2-node';
import type { GraphProcessor } from '@valerypopoff/rivet2-core';

const waitFor = async (condition: () => boolean, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Debugger observation did not settle');
    await new Promise((r) => setTimeout(r, 10));
  }
};

class DormantPeer extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  terminate() {
    this.emit('close');
  }
}

async function fixture() {
  const http = createServer(),
    server = new WebSocketServer({ noServer: true });
  const config: OwnerRoutingConfig = {
    pod: 'backend-0',
    backendName: 'backend',
    headless: 'unused',
    apiPort: 8080,
    executorPort: 21889,
    installation: 'replay-fixture',
    key: 'k'.repeat(32),
    incarnation: randomUUID(),
  };
  const relay = new LatestDebuggerRelay(config, server, 2, () => new DormantPeer() as unknown as WebSocket);
  let encoded = '';
  let completedWrites = 0;
  const debuggerServer = startDebuggerServer({
    server: server as NonNullable<Parameters<typeof startDebuggerServer>[0]>['server'],
    heartbeatIntervalMs: 0,
    transformBroadcast: (payload) => {
      encoded = relay.transformBroadcast(payload);
      return encoded;
    },
    sendBroadcast: (client, payload, onWritten) =>
      relay.sendBroadcast(client as WebSocket, payload, () => {
        completedWrites++;
        onWritten();
      }),
  });
  let maxWrites = 0;
  server.prependListener('connection', (client) => {
    let writes = 0;
    const send = client.send.bind(client);
    client.send = ((payload: string, callback: (error?: Error) => void) => {
      maxWrites = Math.max(maxWrites, ++writes);
      send(payload, (error?: Error) => {
        writes--;
        callback(error);
      });
    }) as typeof client.send;
  });
  http.on('upgrade', (req, socket, head) =>
    server.handleUpgrade(req, socket, head, (client) => server.emit('connection', client, req)),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const clients: WebSocket[] = [];
  const observe = async () => {
    const client = new WebSocket(`ws://127.0.0.1:${(http.address() as { port: number }).port}/ws/latest-debugger`);
    clients.push(client);
    const messages: { message: string; rivetEventId?: string; data?: { code?: string; marker?: string } }[] = [];
    client.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      delete m.data?.padding;
      messages.push(m);
    });
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    return { client, messages };
  };
  const broadcast = (marker: string, bytes = 0, extra: Record<string, unknown> = {}, message = 'done') => {
    debuggerServer.broadcast({} as GraphProcessor, message, { marker, padding: 'x'.repeat(bytes), ...extra });
    return JSON.parse(encoded).rivetEventId as string;
  };
  return {
    relay,
    server,
    observe,
    broadcast,
    maxWrites: () => maxWrites,
    completedWrites: () => completedWrites,
    close: async () => {
      clients.forEach((c) => c.terminate());
      relay.dispose();
      server.clients.forEach((c) => c.terminate());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

for (const size of [12, 40])
  test(`HA replay delivers ${size} MiB history without disconnect and orders live events afterwards`, async () => {
    const f = await fixture();
    try {
      const ids = Array.from({ length: size }, (_, i) => f.broadcast(`history-${i}`, 1024 * 1024));
      for (let attempt = 0; attempt < 3; attempt++) {
        const { client, messages } = await f.observe();
        const last = f.broadcast(`live-${attempt}`);
        await waitFor(() => messages.some((m) => m.rivetEventId === last));
        const retained = size === 40 ? ids.slice(-31) : ids;
        const events = messages.filter((m) => m.rivetEventId).map((m) => m.rivetEventId!);
        assert.deepEqual(events.slice(0, retained.length), retained);
        assert.equal(events.at(-1), last);
        assert.equal(new Set(events).size, events.length);
        assert.equal(messages[0]!.message, 'latest-session');
        assert.ok(!messages.some((m) => m.message === 'error'));
        if (size === 40) assert.equal(messages.filter((m) => m.data?.code === 'history-truncated').length, 1);
        assert.equal(client.readyState, WebSocket.OPEN);
        assert.equal(f.maxWrites(), 1, 'replay and live writes must never race');
        assert.ok(f.completedWrites() > 0, 'successful adapter delivery must reach the heartbeat callback');
        client.terminate();
      }
    } finally {
      await f.close();
    }
  });

test('a single event larger than the former transport queue still permits the next terminal event', async () => {
  const f = await fixture();
  try {
    f.broadcast('large', 12 * 1024 * 1024);
    const { client, messages } = await f.observe();
    const last = f.broadcast('terminal');
    await waitFor(() => messages.some((m) => m.rivetEventId === last));
    assert.deepEqual(
      messages.filter((m) => m.rivetEventId).map((m) => m.data?.marker),
      ['large', 'terminal'],
    );
    assert.equal(client.readyState, WebSocket.OPEN);
    assert.equal(f.maxWrites(), 1);
  } finally {
    await f.close();
  }
});

test('oversized diagnostic values do not erase retained history or disconnect observers', async () => {
  const f = await fixture();
  try {
    const retained = f.broadcast('retained');
    const { client, messages } = await f.observe();
    await waitFor(() => messages.some((m) => m.rivetEventId === retained));
    f.broadcast('oversized', 33 * 1024 * 1024);
    const last = f.broadcast('after-oversized');
    await waitFor(() => messages.some((m) => m.rivetEventId === last));
    assert.equal(messages.filter((m) => m.data?.code === 'event-too-large').length, 1);
    assert.ok(!messages.some((m) => m.data?.marker === 'oversized' || m.message === 'error'));
    const resumed = await f.observe();
    await waitFor(() => resumed.messages.some((m) => m.rivetEventId === last));
    assert.ok(resumed.messages.some((m) => m.rivetEventId === retained));
    assert.equal(client.readyState, WebSocket.OPEN);
  } finally {
    await f.close();
  }
});

test('oversized nonterminal diagnostics remain omitted rather than growing transport queues', async () => {
  const f = await fixture();
  try {
    const { messages } = await f.observe();
    assert.equal(
      f.relay.transformBroadcast(JSON.stringify({ message: 'trace', data: 'x'.repeat(33 * 1024 * 1024) })),
      '',
    );
    const fence = f.broadcast('after-omitted-trace');
    await waitFor(() => messages.some((m) => m.rivetEventId === fence));
    assert.ok(!messages.some((m) => m.message === 'trace'));
    assert.equal(messages.filter((m) => m.data?.code === 'event-too-large').length, 1);
  } finally {
    await f.close();
  }
});

test('oversized terminal snapshots cannot bypass the bound through metadata or node configuration', async () => {
  const f = await fixture();
  try {
    const payload = f.relay.transformBroadcast(
      JSON.stringify({
        message: 'nodeFinish',
        requestId: 'kept-request',
        data: {
          execution: {
            rootRunId: 'kept-root',
            graphRunId: 'kept-graph-run',
            graphId: 'main',
            projectId: 'kept-project',
            projectScope: 's'.repeat(20 * 1024),
          },
          node: { id: 'kept-node', type: 'code', data: { code: 'x'.repeat(33 * 1024 * 1024) } },
          processId: 'kept-process',
          resultOrigin: 'executed',
          durationMs: 7,
        },
      }),
    );
    assert.ok(Buffer.byteLength(payload) < 64 * 1024);
    const message = JSON.parse(payload);
    assert.equal(message.requestId, 'kept-request');
    assert.deepEqual(message.data.execution, {
      rootRunId: 'kept-root',
      graphRunId: 'kept-graph-run',
      graphId: 'main',
      projectId: 'kept-project',
    });
    assert.equal(message.data.node.id, 'kept-node');
    assert.equal(message.data.processId, 'kept-process');
    assert.equal(message.data.resultOrigin, 'executed');
    assert.equal(message.data.durationMs, 7);
  } finally {
    await f.close();
  }
});

for (const message of [
  'done',
  'error',
  'abort',
  'nodeFinish',
  'nodeError',
  'nodeExcluded',
  'graphFinish',
  'graphError',
  'graphAbort',
])
  test(`an oversized ${message} preserves terminal identity for live and reconnecting observers`, async () => {
    const f = await fixture();
    try {
      const { messages } = await f.observe();
      const execution = {
        rootRunId: 'large-result-run',
        graphRunId: 'large-result-graph-run',
        graphId: 'main',
        projectId: 'large-result-project',
      };
      const id = f.broadcast(
        'oversized-terminal',
        33 * 1024 * 1024,
        {
          execution,
          successful: true,
          error: 'Original workflow failure',
          node: { id: 'large-node', type: 'text', data: {}, visualData: { x: 0, y: 0 } },
          processId: 'large-process',
          graph: { metadata: { id: 'main' }, nodes: [], connections: [] },
          durationMs: 123,
        },
        message,
      );
      const fence = f.broadcast('after-terminal');
      await waitFor(() => messages.some((m) => m.rivetEventId === fence));
      const terminal = messages.find((m) => m.rivetEventId === id);
      assert.equal(terminal?.message, message, 'diagnostic size limits must not strand the displayed run');
      assert.deepEqual((terminal?.data as Record<string, unknown>)?.execution, execution);
      if (message === 'abort') assert.equal((terminal?.data as Record<string, unknown>)?.successful, true);
      if (message.startsWith('node')) {
        assert.equal((terminal?.data as Record<string, unknown>)?.processId, 'large-process');
        assert.equal((terminal?.data as Record<string, unknown>)?.durationMs, 123);
      }
      const resumed = await f.observe();
      await waitFor(() => resumed.messages.some((m) => m.rivetEventId === fence));
      assert.deepEqual(
        resumed.messages.find((m) => m.rivetEventId === id),
        terminal,
      );
    } finally {
      await f.close();
    }
  });

test('a slow observer catches up after ring eviction instead of retaining an unbounded private backlog', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 20; i++) f.broadcast(`old-${i}`, 1024 * 1024);
    const { client, messages } = await f.observe();
    const transport = (client as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    transport.pause();
    for (let i = 0; i < 9000; i++) f.broadcast(`new-${i}`);
    const last = f.broadcast('caught-up');
    transport.resume();
    await waitFor(() => messages.some((m) => m.rivetEventId === last));
    assert.equal(messages.filter((m) => m.data?.code === 'history-gap').length, 1);
    assert.ok(!messages.some((m) => m.message === 'error'));
    const sequences = messages.flatMap((m) => (m.rivetEventId ? [Number(m.rivetEventId.split(':').at(-1))] : []));
    assert.ok(sequences.every((sequence, i) => i === 0 || sequence > sequences[i - 1]!));
    assert.equal(client.readyState, WebSocket.OPEN);
    assert.equal(f.maxWrites(), 1);
  } finally {
    await f.close();
  }
});

test('a blocked observer does not delay another observer or the live stream', async () => {
  const f = await fixture();
  try {
    const slow = await f.observe();
    const transport = (slow.client as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    transport.pause();
    for (let i = 0; i < 12; i++) f.broadcast(`history-${i}`, 1024 * 1024);
    const healthy = await f.observe();
    const last = f.broadcast('healthy-terminal');
    await waitFor(() => healthy.messages.some((m) => m.rivetEventId === last));
    assert.equal(healthy.client.readyState, WebSocket.OPEN);
    assert.equal(f.maxWrites(), 1, 'each observer owns its independent paced writer');
    transport.resume();
    await waitFor(() => slow.messages.some((m) => m.rivetEventId === last));
  } finally {
    await f.close();
  }
});

for (const action of ['timeout', 'dispose', 'throw', 'error'] as const)
  test(`a ${action} during a write clears the writer and ignores late callbacks`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = new WebSocketServer({ noServer: true });
    const relay = new LatestDebuggerRelay(
      {
        pod: 'backend-0',
        backendName: 'backend',
        headless: 'unused',
        apiPort: 8080,
        executorPort: 21889,
        installation: 'fixture',
        key: 'k'.repeat(32),
        incarnation: randomUUID(),
      },
      server,
      2,
      () => new DormantPeer() as unknown as WebSocket,
    );
    let complete: ((error?: Error) => void) | undefined,
      writes = 0,
      closed = 0;
    const fake = new EventEmitter() as EventEmitter & {
      readyState: number;
      send: (payload: string, callback: (error?: Error) => void) => void;
      terminate: () => void;
    };
    fake.readyState = WebSocket.OPEN;
    fake.send = (_payload, callback) => {
      writes++;
      complete = callback;
      if (action === 'throw') throw Error('write failed');
    };
    fake.terminate = () => {
      closed++;
      fake.readyState = WebSocket.CLOSED;
      fake.emit('close');
    };
    try {
      server.emit('connection', fake, { url: '/ws/latest-debugger', headers: {} } as IncomingMessage);
      if (action === 'dispose') relay.dispose();
      if (action === 'error') complete?.(new Error('write failed'));
      t.mock.timers.tick(60_001);
      complete?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(writes, 1);
      assert.equal(closed, action === 'dispose' ? 0 : 1);
    } finally {
      relay.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

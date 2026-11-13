import assert from 'node:assert/strict';
import test from 'node:test';
import { once, EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { ExecutorReliableInbox, ExecutorReliableOutbox } from '@valerypopoff/rivet2-core';
import { DebuggerSessionDelivery } from '../src/debuggerSessionDelivery.js';
import { projectDebuggerEnvelope } from '../src/debuggerSessionProjection.js';

test('bounded diagnostics preserve progress while omitting large authored data', () => {
  const frame = projectDebuggerEnvelope({
    message: 'progress',
    requestId: 'one',
    data: {
      node: { id: 'node', title: 'node', type: 'code', data: { code: 'x'.repeat(1_000_000) } },
      progress: { message: 'Still working', percent: 30 },
    },
  });
  assert.deepEqual(frame.data.progress, { message: 'Still working', percent: 30 });
  assert.equal(frame.diagnosticsIncomplete, undefined, 'authored code is not an observed input/output');
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 64 * 1024);
  const numbers = projectDebuggerEnvelope({ message: 'trace', data: Array(5000).fill(1.7976931348623157e308) });
  assert.ok(Buffer.byteLength(JSON.stringify(numbers)) < 64 * 1024);
  assert.equal(numbers.diagnosticsIncomplete, true);
  const start = projectDebuggerEnvelope({
    message: 'start',
    data: {
      project: { metadata: { id: 'project' }, graphs: { large: { data: 'x'.repeat(100000) } } },
      startGraph: { metadata: { id: 'main' }, nodes: [] },
      inputs: { small: { type: 'string', value: 'preserved' } },
      contextValues: {},
    },
  });
  assert.equal(start.diagnosticsIncomplete, undefined);
  assert.equal(start.data.inputs.small.value, 'preserved');
  const delivery = new DebuggerSessionDelivery({ bytes: 1024 * 1024, events: 20 }, { bytes: 0 });
  delivery.send({ message: 'trace', requestId: 'custom', data: { toJSON: () => 'x'.repeat(100000) } });
  assert.ok(delivery.events.every((event) => event.bytes < 64 * 1024));
  assert.equal(delivery.incomplete.has('custom'), true);
  delivery.dispose();
});
import { DebuggerSessions } from '../src/debuggerSessions.js';

for (const smallHistory of [false, true])
  test(
    `v2 real socket preserves results through ${smallHistory ? 'evicted history and reconnect' : 'a 52 MiB diagnostic burst'}`,
    { timeout: 15000 },
    async (t) => {
      const sessions = smallHistory
        ? new DebuggerSessions({ sessions: 4, bytes: 1024, events: 4, idleMs: 60000 })
        : new DebuggerSessions();
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        handleProtocols: (_protocols, request) => sessions.selectProtocol(request),
        verifyClient: (info, done) => done(sessions.canAccept(info.req, true), 403),
      });
      await once(server, 'listening');
      const sockets: WebSocket[] = [];
      t.after(async () => {
        for (const socket of sockets) socket.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      let executions = 0;
      let maxBuffered = 0;
      const output = { answer: { type: 'string', value: 'λ😀'.repeat(100000) } };
      server.on('connection', (socket, request) => {
        const originalSend = socket.send.bind(socket);
        socket.send = ((...args: Parameters<typeof socket.send>) => {
          const result = originalSend(...args);
          maxBuffered = Math.max(maxBuffered, socket.bufferedAmount);
          return result;
        }) as typeof socket.send;
        const logical = sessions.bind(socket, request);
        socket.on('message', (raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === 'executor-receipt') {
            sessions.acknowledge(logical, message.data.id);
            return;
          }
          if (message.type !== 'run' || !sessions.acceptRun(logical, 'one-run')) return;
          executions++;
          const release = sessions.retain(logical);
          const send = (message: string, data: unknown) => {
            sessions.sendMessage(logical, { message, data, requestId: 'one-run' });
            maxBuffered = Math.max(maxBuffered, socket.bufferedAmount);
          };
          send('start', {
            project: { metadata: { id: 'project' }, graphs: {} },
            startGraph: { metadata: { id: 'graph' } },
          });
          const large = 'x'.repeat(smallHistory ? 400 : 1024 * 1024);
          for (let index = 0; index < (smallHistory ? 100 : 52); index++)
            send('nodeFinish', {
              node: { id: `node-${index}`, type: 'code', data: {}, title: 'Node' },
              processId: 'p',
              outputs: { output: { type: 'string', value: large } },
            });
          if (smallHistory) socket.close();
          send('webAppStoragePatch', { storagePatch: { saved: 'once' } });
          send('graphOutputsReady', { outputs: output });
          send('done', { results: output });
          release();
        });
      });
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const url = `ws://127.0.0.1:${address.port}`;
      const inbox = new ExecutorReliableInbox();
      let capability = '',
        cursor = 0,
        gaps = 0;
      const received: Array<{ message: string; data: any }> = [];
      let done!: () => void;
      const completed = new Promise<void>((resolve) => {
        done = resolve;
      });
      const connect = async (resume: boolean) => {
        const socket = new WebSocket(url, [
          'rivet-session-v2',
          'rivet-session-v1',
          ...(resume ? [`rivet-cap.${capability}`, `rivet-seq.${cursor}`] : []),
        ]);
        sockets.push(socket);
        socket.on('error', () => {});
        socket.on('message', (raw) => {
          const frame = JSON.parse(String(raw));
          if (frame.message === 'executor-session') {
            capability = frame.data.capability;
            assert.equal(frame.data.protocol, 2);
          }
          if (frame.message === 'executor-diagnostics-gap') {
            cursor = frame.data.through;
            gaps++;
          }
          if (frame.rivetSequence) {
            assert.equal(frame.rivetSequence, cursor + 1);
            cursor = frame.rivetSequence;
          }
          if (frame.message === 'executor-reliable') {
            const item = inbox.receive(frame.data);
            if (!item) return;
            if (item.text) {
              const event = JSON.parse(item.text);
              received.push(event);
              if (event.message === 'done') done();
            }
            socket.send(JSON.stringify({ type: 'executor-receipt', data: { id: item.id } }));
          }
        });
        await once(socket, 'open');
        return socket;
      };
      const first = await connect(false);
      const closed = once(first, 'close');
      first.send(JSON.stringify({ type: 'run' }));
      if (smallHistory) {
        await closed;
        inbox.resetTransfer();
        await connect(true);
      }
      await completed;
      assert.equal(executions, 1);
      assert.equal(received.filter((event) => event.message === 'webAppStoragePatch').length, 1);
      assert.deepEqual(received.find((event) => event.message === 'graphOutputsReady')?.data.outputs, output);
      assert.deepEqual(received.find((event) => event.message === 'done')?.data.results, output);
      assert.ok(maxBuffered < 2 * 1024 * 1024);
      if (smallHistory) assert.ok(gaps > 0);
    },
  );

test('slow live and replay writers keep retained results and stop filling the socket', async (t) => {
  class Socket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 2 * 1024 * 1024;
    frames: string[] = [];
    send(frame: string) {
      this.frames.push(frame);
    }
    terminate() {
      this.emit('close');
    }
  }
  const budget = { bytes: 0 };
  const delivery = new DebuggerSessionDelivery({ bytes: 1024, events: 4 }, budget);
  t.after(() => delivery.dispose());
  const first = new Socket();
  delivery.phases.set('run', 'accepted');
  delivery.bind(first as unknown as WebSocket, 0);
  delivery.send({ message: 'done', requestId: 'run', data: { results: { answer: 'exact'.repeat(20000) } } });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(first.frames.length, 1, 'only the bounded state frame bypasses the blocked writer');
  const retained = budget.bytes;
  assert.ok(retained > 0);
  first.terminate();
  const second = new Socket();
  delivery.bind(second as unknown as WebSocket, 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(second.frames.length, 1);
  second.bufferedAmount = 0;
  const inbox = new ExecutorReliableInbox();
  for (
    let tries = 0;
    tries < 50 && !second.frames.some((raw) => JSON.parse(raw).message === 'executor-session-ready');
    tries++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  let result: { id: number; text?: string } | undefined;
  for (const raw of second.frames) {
    assert.ok(Buffer.byteLength(raw) < 64 * 1024);
    const frame = JSON.parse(raw);
    if (frame.message === 'executor-reliable') result = inbox.receive(frame.data) ?? result;
  }
  assert.equal(JSON.parse(result!.text!).data.results.answer, 'exact'.repeat(20000));
  assert.equal(budget.bytes, retained);
  delivery.acknowledge(result!.id);
  assert.equal(budget.bytes, 0);
});

test('evicting already delivered history does not mark a live run partial; a behind-cursor resume does', async (t) => {
  class Socket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    frames: string[] = [];
    send(frame: string) {
      this.frames.push(frame);
    }
  }
  const delivery = new DebuggerSessionDelivery({ bytes: 1024, events: 1 }, { bytes: 0 });
  t.after(() => delivery.dispose());
  const socket = new Socket();
  delivery.bind(socket as unknown as WebSocket, 0);
  for (let index = 0; index < 3; index++) {
    delivery.send({ message: 'trace', requestId: 'run', data: String(index) });
    for (
      let tries = 0;
      tries < 50 && !socket.frames.some((raw) => JSON.parse(raw).rivetSequence === index + 1);
      tries++
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(socket.frames.some((raw) => JSON.parse(raw).rivetSequence === index + 1));
  }
  assert.equal(delivery.incomplete.size, 0);
  assert.equal(
    socket.frames.some((raw) => JSON.parse(raw).message === 'executor-diagnostics-gap'),
    false,
  );
  socket.emit('close');
  const resumed = new Socket();
  delivery.bind(resumed as unknown as WebSocket, 0);
  assert.equal(delivery.incomplete.has('run'), true);
  assert.deepEqual(JSON.parse(resumed.frames[0]!).data.incompleteRequests, ['run']);
});

test('v2 owner and protocol checks survive diagnostic eviction without weakening legacy admission', () => {
  const sessions = new DebuggerSessions({ sessions: 4, bytes: 128, events: 1, idleMs: 60000 });
  class Socket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    frames: string[] = [];
    send(frame: string) {
      this.frames.push(frame);
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }
  const request = (protocol: number, capability?: string, sequence = 0) =>
    ({
      headers: {
        'sec-websocket-protocol': `rivet-session-v${protocol}${capability ? `,rivet-cap.${capability},rivet-seq.${sequence}` : ''}`,
      },
    }) as never;
  for (const protocol of [1, 2]) {
    const socket = new Socket();
    const logical = sessions.bind(socket as unknown as WebSocket, request(protocol));
    const capability = JSON.parse(socket.frames[0]!).data.capability;
    sessions.send(logical, JSON.stringify({ message: 'trace', data: 'x'.repeat(1000) }));
    assert.equal(sessions.canAccept(request(protocol, capability), true), protocol === 2);
    assert.equal(sessions.canAccept(request(protocol === 1 ? 2 : 1, capability), true), false);
    assert.equal(sessions.canAccept(request(protocol, capability, 100), true), false);
    assert.equal(sessions.canAccept(request(protocol, 'x'.repeat(43)), true), false);
    socket.close();
  }
});

test('abort announcement does not settle the active run before its terminal event', () => {
  const delivery = new DebuggerSessionDelivery({ bytes: 1024, events: 10 }, { bytes: 0 });
  delivery.phases.set('run', 'running');
  delivery.send({ message: 'abort', requestId: 'run', data: { successful: true } });
  assert.equal(delivery.activeCount, 1);
  delivery.send({ message: 'done', requestId: 'run', data: { results: {} } });
  assert.equal(delivery.activeCount, 0);
  delivery.dispose();
});

test('an unavailable early result does not claim that background execution completed', async (t) => {
  class Socket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    frames: string[] = [];
    send(frame: string) {
      this.frames.push(frame);
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }
  const sessions = new DebuggerSessions();
  const socket = new Socket();
  t.after(() => socket.close());
  const request = (capability?: string) =>
    ({
      headers: {
        'sec-websocket-protocol': 'rivet-session-v2' + (capability ? `,rivet-cap.${capability},rivet-seq.0` : ''),
      },
    }) as never;
  const logical = sessions.bind(socket as unknown as WebSocket, request());
  sessions.acceptRun(logical, 'run');
  const add = ExecutorReliableOutbox.prototype.add;
  let rejectFirst = true;
  t.mock.method(
    ExecutorReliableOutbox.prototype,
    'add',
    function (this: ExecutorReliableOutbox, ...args: Parameters<typeof add>) {
      if (rejectFirst) {
        rejectFirst = false;
        throw new Error('Injected retention failure');
      }
      return add.apply(this, args);
    },
  );
  assert.equal(
    sessions.sendMessage(logical, { message: 'graphOutputsReady', requestId: 'run', data: { outputs: {} } }),
    false,
  );
  for (
    let tries = 0;
    tries < 100 && !socket.frames.some((raw) => JSON.parse(raw).message === 'executor-session-ready');
    tries++
  )
    await new Promise((resolve) => setTimeout(resolve, 2));
  const inbox = new ExecutorReliableInbox();
  const received = socket.frames.flatMap((raw) => {
    const frame = JSON.parse(raw);
    if (frame.message !== 'executor-reliable') return [];
    const text = inbox.receive(frame.data)?.text;
    return text ? [JSON.parse(text)] : [];
  });
  assert.equal(received[0]?.data.executionStatus, 'outputs-ready');
  const capability = JSON.parse(socket.frames[0]!).data.capability;
  socket.close();
  const resumed = new Socket();
  t.after(() => resumed.close());
  sessions.bind(resumed as unknown as WebSocket, request(capability));
  const state = JSON.parse(resumed.frames.find((raw) => JSON.parse(raw).message === 'executor-session-state')!);
  assert.deepEqual(state.data.requests, [{ requestId: 'run', phase: 'outputs-ready' }]);
});

test('incoming assemblies and retained replies share the server budget and disposal releases both', () => {
  const budget = { bytes: 0 };
  const delivery = new DebuggerSessionDelivery({ bytes: 1024, events: 10 }, budget);
  delivery.send({ message: 'done', requestId: 'run', data: { results: {} } });
  const retained = budget.bytes;
  const sender = new ExecutorReliableOutbox();
  sender.add(
    JSON.stringify({ type: 'datasets:response', data: { requestId: 'dataset', payload: 'x'.repeat(20_000) } }),
  );
  const expected = sender.bytes;
  delivery.receive(sender.next());
  assert.equal(budget.bytes, retained + expected);
  delivery.dispose();
  assert.equal(budget.bytes, 0);
  delivery.dispose();
  assert.equal(budget.bytes, 0);
});

test('recovery reports every incomplete request in bounded control frames', async (t) => {
  class Socket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    frames: string[] = [];
    send(frame: string) {
      this.frames.push(frame);
    }
  }
  const delivery = new DebuggerSessionDelivery({ bytes: 1024, events: 10 }, { bytes: 0 });
  t.after(() => delivery.dispose());
  const ids = Array.from({ length: 300 }, (_, index) => '\\'.repeat(195) + index);
  for (const id of ids) delivery.incomplete.add(id);
  // The state frame itself must fit even with the maximum number of active requests.
  for (const id of ids.slice(0, 32)) delivery.phases.set(id, 'running');
  const socket = new Socket();
  delivery.bind(socket as unknown as WebSocket, 0);
  for (
    let tries = 0;
    tries < 100 && !socket.frames.some((raw) => JSON.parse(raw).message === 'executor-session-ready');
    tries++
  )
    await new Promise((resolve) => setTimeout(resolve, 2));
  const reported = new Set(
    socket.frames.flatMap((raw) => {
      assert.ok(Buffer.byteLength(raw) < 64 * 1024);
      const frame = JSON.parse(raw);
      return frame.data?.incompleteRequests ?? frame.data?.requestIds ?? [];
    }),
  );
  assert.deepEqual(reported, new Set(ids));
});

test('expired session handles cannot admit late work or retain new payloads', () => {
  class Socket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    frames: string[] = [];
    send(frame: string) {
      this.frames.push(frame);
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }
  for (const protocol of [1, 2]) {
    let now = 0;
    const sessions = new DebuggerSessions({ sessions: 1, bytes: 1024, events: 10, idleMs: 10 }, () => now);
    const request = { headers: { 'sec-websocket-protocol': `rivet-session-v${protocol}` } } as never;
    const old = new Socket();
    const logical = sessions.bind(old as unknown as WebSocket, request);
    old.close();
    now = 11;
    assert.equal(sessions.canAccept(request, true), true);
    assert.equal(sessions.isCurrent(logical), false);
    assert.throws(() => sessions.acceptRun(logical, 'late-run'));
    assert.throws(() => sessions.retain(logical));
    assert.throws(() => sessions.send(logical, JSON.stringify({ message: 'done', data: {} })));
    if (protocol === 2) assert.throws(() => sessions.sendMessage(logical, { message: 'done', data: {} }));
    const fresh = new Socket();
    sessions.bind(fresh as unknown as WebSocket, request);
    assert.equal(sessions.acceptRun(fresh as unknown as WebSocket, 'fresh-run'), true);
    fresh.close();
    now = 22;
    sessions.canAccept(request, true);
  }
});

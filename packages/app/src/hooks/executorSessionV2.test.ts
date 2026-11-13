import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutorReliableInbox, ExecutorReliableOutbox } from '@valerypopoff/rivet2-core';
import { ExecutorSessionV2 } from './executorSessionV2.js';
import { FakeWebSocket } from './executorSessionTestUtils.js';

test('an accepted dataset operation finishes offline and sends its retained response once on recovery', async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
  let socket = new FakeWebSocket('wss://fixture');
  socket.open();
  let ready = false,
    writes = 0;
  let complete!: () => void;
  const peer = new ExecutorSessionV2({
    socket: () => socket as unknown as WebSocket,
    ready: () => ready,
    fail: () => assert.fail('unexpected recovery failure'),
    partial() {},
  });
  peer.active = true;
  t.after(() => peer.clear());
  const operation = async (reply: (value: unknown) => void) => {
    writes++;
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    reply({ saved: true });
    reply({ saved: 'duplicate' });
  };
  peer.dataset('write', operation);
  peer.dataset('write', operation);
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.equal(socket.sent.length, 0);
  socket = new FakeWebSocket('wss://fixture');
  socket.open();
  ready = true;
  peer.suspend();
  peer.flush();
  const inbox = new ExecutorReliableInbox();
  let delivered: { id: number; text?: string } | undefined;
  for (const raw of socket.sent) delivered = inbox.receive(JSON.parse(raw).data) ?? delivered;
  assert.equal(JSON.parse(delivered!.text!).data.payload.saved, true);
  peer.receive(JSON.stringify({ message: 'executor-receipt', data: { id: delivered!.id } }));
  assert.equal(peer.outbox.bytes, 0);
});

test('late failed dataset completion cannot enter a replacement logical session', async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
  const socket = new FakeWebSocket('wss://fixture');
  socket.open();
  const peer = new ExecutorSessionV2({
    socket: () => socket as unknown as WebSocket,
    ready: () => true,
    fail: () => assert.fail('unexpected failure'),
    partial() {},
  });
  t.after(() => peer.clear());
  let reject!: (error: Error) => void;
  peer.dataset(
    'same-id',
    async () =>
      new Promise((_resolve, failure) => {
        reject = failure;
      }),
  );
  peer.clear();
  peer.dataset('same-id', async (reply) => reply('new'));
  reject(new Error('old'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peer.outbox.size, 1);
  const inbox = new ExecutorReliableInbox();
  const messages = socket.sent
    .map((raw) => inbox.receive(JSON.parse(raw).data)?.text)
    .filter(Boolean)
    .map((raw) => JSON.parse(raw!));
  assert.deepEqual(
    messages.map((message) => message.data.payload),
    ['new'],
  );
});

test('a synchronous dataset-reply send failure closes transport and replays the reply, not the write', async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
  let socket = new FakeWebSocket('wss://fixture');
  socket.open();
  const peer = new ExecutorSessionV2({
    socket: () => socket as unknown as WebSocket,
    ready: () => true,
    fail: () => assert.fail('transport can recover'),
    partial() {},
  });
  t.after(() => peer.clear());
  let writes = 0;
  socket.send = () => {
    throw new Error('Injected send failure');
  };
  peer.dataset('write', async (reply) => {
    writes++;
    reply({ saved: true });
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  assert.equal(peer.outbox.size, 1);
  socket = new FakeWebSocket('wss://fixture');
  socket.open();
  peer.flush();
  const inbox = new ExecutorReliableInbox();
  const received = socket.sent.map((raw) => inbox.receive(JSON.parse(raw).data)).find((item) => item?.text);
  assert.equal(JSON.parse(received!.text!).data.payload.saved, true);
  assert.equal(writes, 1);
});

test('a lost result acknowledgement can reconnect without consuming the result twice', (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
  let socket = new FakeWebSocket('wss://fixture');
  socket.open();
  const peer = new ExecutorSessionV2({
    socket: () => socket as unknown as WebSocket,
    ready: () => true,
    fail: () => assert.fail('transport can recover'),
    partial() {},
  });
  peer.active = true;
  t.after(() => peer.clear());
  const sender = new ExecutorReliableOutbox();
  sender.add(JSON.stringify({ message: 'done', data: { results: { answer: 'once' } } }));
  const chunk = sender.next()!;
  const received = peer.receive(JSON.stringify({ message: 'executor-reliable', data: chunk }));
  assert.ok(received?.raw);
  socket.send = () => {
    throw new Error('Injected receipt failure');
  };
  assert.doesNotThrow(() => peer.acknowledge(received!.receipt!));
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  socket = new FakeWebSocket('wss://fixture');
  socket.open();
  sender.replay();
  const replay = peer.receive(JSON.stringify({ message: 'executor-reliable', data: sender.next() }));
  assert.equal(replay?.raw, undefined);
  peer.acknowledge(replay!.receipt!);
  assert.equal(JSON.parse(socket.sent[0]!).data.id, received!.receipt);
});

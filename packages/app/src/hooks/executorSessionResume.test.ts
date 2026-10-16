import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeWebSocket, installExecutorSessionTestHooks, runtime } from './executorSessionTestUtils.js';
import { createExecutorSessionRuntime } from './executorSession.js';

installExecutorSessionTestHooks();
test('only positively idle retired owners discover a new executor, without replaying run commands', async () => {
  let discoveries = 0;
  const session = createExecutorSessionRuntime({ onStateChange: () => {}, resolveInternalHostedExecutorUrl: async () => {
    discoveries++; return 'wss://rivet.example/ws/executor/owner/new-owner';
  } });
  await session.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/old-owner');
  const old = FakeWebSocket.instances.at(-1)!; old.open();
  old.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'i'.repeat(43) } });
  old.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  const pending = session.createPendingGraphExecution();
  old.emitMessage({ message: 'executor-owner-retiring', data: { protocol: 1 }, rivetSequence: 1 });
  await Promise.resolve(); assert.equal(discoveries, 0);
  session.resolvePendingGraphExecution(pending.requestId, {}); await pending.promise;
  old.emitMessage({ message: 'executor-owner-retiring', data: { protocol: 1 }, rivetSequence: 2 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(discoveries, 1);
  const fresh = FakeWebSocket.instances.at(-1)!;
  assert.equal(fresh.url, 'wss://rivet.example/ws/executor/owner/new-owner'); assert.deepEqual(fresh.protocols, ['rivet-session-v1']);
  assert.deepEqual(fresh.sent, []); fresh.open();
  fresh.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'j'.repeat(43) } });
  fresh.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  await session.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/old-owner');
  assert.equal(FakeWebSocket.instances.at(-1), fresh);
  session.disconnect();
});
test('HA latest reconnect preserves observations and never duplicates lifecycle or replayed events', async () => {
  let connects = 0; const messages: string[] = [];
  runtime.subscribeLifecycle('connect', () => { connects++; });
  runtime.subscribeMessages(message => { messages.push(message); });
  await runtime.connectExternalDebugger('wss://rivet.example/ws/latest-debugger');
  const first = FakeWebSocket.instances.at(-1)!; first.open();
  first.emitMessage({ message: 'latest-session', data: { protocol: 1 } });
  first.emitMessage({ message: 'start', data: {}, rivetEventId: 'backend-0:owner:1' });
  first.emitClose();
  await new Promise(resolve => setTimeout(resolve, 200));
  const resumed = FakeWebSocket.instances.at(-1)!; resumed.open();
  assert.equal(runtime.isReady(), false);
  resumed.emitMessage({ message: 'latest-session', data: { protocol: 1 } });
  resumed.emitMessage({ message: 'start', data: {}, rivetEventId: 'backend-0:owner:1' });
  resumed.emitMessage({ message: 'done', data: {}, rivetEventId: 'backend-0:owner:2' });
  assert.equal(connects, 1); assert.deepEqual(messages, ['start', 'done']); assert.deepEqual(resumed.sent, []);
});
test('hosted resume keeps pending results, replays diagnostics once and never sends run again', async () => {
  const cap = 'a'.repeat(43);
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/test-owner');
  const first = FakeWebSocket.instances.at(-1)!;
  first.open();
  first.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: cap } });
  first.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  const messages: string[] = [];
  runtime.subscribeMessages((message) => {
    messages.push(message);
  });
  first.emitMessage({ message: 'start', data: {}, rivetSequence: 1 });
  const pending = runtime.createPendingGraphExecution();
  const result = pending.promise;
  first.emitClose();
  assert.equal(runtime.getRuntimeState().status, 'reconnecting');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = FakeWebSocket.instances.at(-1)!;
  assert.notEqual(second, first);
  assert.deepEqual(second.protocols, ['rivet-session-v1', `rivet-cap.${cap}`, 'rivet-seq.1']);
  second.open();
  assert.equal(runtime.isReady(), false);
  assert.notEqual(runtime.getRuntimeState().status, 'ready');
  second.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: cap, resumed: true } });
  second.emitMessage({ message: 'start', data: {}, rivetSequence: 1 });
  second.emitMessage({ message: 'done', data: {}, rivetSequence: 2 });
  second.emitMessage({ message: 'executor-session-ready', data: { protocol: 1, resumed: true } });
  assert.deepEqual(messages, ['start', 'done']);
  assert.equal(runtime.isReady(), true);
  assert.deepEqual(second.sent, []);
  runtime.resolvePendingGraphExecution(pending.requestId, {});
  assert.deepEqual(await result, {});
});

test('a missing owner or diagnostic gap settles as unknown without replaying a run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/test-owner');
  const first = FakeWebSocket.instances.at(-1)!;
  first.open();
  first.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'b'.repeat(43) } });
  const pending = runtime.createPendingGraphExecution();
  const rejected = assert.rejects(pending.promise, /outcome is unknown.*not resubmitted/);
  first.emitClose();
  t.mock.timers.tick(60_000);
  await rejected;
  assert.equal(runtime.getRuntimeState().status, 'idle');
  assert.equal(FakeWebSocket.instances.flatMap((socket) => socket.sent).length, 0);
});

test('a diagnostic cursor gap never reopens a terminal or pending execution', async () => {
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/test-owner');
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'c'.repeat(43) } });
  const pending = runtime.createPendingGraphExecution();
  const rejected = assert.rejects(pending.promise, /outcome is unknown.*not resubmitted/);
  socket.emitMessage({ message: 'done', data: {}, rivetSequence: 2 });
  await rejected;
  assert.equal(runtime.getRuntimeState().status, 'idle');
});

test('a fenced observer stops recovery instead of taking a new session from its replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/test-owner');
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'd'.repeat(43) } });
  const pending = runtime.createPendingGraphExecution();
  const rejected = assert.rejects(pending.promise, /outcome is unknown.*not resubmitted/);
  socket.emitClose(4409);
  await rejected;
  t.mock.timers.tick(60_000);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(runtime.getRuntimeState().status, 'idle');
});

test('legacy hosted URLs and custom overrides keep their existing protocol-free handshake', async () => {
  await runtime.connectInternalHostedExecutor('wss://custom.example/internal');
  assert.equal(FakeWebSocket.instances.at(-1)!.protocols, undefined);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeWebSocket, installExecutorSessionTestHooks, runtime } from './executorSessionTestUtils';

installExecutorSessionTestHooks();

test('ignores stale socket close events after reconnecting to a new session', async () => {
  await runtime.connect('ws://localhost:1234');
  const firstSocket = FakeWebSocket.instances[0]!;

  await runtime.connect('ws://localhost:5678');
  const secondSocket = FakeWebSocket.instances[1]!;

  secondSocket.open();
  firstSocket.emitClose();

  assert.equal(runtime.getRuntimeState().status, 'ready');
  assert.equal(runtime.getRuntimeState().socket, secondSocket);
});

test('manual disconnect only notifies listeners once', async () => {
  let disconnectCount = 0;
  let disconnectReason: string | undefined;
  let disconnectIsInternal: boolean | undefined;
  let statusAtDisconnect: string | undefined;

  const unsubscribe = runtime.subscribeLifecycle('disconnect', (event) => {
    disconnectCount += 1;
    disconnectReason = event.reason;
    disconnectIsInternal = event.isInternalExecutor;
    statusAtDisconnect = runtime.getRuntimeState().status;
  });

  await runtime.connect('ws://localhost:9999');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  runtime.disconnect();
  socket.emitClose();

  unsubscribe();

  assert.equal(disconnectCount, 1);
  assert.equal(disconnectReason, 'manual-disconnect');
  assert.equal(disconnectIsInternal, false);
  assert.equal(statusAtDisconnect, 'idle');
  assert.equal(runtime.getRuntimeState().status, 'idle');
  assert.equal(runtime.getRuntimeState().socket, null);
});

test('disconnect can report replaced reason for project-mode handoffs', async () => {
  let disconnectReason: string | undefined;

  const unsubscribe = runtime.subscribeLifecycle('disconnect', (event) => {
    disconnectReason = event.reason;
  });

  await runtime.connect('ws://debugger.example/latest');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  runtime.disconnect({ reason: 'replaced' });
  socket.emitClose();
  unsubscribe();

  assert.equal(disconnectReason, 'replaced');
  assert.equal(runtime.getRuntimeState().status, 'idle');
  assert.equal(runtime.getRuntimeState().target, null);
});

test('manual external debugger disconnect can immediately restore internal executor without losing cleanup event', async () => {
  let disconnectCount = 0;
  let disconnectReason: string | undefined;
  let disconnectIsInternal: boolean | undefined;

  const unsubscribe = runtime.subscribeLifecycle('disconnect', (event) => {
    disconnectCount += 1;
    disconnectReason = event.reason;
    disconnectIsInternal = event.isInternalExecutor;
  });

  await runtime.connect('ws://debugger.example/latest');
  const externalSocket = FakeWebSocket.instances[0]!;
  externalSocket.open();

  runtime.disconnect();
  await runtime.connectInternal('ws://executor.example/internal');
  const internalSocket = FakeWebSocket.instances[1]!;
  externalSocket.emitClose();
  internalSocket.open();

  unsubscribe();

  const sessionState = runtime.buildSessionState();

  assert.equal(disconnectCount, 1);
  assert.equal(disconnectReason, 'manual-disconnect');
  assert.equal(disconnectIsInternal, false);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(sessionState.status, 'ready');
  assert.equal(sessionState.isInternalExecutor, true);
  assert.equal(sessionState.socket, internalSocket);
});

test('unexpected internal executor disconnect notifies listeners and transitions to reconnecting', async () => {
  let disconnectCount = 0;
  let statusAtDisconnect: string | undefined;
  let disconnectReason: string | undefined;
  let disconnectIsInternal: boolean | undefined;

  const unsubscribe = runtime.subscribeLifecycle('disconnect', (event) => {
    disconnectCount += 1;
    disconnectReason = event.reason;
    disconnectIsInternal = event.isInternalExecutor;
    statusAtDisconnect = runtime.getRuntimeState().status;
  });

  await runtime.connectInternal('ws://localhost:7777/internal');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  socket.emitClose();

  unsubscribe();

  assert.equal(disconnectCount, 1);
  assert.equal(disconnectReason, 'unexpected-disconnect');
  assert.equal(disconnectIsInternal, true);
  assert.equal(statusAtDisconnect, 'reconnecting');
  assert.equal(runtime.getRuntimeState().status, 'reconnecting');
  assert.equal(runtime.getRuntimeState().socket, null);
});

test('manual reconnect during an internal executor disconnect callback cancels the scheduled reconnect', async () => {
  const unsubscribe = runtime.subscribeLifecycle('disconnect', (event) => {
    if (event.reason === 'unexpected-disconnect' && event.isInternalExecutor) {
      void runtime.connectInternal('ws://executor.example/manual-internal');
    }
  });

  await runtime.connectInternal('ws://executor.example/internal');
  const firstSocket = FakeWebSocket.instances[0]!;
  firstSocket.open();
  firstSocket.emitClose();

  await new Promise((resolve) => setTimeout(resolve, 175));
  unsubscribe();

  const secondSocket = FakeWebSocket.instances[1]!;
  secondSocket.open();

  const sessionState = runtime.buildSessionState();

  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(secondSocket.url, 'ws://executor.example/manual-internal');
  assert.equal(sessionState.status, 'ready');
  assert.equal(sessionState.isInternalExecutor, true);
});

test('unexpected external debugger disconnect does not reconnect automatically', async () => {
  let disconnectCount = 0;
  let statusAtDisconnect: string | undefined;
  let disconnectReason: string | undefined;
  let disconnectIsInternal: boolean | undefined;

  const unsubscribe = runtime.subscribeLifecycle('disconnect', (event) => {
    disconnectCount += 1;
    disconnectReason = event.reason;
    disconnectIsInternal = event.isInternalExecutor;
    statusAtDisconnect = runtime.getRuntimeState().status;
  });

  await runtime.connect('ws://localhost:7778');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  socket.emitClose();

  await new Promise((resolve) => setTimeout(resolve, 175));
  unsubscribe();

  assert.equal(disconnectCount, 1);
  assert.equal(disconnectReason, 'unexpected-disconnect');
  assert.equal(disconnectIsInternal, false);
  assert.equal(statusAtDisconnect, 'idle');
  assert.equal(runtime.getRuntimeState().status, 'idle');
  assert.equal(runtime.getRuntimeState().socket, null);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('external debugger drop can hand back to the internal executor without reconnecting externally', async () => {
  const unsubscribe = runtime.subscribeLifecycle('disconnect', (event) => {
    if (event.reason === 'unexpected-disconnect' && !event.isInternalExecutor) {
      void runtime.connectInternal('ws://executor.example/internal');
    }
  });

  await runtime.connect('ws://debugger.example/latest');
  const externalSocket = FakeWebSocket.instances[0]!;
  externalSocket.open();
  externalSocket.emitClose();

  await new Promise((resolve) => setTimeout(resolve, 175));
  unsubscribe();

  const internalSocket = FakeWebSocket.instances[1]!;
  internalSocket.open();

  const sessionState = runtime.buildSessionState();

  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(externalSocket.url, 'ws://debugger.example/latest');
  assert.equal(internalSocket.url, 'ws://executor.example/internal');
  assert.equal(sessionState.status, 'ready');
  assert.equal(sessionState.isInternalExecutor, true);
});

test('connectInternal marks custom hosted executor URLs as internal sessions', async () => {
  await runtime.connectInternal('ws://executor.example/internal');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  const sessionState = runtime.buildSessionState();

  assert.equal(sessionState.status, 'ready');
  assert.equal(sessionState.url, 'ws://executor.example/internal');
  assert.equal(sessionState.isInternalExecutor, true);
  assert.deepEqual(sessionState.target, { type: 'internal-hosted', url: 'ws://executor.example/internal' });
});

test('connectInternalDesktopExecutor marks the default sidecar URL as desktop internal', async () => {
  await runtime.connectInternalDesktopExecutor();
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  const sessionState = runtime.buildSessionState();

  assert.deepEqual(sessionState.target, { type: 'internal-desktop', url: 'ws://127.0.0.1:21889/internal' });
  assert.equal(sessionState.isInternalExecutor, true);
});

test('connectExternalDebugger marks sessions as external debugger targets', async () => {
  await runtime.connectExternalDebugger('ws://debugger.example/latest');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  const sessionState = runtime.buildSessionState();

  assert.deepEqual(sessionState.target, { type: 'external-debugger', url: 'ws://debugger.example/latest' });
  assert.equal(sessionState.isInternalExecutor, false);
});

test('clears target state when websocket construction fails', async () => {
  globalThis.WebSocket = class {
    constructor() {
      throw new Error('websocket constructor failed');
    }
  } as unknown as typeof WebSocket;

  await assert.rejects(runtime.connectExternalDebugger('not-a-websocket-url'), /websocket constructor failed/);

  const sessionState = runtime.buildSessionState();

  assert.equal(sessionState.status, 'idle');
  assert.equal(sessionState.target, null);
  assert.equal(sessionState.url, '');
});

test('reuses the existing websocket when reconnecting to the same target', async () => {
  let disconnectCount = 0;
  const unsubscribe = runtime.subscribeLifecycle('disconnect', () => {
    disconnectCount += 1;
  });

  await runtime.connectExternalDebugger('ws://executor.example/shared');
  const firstSocket = FakeWebSocket.instances[0]!;
  firstSocket.open();

  await runtime.connectExternalDebugger('ws://executor.example/shared');
  unsubscribe();

  const sessionState = runtime.buildSessionState();

  assert.equal(disconnectCount, 0);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(sessionState.socket, firstSocket);
  assert.deepEqual(sessionState.target, { type: 'external-debugger', url: 'ws://executor.example/shared' });
});

test('reconnect preserves internal classification for custom hosted executor URLs', async () => {
  await runtime.connectInternal('ws://executor.example/internal');
  const firstSocket = FakeWebSocket.instances[0]!;
  firstSocket.open();
  firstSocket.emitClose();

  await new Promise((resolve) => setTimeout(resolve, 175));
  const secondSocket = FakeWebSocket.instances[1]!;
  secondSocket.open();

  const sessionState = runtime.buildSessionState();

  assert.equal(secondSocket.url, 'ws://executor.example/internal');
  assert.equal(sessionState.status, 'ready');
  assert.equal(sessionState.url, 'ws://executor.example/internal');
  assert.equal(sessionState.isInternalExecutor, true);
  assert.deepEqual(sessionState.target, { type: 'internal-hosted', url: 'ws://executor.example/internal' });
});

test('connectInternal replaces an external session even when the URL matches', async () => {
  let disconnectReason: string | undefined;
  let disconnectTarget: string | undefined;
  const unsubscribe = runtime.subscribeLifecycle('disconnect', (event) => {
    disconnectReason = event.reason;
    disconnectTarget = event.target?.type;
  });

  await runtime.connect('ws://executor.example/internal');
  const externalSocket = FakeWebSocket.instances[0]!;
  externalSocket.open();

  await runtime.connectInternal('ws://executor.example/internal');
  const internalSocket = FakeWebSocket.instances[1]!;
  internalSocket.open();
  unsubscribe();

  const sessionState = runtime.buildSessionState();

  assert.equal(disconnectReason, 'replaced');
  assert.equal(disconnectTarget, 'external-debugger');
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(sessionState.socket, internalSocket);
  assert.equal(sessionState.isInternalExecutor, true);
  assert.deepEqual(sessionState.target, { type: 'internal-hosted', url: 'ws://executor.example/internal' });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { createExecutorSessionRuntime } from './executorSession';
import {
  captureConsoleErrors,
  FakeWebSocket,
  flushMicrotasks,
  installExecutorSessionTestHooks,
  runtime,
} from './executorSessionTestUtils';

installExecutorSessionTestHooks();

test('all subscribers share exactly one admission decision, even if an earlier subscriber changes the request', async () => {
  const scoped = createExecutorSessionRuntime({ projectId: 'a' as ProjectId, onStateChange() {} });
  const admissions: unknown[] = [];
  scoped.setActiveGraphRunRequestId('owned');
  scoped.subscribeMessages((_message, _data, _request, admission) => {
    admissions.push(admission);
    scoped.setActiveGraphRunRequestId(null);
  });
  scoped.subscribeMessages((_message, _data, _request, admission) => {
    admissions.push(admission);
  });
  const connected = scoped.connectExternalDebugger('ws://localhost:8888');
  FakeWebSocket.instances[0]!.open();
  await connected;
  scoped.setActiveGraphRunRequestId('owned');
  FakeWebSocket.instances[0]!.emitMessage({ message: 'trace', data: 'test', requestId: 'owned' });
  assert.equal(admissions.length, 2);
  assert.equal(admissions[0], admissions[1]);
  assert.equal((admissions[0] as { decision: { shouldDispatch: boolean } }).decision.shouldDispatch, true);
  scoped.disconnect();
});

test('delivers process messages to all subscribed handlers', async () => {
  const receivedByFirst: string[] = [];
  const receivedBySecond: string[] = [];

  const unsubscribeFirst = runtime.subscribeMessages((message) => {
    receivedByFirst.push(String(message));
  });
  const unsubscribeSecond = runtime.subscribeMessages((message) => {
    receivedBySecond.push(String(message));
  });

  await runtime.connect('ws://localhost:8888');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  socket.emitMessage({
    message: 'trace',
    data: 'hello',
  });

  unsubscribeFirst();
  unsubscribeSecond();

  assert.deepEqual(receivedByFirst, ['trace']);
  assert.deepEqual(receivedBySecond, ['trace']);
});

test('continues notifying lifecycle subscribers when one subscriber throws', async () => {
  const logged = captureConsoleErrors();
  let secondSubscriberCalled = false;

  const unsubscribeFirst = runtime.subscribeLifecycle('disconnect', () => {
    throw new Error('subscriber failed');
  });
  const unsubscribeSecond = runtime.subscribeLifecycle('disconnect', () => {
    secondSubscriberCalled = true;
  });

  await runtime.connectExternalDebugger('ws://debugger.example/latest');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  runtime.disconnect();

  unsubscribeFirst();
  unsubscribeSecond();

  assert.equal(secondSubscriberCalled, true);
  assert.equal((logged[0] as unknown[])[0], '[Executor session lifecycle subscriber failed]');
});

test('continues notifying lifecycle subscribers when one async subscriber rejects', async () => {
  const logged = captureConsoleErrors();
  let secondSubscriberCalled = false;

  const unsubscribeFirst = runtime.subscribeLifecycle('disconnect', async () => {
    throw new Error('async subscriber failed');
  });
  const unsubscribeSecond = runtime.subscribeLifecycle('disconnect', () => {
    secondSubscriberCalled = true;
  });

  await runtime.connectExternalDebugger('ws://debugger.example/latest');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  runtime.disconnect();
  await flushMicrotasks();

  unsubscribeFirst();
  unsubscribeSecond();

  assert.equal(secondSubscriberCalled, true);
  assert.equal((logged[0] as unknown[])[0], '[Executor session lifecycle subscriber failed]');
});

test('continues notifying process-message subscribers when one subscriber throws', async () => {
  const logged = captureConsoleErrors();
  const receivedBySecond: string[] = [];

  const unsubscribeFirst = runtime.subscribeMessages(() => {
    throw new Error('handler failed');
  });
  const unsubscribeSecond = runtime.subscribeMessages((message) => {
    receivedBySecond.push(String(message));
  });

  await runtime.connect('ws://localhost:8888');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  socket.emitMessage({
    message: 'trace',
    data: 'hello',
  });

  unsubscribeFirst();
  unsubscribeSecond();

  assert.deepEqual(receivedBySecond, ['trace']);
  assert.equal((logged[0] as unknown[])[0], '[Executor process-message subscriber failed]');
});

test('continues notifying process-message subscribers when one async subscriber rejects', async () => {
  const logged = captureConsoleErrors();
  const receivedBySecond: string[] = [];

  const unsubscribeFirst = runtime.subscribeMessages(async () => {
    throw new Error('async handler failed');
  });
  const unsubscribeSecond = runtime.subscribeMessages((message) => {
    receivedBySecond.push(String(message));
  });

  await runtime.connect('ws://localhost:8888');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  socket.emitMessage({
    message: 'trace',
    data: 'hello',
  });
  await flushMicrotasks();

  unsubscribeFirst();
  unsubscribeSecond();

  assert.deepEqual(receivedBySecond, ['trace']);
  assert.equal((logged[0] as unknown[])[0], '[Executor process-message subscriber failed]');
});

test('logs state-change callback failures without breaking websocket lifecycle', async () => {
  const logged = captureConsoleErrors();
  const throwingRuntime = createExecutorSessionRuntime({
    datasetProvider: {} as never,
    onStateChange: () => {
      throw new Error('state change failed');
    },
  });

  await throwingRuntime.connectExternalDebugger('ws://debugger.example/latest');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  assert.equal(throwingRuntime.getRuntimeState().status, 'ready');
  assert.equal(
    logged.some((entry) => (entry as unknown[])[0] === '[Executor session state-change callback failed]'),
    true,
  );

  throwingRuntime.disconnect();
});

test('logs async state-change callback rejections without breaking websocket lifecycle', async () => {
  const logged = captureConsoleErrors();
  const throwingRuntime = createExecutorSessionRuntime({
    datasetProvider: {} as never,
    onStateChange: async () => {
      throw new Error('async state change failed');
    },
  });

  await throwingRuntime.connectExternalDebugger('ws://debugger.example/latest');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  await flushMicrotasks();

  assert.equal(throwingRuntime.getRuntimeState().status, 'ready');
  assert.equal(
    logged.some((entry) => (entry as unknown[])[0] === '[Executor session state-change callback failed]'),
    true,
  );

  throwingRuntime.disconnect();
  await flushMicrotasks();
});

test('delivers Code console messages to subscribers', async () => {
  const received: unknown[] = [];
  const unsubscribe = runtime.subscribeMessages((message, data) => {
    received.push({ data, message });
  });

  await runtime.connect('ws://localhost:8889');
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  socket.emitMessage({
    message: 'codeConsole',
    data: {
      level: 'log',
      args: ['hello from code'],
    },
    requestId: 'request-1',
  });

  unsubscribe();

  assert.deepEqual(received, [
    {
      message: 'codeConsole',
      data: {
        level: 'log',
        args: ['hello from code'],
      },
    },
  ]);
});

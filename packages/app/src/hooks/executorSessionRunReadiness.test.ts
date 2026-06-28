import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeWebSocket, installExecutorSessionTestHooks, runtime } from './executorSessionTestUtils';
import { waitForExecutorSessionRunCapability } from './executorSessionRunReadiness';

installExecutorSessionTestHooks();

test('waitForExecutorSessionRunCapability resolves when a connecting internal executor becomes ready', async () => {
  await runtime.connectInternal('ws://executor.example/internal');
  const socket = FakeWebSocket.instances[0]!;

  const readyStatePromise = waitForExecutorSessionRunCapability(runtime, 1000);
  socket.open();

  const readyState = await readyStatePromise;

  assert.equal(readyState.status, 'ready');
  assert.equal(readyState.capabilities.canSendRun, true);
});

test('waitForExecutorSessionRunCapability returns immediately when the session is not pending readiness', async () => {
  const idleState = await waitForExecutorSessionRunCapability(runtime, 1000);

  assert.equal(idleState.status, 'idle');
  assert.equal(idleState.capabilities.canSendRun, false);
});

test('waitForExecutorSessionRunCapability resolves with the current state when readiness times out', async () => {
  await runtime.connectInternal('ws://executor.example/internal');

  const timedOutState = await waitForExecutorSessionRunCapability(runtime, 1);

  assert.equal(timedOutState.status, 'connecting');
  assert.equal(timedOutState.capabilities.canSendRun, false);
});

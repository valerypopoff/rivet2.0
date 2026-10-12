import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeWebSocket, installExecutorSessionTestHooks, runtime } from './executorSessionTestUtils';
import { bindExecutorSessionRun, waitForExecutorSessionRunCapability } from './executorSessionRunReadiness';
import { sendPendingRemoteGraphRunRequest } from './remoteExecutorRunRequest';
import type { GraphId, Project, ProjectId, Settings } from '@valerypopoff/rivet2-core';
import { createExecutorSessionRuntime } from './executorSession';
import {
  getRemoteExecutorUploadCacheForSocket,
  uploadRemoteExecutorProjectIfNeeded,
} from './remoteExecutorUploadCache';

installExecutorSessionTestHooks();

test("project runtimes at the same URL cannot reuse each other's upload cache", async () => {
  const otherRuntime = createExecutorSessionRuntime({ onStateChange: () => {} });
  try {
    await runtime.connectInternal('ws://executor.example/internal');
    FakeWebSocket.instances[0]!.open();
    await otherRuntime.connectInternal('ws://executor.example/internal');
    FakeWebSocket.instances[1]!.open();
    const firstCache = getRemoteExecutorUploadCacheForSocket(runtime.getRuntimeState().socket);
    const otherCache = getRemoteExecutorUploadCacheForSocket(otherRuntime.getRuntimeState().socket);
    const project: Project = {
      metadata: { id: 'project-1' as ProjectId, title: 'Project', description: '' },
      graphs: {},
      plugins: [],
    };
    const settings: Settings = {
      openAiKey: '',
      openAiEndpoint: '',
      openAiOrganization: '',
      pluginEnv: {},
      pluginSettings: {},
    };
    const upload = (owner: typeof runtime, cache: typeof firstCache) =>
      uploadRemoteExecutorProjectIfNeeded({
        cache,
        project,
        settings,
        sessionKey: 'internal:ws://executor.example/internal',
        transport: {
          sendDynamicData: (payload) => owner.sendMessage('set-dynamic-data', payload),
          sendStaticData: () => true,
        },
      });
    assert.notEqual(firstCache, otherCache);
    assert.equal(upload(runtime, firstCache), 'uploaded');
    assert.equal(upload(otherRuntime, otherCache), 'uploaded');
    assert.equal(upload(runtime, getRemoteExecutorUploadCacheForSocket(runtime.getRuntimeState().socket)), 'cached');
    assert.equal(FakeWebSocket.instances[0]!.sent.length, 1);
    assert.equal(FakeWebSocket.instances[1]!.sent.length, 1);
  } finally {
    otherRuntime.disconnect();
  }
});

test('same-URL reconnect gets a cold upload cache without a mounted lifecycle subscriber', async () => {
  await runtime.connectInternal('ws://executor.example/internal');
  FakeWebSocket.instances[0]!.open();
  const previous = getRemoteExecutorUploadCacheForSocket(runtime.getRuntimeState().socket);
  previous.uploadKey = 'previous payload';
  runtime.disconnect();
  await runtime.connectInternal('ws://executor.example/internal');
  FakeWebSocket.instances.at(-1)!.open();
  const replacement = getRemoteExecutorUploadCacheForSocket(runtime.getRuntimeState().socket);
  assert.notEqual(replacement, previous);
  assert.equal(replacement.uploadKey, undefined);
  assert.throws(() => getRemoteExecutorUploadCacheForSocket(null), /without an executor connection/);
});

test('a prepared run remains bound to its ready connection through state updates', async () => {
  await runtime.connectInternal('ws://executor.example/internal');
  FakeWebSocket.instances[0]!.open();
  const binding = bindExecutorSessionRun(runtime);
  binding.assertCurrent();
  runtime.setActiveGraphRunRequestId(null);
  assert.equal(binding.isCurrent(), true);
});

test('reconnecting the same URL cannot redirect a prepared run or its cancellation', async () => {
  await runtime.connectInternal('ws://executor.example/internal');
  FakeWebSocket.instances[0]!.open();
  const binding = bindExecutorSessionRun(runtime);
  runtime.disconnect();
  assert.equal(binding.isCurrent(), false);
  await runtime.connectInternal('ws://executor.example/internal');
  const replacement = FakeWebSocket.instances.at(-1)!;
  replacement.open();
  assert.throws(binding.assertCurrent, /Executor changed/);
  assert.equal(binding.isCurrent(), false);
  assert.deepEqual(replacement.sent, []);
});

test('idle and connecting sessions cannot be captured as run-capable connections', async () => {
  assert.throws(bindExecutorSessionRun(runtime).assertCurrent, /Executor changed/);
  await runtime.connectInternal('ws://executor.example/internal');
  const binding = bindExecutorSessionRun(runtime);
  assert.equal(binding.isCurrent(), false);
  FakeWebSocket.instances[0]!.open();
  assert.equal(binding.isCurrent(), false);
  bindExecutorSessionRun(runtime).assertCurrent();
});

test('delayed Evaluation preparation rejects a replaced connection without registering or sending a run', async () => {
  await runtime.connectInternal('ws://executor.example/internal');
  const original = FakeWebSocket.instances[0]!;
  original.open();
  const connection = bindExecutorSessionRun(runtime);
  let resumePreparation!: () => void;
  const preparation = new Promise<void>((resolve) => {
    resumePreparation = resolve;
  });
  let registered = false;
  const run = (async () => {
    await preparation;
    return sendPendingRemoteGraphRunRequest({
      executorSession: runtime,
      disconnectErrorMessage: 'disconnected',
      payload: { graphId: 'graph-1' as GraphId, contextValues: {} },
      onRequestCreated: () => {
        connection.assertCurrent();
        registered = true;
      },
      sendRun: (payload) => {
        connection.assertCurrent();
        return runtime.sendMessage('run', payload);
      },
    });
  })();
  const rejection = assert.rejects(run, /Executor changed/);
  runtime.disconnect();
  await runtime.connectInternal('ws://executor.example/internal');
  const replacement = FakeWebSocket.instances.at(-1)!;
  replacement.open();
  resumePreparation();
  await rejection;
  assert.equal(registered, false);
  assert.deepEqual(original.sent, []);
  assert.deepEqual(replacement.sent, []);
});

test('cancellation of an accepted Evaluation cannot send abort to a replacement connection', async () => {
  await runtime.connectInternal('ws://executor.example/internal');
  const original = FakeWebSocket.instances[0]!;
  original.open();
  const connection = bindExecutorSessionRun(runtime);
  const controller = new AbortController();
  const run = sendPendingRemoteGraphRunRequest({
    executorSession: runtime,
    disconnectErrorMessage: 'disconnected',
    abortSignal: controller.signal,
    payload: { graphId: 'graph-1' as GraphId, contextValues: {} },
    sendRun: (payload) => {
      connection.assertCurrent();
      return runtime.sendMessage('run', payload);
    },
    sendAbort: (requestId) => connection.isCurrent() && runtime.sendMessage('abort', { requestId }),
  });
  const rejection = assert.rejects(run, /disconnected/);
  assert.equal(original.sent.length, 1);
  runtime.disconnect();
  await runtime.connectInternal('ws://executor.example/internal');
  const replacement = FakeWebSocket.instances.at(-1)!;
  replacement.open();
  controller.abort();
  await rejection;
  assert.deepEqual(replacement.sent, []);
  assert.equal(original.sent.length, 1);
});

test('readiness cancellation rejects promptly instead of waiting for connection timeout', async () => {
  await runtime.connectInternal('ws://executor.example/internal');
  const controller = new AbortController();
  const waiting = waitForExecutorSessionRunCapability(runtime, 30_000, controller.signal);
  const reason = new Error('preparation canceled');
  controller.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
  FakeWebSocket.instances[0]!.open();
  assert.equal(runtime.getRuntimeState().status, 'ready');
});

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

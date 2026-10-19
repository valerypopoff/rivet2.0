import assert from 'node:assert/strict';
import test from 'node:test';
import { getSubgraphProjectKey, type ProjectId } from '@valerypopoff/rivet2-core';
import { createExecutorSessionRuntime } from './executorSession.js';
import { FakeWebSocket, installExecutorSessionTestHooks } from './executorSessionTestUtils.js';
import { createRemoteExecutionObservationRouter } from './remoteExecutionObservation.js';

installExecutorSessionTestHooks();

test('HA transport resume preserves dependency admission, deduplicates projection, and never emits child commands', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = 'a' as ProjectId;
  const b = 'b' as ProjectId;
  const runtime = createExecutorSessionRuntime({ projectId: a, onStateChange() {} });
  const projected: string[] = [];
  const settled: string[] = [];
  let removed = 0;
  const router = createRemoteExecutionObservationRouter({
    receivers: () =>
      new Map([
        [a, { token: 1 }],
        [b, { token: 2 }],
      ]),
    conflict: () => undefined,
    publish() {},
    notice() {},
    remove() {
      removed++;
    },
    project(projectId, message) {
      projected.push(`${projectId}:${message}`);
    },
    settle(projectId, root, status) {
      settled.push(`${projectId}:${root}:${status}`);
    },
  });
  runtime.subscribeMessages((message, data, _request, admission) =>
    router.receive(runtime, a, 'A', message, data, admission!.decision.shouldDispatch),
  );
  runtime.subscribeLifecycle('disconnect', () => router.disconnect(runtime));
  const execution = { projectId: a, graphId: 'main', graphRunId: 'a-run', rootRunId: 'root' };
  const child = {
    ...execution,
    projectId: b,
    graphRunId: 'b-run',
    parentGraphRunId: 'a-run',
    projectScope: getSubgraphProjectKey({ projectId: b, version: 'latest' }),
  };
  const frames = [
    { message: 'start', data: { execution, project: { metadata: { id: a } } }, rivetEventId: 'owner:1' },
    { message: 'graphStart', data: { execution: child }, rivetEventId: 'owner:2' },
    {
      message: 'nodeStart',
      data: { execution: child, node: { id: 'node' }, processId: 'process' },
      rivetEventId: 'owner:3',
    },
  ];
  try {
    await runtime.connectExternalDebugger('wss://rivet.example/ws/latest-debugger');
    const first = FakeWebSocket.instances.at(-1)!;
    first.open();
    first.emitMessage({ message: 'latest-session', data: { protocol: 1 } });
    for (const frame of frames) first.emitMessage(frame);
    assert.deepEqual(projected, ['b:graphStart', 'b:nodeStart']);
    first.emitClose();
    t.mock.timers.tick(200);
    assert.deepEqual(settled, [], 'a physical reconnect is not observation disposal');
    const resumed = FakeWebSocket.instances.at(-1)!;
    assert.notEqual(resumed, first);
    resumed.open();
    resumed.emitMessage({ message: 'latest-session', data: { protocol: 1 } });
    for (const frame of frames) resumed.emitMessage(frame);
    resumed.emitMessage({
      message: 'nodeFinish',
      data: { execution: child, node: { id: 'node' }, processId: 'process' },
      rivetEventId: 'owner:4',
    });
    resumed.emitMessage({ message: 'done', data: { execution, results: {} }, rivetEventId: 'owner:5' });
    assert.deepEqual(projected, ['b:graphStart', 'b:nodeStart', 'b:nodeFinish']);
    assert.deepEqual(settled, ['b:root:completed']);
    assert.deepEqual(
      FakeWebSocket.instances.flatMap((socket) => socket.sent),
      [],
    );
    runtime.disconnect();
    assert.equal(removed, 1);
    assert.equal(settled.length, 1, 'explicit disconnect must retain completed data');
  } finally {
    runtime.disconnect();
    router.dispose();
  }
});

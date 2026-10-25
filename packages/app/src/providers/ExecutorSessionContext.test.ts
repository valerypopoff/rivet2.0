import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type ProjectId, type RemoteRunRequestId } from '@valerypopoff/rivet2-core';
import { createExecutorSessionRegistry } from './ExecutorSessionContext.js';
import { attachAndStartDesktopSidecarForRuntime } from '../hooks/executorSessionRuntimeResources.js';
import { FakeWebSocket } from '../hooks/executorSessionTestUtils.js';
import { bindExecutorSessionRun } from '../hooks/executorSessionRunReadiness.js';

describe('ExecutorSessionRegistry', () => {
  test(
    'internal request display keeps its originating binding even if replacement precedes its first frame',
    { timeout: 2000 },
    async () => {
      const original = globalThis.WebSocket;
      globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
      FakeWebSocket.instances = [];
      let lifetime = 'first';
      const registry = createExecutorSessionRegistry({ onStateChange() {}, getProjectBindingLifetime: () => lifetime });
      try {
        const runtime = registry.getRuntime('a' as ProjectId);
        await runtime.connectInternalHostedExecutor('ws://internal');
        const socket = FakeWebSocket.instances.at(-1)!;
        socket.open();
        const pending = runtime.createPendingGraphExecution('request' as RemoteRunRequestId);
        void pending.promise.catch(() => {});
        runtime.setActiveGraphRunRequestId(pending.requestId);
        lifetime = 'replacement';
        runtime.setActiveGraphRunRequestId(pending.requestId); // Re-observing the request must not recapture a new owner.
        const displays: boolean[] = [];
        runtime.subscribeMessages((_message, _data, _request, admission) => {
          displays.push(admission?.sourceDisplayAllowed !== false);
        });
        const execution = { projectId: 'a', rootRunId: 'root', graphRunId: 'graph', graphId: 'main' };
        socket.emitMessage({
          message: 'start',
          requestId: pending.requestId,
          data: {
            execution,
            project: { metadata: { id: 'a' } },
            startGraph: { metadata: { id: 'main' }, nodes: [], connections: [] },
          },
        });
        assert.deepEqual(displays, [false]);
        socket.emitMessage({
          message: 'done',
          requestId: pending.requestId,
          data: { execution, results: { value: { type: 'string', value: 'accepted result' } } },
        });
        assert.deepEqual(await pending.promise, { value: { type: 'string', value: 'accepted result' } });
        assert.deepEqual(displays, [false, false]);
        runtime.setActiveGraphRunRequestId('next' as RemoteRunRequestId);
        socket.emitMessage({
          message: 'start',
          requestId: 'next',
          data: {
            execution: { ...execution, rootRunId: 'fresh' },
            project: { metadata: { id: 'a' } },
            startGraph: { metadata: { id: 'main' }, nodes: [], connections: [] },
          },
        });
        assert.equal(displays.at(-1), true);
        assert.deepEqual(socket.sent, [], 'display fencing neither retries nor aborts an accepted request');
      } finally {
        registry.disconnectAll();
        globalThis.WebSocket = original;
      }
    },
  );
  test('explicit bundle reconciliation removes moved members without merging debugger groups', async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    FakeWebSocket.instances = [];
    const registry = createExecutorSessionRegistry({ onStateChange() {} });
    const a = 'a' as ProjectId,
      b = 'b' as ProjectId,
      c = 'c' as ProjectId;
    try {
      await registry.connectBundleDebugger(a, [a, b], 'ws://bundle', 'one');
      FakeWebSocket.instances.at(-1)!.open();
      const runtime = registry.getRemoteDebuggerRuntime(b);
      const keys = new Map([
        [a, 'two'],
        [b, 'one'],
        [c, 'one'],
      ]);
      registry.refreshDebuggerBundles(
        (id) => [...keys].filter(([, key]) => key === keys.get(id)).map(([id]) => id),
        (id) => keys.get(id)!,
      );
      assert.equal(registry.getRemoteDebuggerRuntime(a), undefined);
      assert.equal(registry.getRemoteDebuggerRuntime(b), runtime);
      assert.equal(registry.getRemoteDebuggerRuntime(c), runtime);
      registry.removeProject(b);
      assert.equal(registry.getRemoteDebuggerRuntime(c), runtime);
      registry.removeProject(c);
      assert.equal(runtime!.getRuntimeState().status, 'idle');
    } finally {
      registry.disconnectAll();
      globalThis.WebSocket = original;
    }
  });
  test('shared debugger attachment invalidates an in-flight local preparation even while its connection stays ready', async () => {
    const original = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const registry = createExecutorSessionRegistry({ onStateChange() {} });
    const a = 'a' as ProjectId,
      b = 'b' as ProjectId;
    try {
      const own = registry.getRuntime(a);
      await own.connectInternalHostedExecutor('ws://internal');
      const internal = FakeWebSocket.instances.at(-1)!;
      internal.open();
      const prepared = bindExecutorSessionRun(
        own,
        undefined,
        () => registry.getRemoteDebuggerRuntime(a) ?? registry.getRuntime(a),
      );
      prepared.assertCurrent();
      await registry.connectBundleDebugger(b, [a, b], 'ws://bundle');
      FakeWebSocket.instances.at(-1)!.open();
      assert.equal(own.getRuntimeState().capabilities.canSendRun, true, 'the personal connection was not replaced');
      assert.throws(prepared.assertCurrent, /Executor changed/);
      assert.equal(prepared.isCurrent(), false, 'stale cancellation must not send commands either');
      assert.deepEqual(internal.sent, []);
    } finally {
      registry.disconnectAll();
      globalThis.WebSocket = original;
    }
  });
  test('closing and reopening a root tab fences its old source display without dropping dependency events', async () => {
    const original = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const registry = createExecutorSessionRegistry({ onStateChange() {} });
    const a = 'a' as ProjectId,
      b = 'b' as ProjectId;
    try {
      await registry.connectBundleDebugger(b, [a, b], 'ws://bundle');
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.open();
      const events: Array<{ accepted: boolean; display: boolean }> = [];
      registry.subscribeMessagesForAllProjects((_id, _runtime, _message, _data, _request, admission) => {
        events.push({
          accepted: admission!.decision.shouldDispatch,
          display: admission?.sourceDisplayAllowed !== false,
        });
      });
      const execution = { rootRunId: 'old-root', graphRunId: 'a-run', graphId: 'main', projectId: a };
      const start = { message: 'start', data: { project: { metadata: { id: a } }, execution } };
      socket.emitMessage(start);
      registry.removeProject(a);
      socket.emitMessage({ message: 'nodeFinish', data: { execution, node: { id: 'node' }, processId: 'old' } });
      registry.refreshDebuggerBundles(() => [a, b]);
      socket.emitMessage(start);
      socket.emitMessage({ message: 'nodeFinish', data: { execution, node: { id: 'node' }, processId: 'old' } });
      socket.emitMessage({
        message: 'nodeFinish',
        data: {
          execution: { ...execution, projectId: b, graphRunId: 'b-run', parentGraphRunId: 'a-run' },
          node: { id: 'node' },
          processId: 'child',
        },
      });
      socket.emitMessage({
        ...start,
        data: { ...start.data, execution: { ...execution, rootRunId: 'new-root', graphRunId: 'new-a' } },
      });
      assert.deepEqual(events, [
        { accepted: true, display: true },
        { accepted: true, display: false },
        { accepted: true, display: false },
        { accepted: true, display: false },
        { accepted: true, display: false },
        { accepted: true, display: true },
      ]);
      assert.equal(socket.readyState, FakeWebSocket.OPEN);
      assert.deepEqual(socket.sent, []);
    } finally {
      registry.disconnectAll();
      globalThis.WebSocket = original;
    }
  });
  test('a reopened source cannot reacquire disconnect cleanup through its old run', async () => {
    const original = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const registry = createExecutorSessionRegistry({ onStateChange() {} });
    const a = 'a' as ProjectId,
      b = 'b' as ProjectId;
    try {
      await registry.connectBundleDebugger(b, [a, b], 'ws://bundle');
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.open();
      const display: boolean[] = [];
      const disconnects: ProjectId[] = [];
      registry.subscribeMessagesForAllProjects((_id, _runtime, _message, _data, _request, admission) => {
        assert.equal(admission!.decision.shouldDispatch, true);
        display.push(admission!.sourceDisplayAllowed !== false);
      });
      registry.subscribeDisconnectsForAllProjects((id) => disconnects.push(id));
      const execution = { rootRunId: 'root', graphRunId: 'a-run', graphId: 'main', projectId: a };
      socket.emitMessage({ message: 'start', data: { project: { metadata: { id: a } }, execution } });
      registry.removeProject(a);
      registry.refreshDebuggerBundles(() => [a, b]);
      socket.emitMessage({ message: 'done', data: { execution, results: {} } });
      registry.getRemoteDebuggerRuntime(b)!.disconnect();
      assert.deepEqual(display, [true, false]);
      assert.equal(disconnects.length, 1, 'global observers still receive disconnect cleanup');
      assert.equal(disconnects.includes(a), false, 'the reopened source must not be finalized by its old socket');
      assert.equal(disconnects.includes(b), false, 'the initiating tab is not necessarily the source');
    } finally {
      registry.disconnectAll();
      globalThis.WebSocket = original;
    }
  });
  test('a root first seen while its source is closed cannot bind a later tab through a duplicate start', async () => {
    const original = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const registry = createExecutorSessionRegistry({ onStateChange() {} });
    const a = 'a' as ProjectId,
      b = 'b' as ProjectId;
    try {
      await registry.connectBundleDebugger(b, [b], 'ws://bundle');
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.open();
      const events: Array<{ accepted: boolean; display: boolean }> = [];
      registry.subscribeMessagesForAllProjects((_id, _runtime, _message, _data, _request, admission) => {
        events.push({
          accepted: admission!.decision.shouldDispatch,
          display: admission!.sourceDisplayAllowed !== false,
        });
      });
      const start = {
        message: 'start',
        data: {
          project: { metadata: { id: a } },
          execution: { rootRunId: 'old', graphRunId: 'old-a', graphId: 'main', projectId: a },
        },
      };
      socket.emitMessage(start);
      registry.refreshDebuggerBundles(() => [a, b]);
      socket.emitMessage(start);
      socket.emitMessage({
        ...start,
        data: { ...start.data, execution: { ...start.data.execution, rootRunId: 'new', graphRunId: 'new-a' } },
      });
      assert.deepEqual(events, [
        { accepted: true, display: false },
        { accepted: true, display: false },
        { accepted: true, display: true },
      ]);
    } finally {
      registry.disconnectAll();
      globalThis.WebSocket = original;
    }
  });
  test('a dependency starts one shared debugger, routes actual roots, and any member can stop it', async () => {
    const original = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const registry = createExecutorSessionRegistry({ onStateChange() {} });
    const a = 'a' as ProjectId,
      b = 'b' as ProjectId,
      c = 'c' as ProjectId,
      d = 'd' as ProjectId;
    try {
      const connecting = registry.connectBundleDebugger(b, [a, b, c], 'ws://bundle');
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.open();
      await connecting;
      const shared = registry.getRemoteDebuggerRuntime(b)!;
      assert.equal(registry.getRemoteDebuggerRuntime(a), shared);
      assert.equal(registry.getRemoteDebuggerRuntime(c), shared);
      assert.equal(registry.getRemoteDebuggerRuntime(d), undefined);
      assert.notEqual(registry.getRuntime(b), shared, 'local preferences/runtime remain separate');
      await registry.connectBundleDebugger(c, [a, b, c], 'ws://bundle');
      assert.equal(FakeWebSocket.instances.length, 1);
      const events: Array<{ project: ProjectId | undefined; accepted: boolean; display: boolean }> = [];
      registry.subscribeMessagesForAllProjects((_id, _runtime, _message, _data, _request, admission) => {
        events.push({
          project: admission?.projectId,
          accepted: admission!.decision.shouldDispatch,
          display: admission?.sourceDisplayAllowed !== false,
        });
      });
      socket.emitMessage({
        message: 'start',
        data: {
          project: { metadata: { id: a } },
          execution: { rootRunId: 'root-a', graphRunId: 'a-run', graphId: 'main', projectId: a },
        },
      });
      socket.emitMessage({
        message: 'graphStart',
        data: {
          execution: {
            rootRunId: 'root-a',
            graphRunId: 'c-run',
            graphId: 'main',
            projectId: c,
            parentGraphRunId: 'a-run',
          },
        },
      });
      socket.emitMessage({
        message: 'done',
        data: { execution: { rootRunId: 'root-a', graphRunId: 'a-run', graphId: 'main', projectId: a }, results: {} },
      });
      socket.emitMessage({
        message: 'start',
        data: {
          project: { metadata: { id: b } },
          execution: {
            rootRunId: 'root-b',
            graphRunId: 'b-run',
            graphId: 'main',
            projectId: b,
          },
        },
      });
      socket.emitMessage({ message: 'trace', data: 'B trace without execution metadata' });
      socket.emitMessage({
        message: 'done',
        data: {
          results: {},
          execution: {
            rootRunId: 'root-b',
            graphRunId: 'b-run',
            graphId: 'main',
            projectId: b,
          },
        },
      });
      socket.emitMessage({
        message: 'start',
        data: {
          project: { metadata: { id: d } },
          execution: { rootRunId: 'root-d', graphRunId: 'd-run', graphId: 'main', projectId: d },
        },
      });
      assert.deepEqual(events, [
        { project: a, accepted: true, display: true },
        { project: a, accepted: true, display: true },
        { project: a, accepted: true, display: true },
        { project: b, accepted: true, display: true },
        { project: b, accepted: true, display: true },
        { project: b, accepted: true, display: true },
        { project: d, accepted: true, display: false },
      ]);
      registry.removeProject(b);
      assert.equal(
        registry.getRemoteDebuggerRuntime(a),
        shared,
        'closing the initiating tab must not close the bundle connection',
      );
      assert.equal(socket.readyState, FakeWebSocket.OPEN);
      registry.getRemoteDebuggerRuntime(c)!.disconnect();
      assert.equal(registry.getRemoteDebuggerRuntime(a), undefined);
      assert.equal(registry.getRemoteDebuggerRuntime(c), undefined);
      assert.equal(socket.readyState, FakeWebSocket.CLOSED);
      assert.deepEqual(socket.sent, [], 'stopping observation must not abort/pause the runtime');
    } finally {
      registry.disconnectAll();
      globalThis.WebSocket = original;
    }
  });
  test('new linked tabs join the bundle and closing its last member releases only that connection', async () => {
    const original = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const registry = createExecutorSessionRegistry({ onStateChange() {} });
    const a = 'a' as ProjectId,
      b = 'b' as ProjectId,
      c = 'c' as ProjectId,
      d = 'd' as ProjectId;
    try {
      await registry.connectBundleDebugger(a, [a, b], 'ws://same');
      const first = FakeWebSocket.instances.at(-1)!;
      first.open();
      await registry.connectBundleDebugger(d, [d], 'ws://same');
      const separate = FakeWebSocket.instances.at(-1)!;
      separate.open();
      registry.refreshDebuggerBundles(() => [a, b, c, d]);
      assert.equal(registry.getRemoteDebuggerRuntime(c), registry.getRemoteDebuggerRuntime(a));
      assert.notEqual(registry.getRemoteDebuggerRuntime(d), registry.getRemoteDebuggerRuntime(a));
      await assert.rejects(registry.connectBundleDebugger(c, [a, b, c], 'ws://different'), /Stop the shared/);
      registry.removeProject(a);
      registry.removeProject(b);
      assert.equal(first.readyState, FakeWebSocket.OPEN);
      registry.removeProject(c);
      assert.equal(first.readyState, FakeWebSocket.CLOSED);
      assert.equal(separate.readyState, FakeWebSocket.OPEN);
      assert.deepEqual(first.sent, []);
    } finally {
      registry.disconnectAll();
      globalThis.WebSocket = original;
    }
  });
  test('failed shared connections remove all membership without replacing local runtimes', async () => {
    const original = globalThis.WebSocket;
    const registry = createExecutorSessionRegistry({ onStateChange() {} });
    const a = 'a' as ProjectId,
      b = 'b' as ProjectId;
    const own = registry.getRuntime(b);
    globalThis.WebSocket = class {
      constructor() {
        throw new Error('socket construction failed');
      }
    } as unknown as typeof WebSocket;
    try {
      await assert.rejects(registry.connectBundleDebugger(a, [a, b], 'ws://broken'), /socket construction failed/);
      assert.equal(registry.getRemoteDebuggerRuntime(a), undefined);
      assert.equal(registry.getRemoteDebuggerRuntime(b), undefined);
      assert.equal(registry.getRuntime(b), own);
    } finally {
      registry.disconnectAll();
      globalThis.WebSocket = original;
    }
  });
  test('keeps independent runtimes for independent project tabs', () => {
    const registry = createExecutorSessionRegistry({ onStateChange: () => {} });
    const firstProjectId = 'project-a' as ProjectId;
    const secondProjectId = 'project-b' as ProjectId;

    const firstRuntime = registry.getRuntime(firstProjectId);
    const secondRuntime = registry.getRuntime(secondProjectId);

    assert.equal(registry.getRuntime(firstProjectId), firstRuntime);
    assert.equal(registry.getRuntime(secondProjectId), secondRuntime);
    assert.notEqual(firstRuntime, secondRuntime);
  });

  test('removes only the requested project runtime', () => {
    const registry = createExecutorSessionRegistry({ onStateChange: () => {} });
    const firstProjectId = 'project-a' as ProjectId;
    const secondProjectId = 'project-b' as ProjectId;
    const calls: string[] = [];
    const firstRuntime = registry.getRuntime(firstProjectId);
    const secondRuntime = registry.getRuntime(secondProjectId);

    firstRuntime.disconnect = () => {
      calls.push('first-disconnect');
    };
    secondRuntime.disconnect = () => {
      calls.push('second-disconnect');
    };

    registry.removeProject(firstProjectId);

    assert.deepEqual(calls, ['first-disconnect']);
    assert.notEqual(registry.getRuntime(firstProjectId), firstRuntime);
    assert.equal(registry.getRuntime(secondProjectId), secondRuntime);
  });

  test('removing a project releases its desktop sidecar ownership', async () => {
    const registry = createExecutorSessionRegistry({ onStateChange: () => {} });
    const projectId = 'project-a' as ProjectId;
    const runtime = registry.getRuntime(projectId);
    const calls: string[] = [];

    await attachAndStartDesktopSidecarForRuntime(runtime, {
      attachAndStart: async () => {
        calls.push('sidecar-start');
      },
      detachAndStop: async () => {
        calls.push('sidecar-stop');
      },
      isStarted: () => true,
    });
    runtime.disconnect = () => {
      calls.push('disconnect');
    };

    registry.removeProject(projectId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, ['sidecar-start', 'sidecar-stop', 'disconnect']);
  });

  test('disconnects every retained project runtime on provider shutdown', () => {
    const registry = createExecutorSessionRegistry({ onStateChange: () => {} });
    const firstRuntime = registry.getRuntime('project-a' as ProjectId);
    const secondRuntime = registry.getRuntime('project-b' as ProjectId);
    const calls: string[] = [];

    firstRuntime.disconnect = () => {
      calls.push('first-disconnect');
    };
    secondRuntime.disconnect = () => {
      calls.push('second-disconnect');
    };

    registry.disconnectAll();

    assert.deepEqual(calls, ['first-disconnect', 'second-disconnect']);
  });

  test('propagates the current dataset provider to existing and new runtimes', () => {
    const registry = createExecutorSessionRegistry({ onStateChange: () => {} });
    const provider = {} as Parameters<typeof registry.setDatasetProvider>[0];
    const firstRuntime = registry.getRuntime('project-a' as ProjectId);
    const firstCalls: Parameters<typeof registry.setDatasetProvider>[0][] = [];

    const originalSetFirstDatasetProvider = firstRuntime.setDatasetProvider.bind(firstRuntime);
    firstRuntime.setDatasetProvider = (nextProvider) => {
      firstCalls.push(nextProvider);
      originalSetFirstDatasetProvider(nextProvider);
    };
    registry.setDatasetProvider(provider);
    const secondRuntime = registry.getRuntime('project-b' as ProjectId);
    const secondCalls: Parameters<typeof registry.setDatasetProvider>[0][] = [];

    secondRuntime.setDatasetProvider = (nextProvider) => {
      secondCalls.push(nextProvider);
    };
    registry.setDatasetProvider(null);

    assert.deepEqual(firstCalls, [provider, null]);
    assert.deepEqual(secondCalls, [null]);
  });

  test('notifies project-scoped disconnect subscribers for the owning runtime', async () => {
    const originalWebSocket = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    try {
      const registry = createExecutorSessionRegistry({ onStateChange: () => {} });
      const projectId = 'project-a' as ProjectId;
      const runtime = registry.getRuntime(projectId);
      const disconnects: ProjectId[] = [];
      const unsubscribe = registry.subscribeDisconnectsForAllProjects((disconnectedProjectId) => {
        disconnects.push(disconnectedProjectId);
      });
      const connectPromise = runtime.connectInternalHostedExecutor('ws://localhost:17823');

      FakeWebSocket.instances[0]!.open();
      await connectPromise;
      runtime.disconnect();
      unsubscribe();

      assert.deepEqual(disconnects, [projectId]);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test('keeps same-url external debugger sockets independent for different project runtimes', async () => {
    const originalWebSocket = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    try {
      const registry = createExecutorSessionRegistry({ onStateChange: () => {} });
      const firstProjectId = 'project-a' as ProjectId;
      const secondProjectId = 'project-b' as ProjectId;
      const firstRuntime = registry.getRuntime(firstProjectId);
      const secondRuntime = registry.getRuntime(secondProjectId);
      const disconnects: ProjectId[] = [];
      const unsubscribe = registry.subscribeDisconnectsForAllProjects((disconnectedProjectId) => {
        disconnects.push(disconnectedProjectId);
      });

      const firstConnect = firstRuntime.connectExternalDebugger('ws://debugger.example/shared');
      const firstSocket = FakeWebSocket.instances[0]!;
      firstSocket.open();
      await firstConnect;

      const secondConnect = secondRuntime.connectExternalDebugger('ws://debugger.example/shared');
      const secondSocket = FakeWebSocket.instances[1]!;
      secondSocket.open();
      await secondConnect;
      unsubscribe();

      assert.equal(FakeWebSocket.instances.length, 2);
      assert.notEqual(firstRuntime, secondRuntime);
      assert.notEqual(firstSocket, secondSocket);
      assert.equal(firstRuntime.getRuntimeState().socket, firstSocket as unknown as WebSocket);
      assert.equal(secondRuntime.getRuntimeState().socket, secondSocket as unknown as WebSocket);
      assert.equal(firstRuntime.getRuntimeState().status, 'ready');
      assert.equal(secondRuntime.getRuntimeState().status, 'ready');
      assert.deepEqual(disconnects, []);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { type ProjectId } from '@valerypopoff/rivet2-core';
import { createExecutorSessionRegistry } from './ExecutorSessionContext.js';
import { attachAndStartDesktopSidecarForRuntime } from '../hooks/executorSessionRuntimeResources.js';
import { FakeWebSocket } from '../hooks/executorSessionTestUtils.js';

describe('ExecutorSessionRegistry', () => {
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

  test('settles request-scoped inactive terminal events before visual dispatch filtering', async () => {
    const source = await readFile(new URL('./ExecutorSessionContext.tsx', import.meta.url), 'utf8');

    assert.match(
      source,
      /const shouldSettlePendingRequest = requestId != null \|\| dispatchDecision\.shouldDispatch;/,
    );
    assert.match(source, /if \(!dispatchDecision\.shouldDispatch\) \{\s+return;\s+\}/);
  });

  test('flushes frozen outputs for inactive external debugger runs', async () => {
    const source = await readFile(new URL('./ExecutorSessionContext.tsx', import.meta.url), 'utf8');

    assert.match(source, /shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent/);
    assert.match(source, /alreadyFlushed: false/);
    assert.match(source, /target: runtimeState\.target/);
    assert.match(
      source,
      /const nextSnapshot = shouldFlushFrozenOutputs[\s\S]*frozenNodeOutputs: \{\},[\s\S]*: result\.snapshot;/,
    );
  });

  test('settles running inactive project snapshots on executor disconnect', async () => {
    const source = await readFile(new URL('./ExecutorSessionContext.tsx', import.meta.url), 'utf8');

    assert.match(source, /subscribeDisconnectsForAllProjects/);
    assert.match(source, /if \(!previousSnapshot\?\.graphRunning\) \{\s+return previousSnapshots;\s+\}/);
    assert.match(source, /message: 'error'/);
    assert.match(source, /Executor session disconnected/);
  });
});

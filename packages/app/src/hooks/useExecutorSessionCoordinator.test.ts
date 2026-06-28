import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type ExecutorSessionStartupAction,
  getExecutorSessionStartupAction,
  handleExecutorSessionCoordinatorDisconnect,
  runExecutorSessionStartupAction,
  shouldRestoreInternalNodeExecutorAfterDisconnect,
  shouldRestoreInternalNodeExecutorAfterExternalDebuggerDisconnect,
} from './useExecutorSessionCoordinator.js';
import type { ExecutorSessionLifecycleEvent, ExecutorSessionRuntime } from './executorSession.js';

const externalDropEvent: ExecutorSessionLifecycleEvent = {
  isInternalExecutor: false,
  reason: 'unexpected-disconnect',
  status: 'idle',
  target: { type: 'external-debugger', url: 'ws://localhost:21888' },
  type: 'disconnected',
  url: 'ws://localhost:21888',
};

const internalDesktopDropEvent: ExecutorSessionLifecycleEvent = {
  isInternalExecutor: true,
  reason: 'unexpected-disconnect',
  status: 'reconnecting',
  target: { type: 'internal-desktop', url: 'ws://127.0.0.1:21889/internal' },
  type: 'disconnected',
  url: 'ws://127.0.0.1:21889/internal',
};

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createStartupHarness() {
  const calls: string[] = [];
  const sidecarStart = createDeferred();
  let sidecarStarted = false;

  const runtime = {
    connectInternalDesktopExecutor: async () => {
      calls.push('connect-desktop');
    },
    connectInternalHostedExecutor: async (url: string) => {
      calls.push(`connect-hosted:${url}`);
    },
    disconnect: () => {
      calls.push('disconnect');
    },
  };

  const sidecar = {
    attachAndStart: async () => {
      calls.push('sidecar-start');
      await sidecarStart.promise;
    },
    detachAndStop: async () => {
      calls.push('sidecar-stop');
    },
    isStarted: () => sidecarStarted,
    restart: async () => {
      calls.push('sidecar-restart');
      sidecarStarted = true;
    },
  };

  return {
    calls,
    runtime,
    setSelectedExecutor: (executor: 'browser' | 'nodejs') => {
      calls.push(`set-executor:${executor}`);
    },
    sidecar,
    sidecarStart,
    setSidecarStarted(started: boolean) {
      sidecarStarted = started;
    },
  };
}

function createLifecycleHarness() {
  const calls: string[] = [];
  const sidecarStart = createDeferred();
  let selectedExecutor: 'browser' | 'nodejs' = 'nodejs';
  let internalExecutorUrl: string | undefined = 'ws://executor.example/internal-a';
  let sidecarStarted = false;

  const runtime = {
    connectInternalDesktopExecutor: async () => {
      calls.push('connect-desktop');
    },
    connectInternalHostedExecutor: async (url: string) => {
      calls.push(`connect-hosted:${url}`);
    },
    disconnect: () => {
      calls.push('disconnect');
    },
  };

  const sidecar = {
    attachAndStart: async () => {
      calls.push('sidecar-start');
      await sidecarStart.promise;
    },
    detachAndStop: async () => {
      calls.push('sidecar-stop');
    },
    isStarted: () => sidecarStarted,
    restart: async () => {
      calls.push('sidecar-restart');
      sidecarStarted = true;
    },
  };

  return {
    calls,
    runtime,
    sidecar,
    sidecarStart,
    getInternalExecutorUrl: () => internalExecutorUrl,
    getSelectedExecutor: () => selectedExecutor,
    setInternalExecutorUrl(url: string | undefined) {
      internalExecutorUrl = url;
    },
    setSelectedExecutor(executor: 'browser' | 'nodejs') {
      selectedExecutor = executor;
    },
    setSidecarStarted(started: boolean) {
      sidecarStarted = started;
    },
  };
}

function getExternalDebuggerRuntimeState() {
  return {
    capabilities: {
      canBridgeDatasets: false,
      canRecordSocket: false,
      canSendAbort: false,
      canSendPause: false,
      canSendResume: false,
      canSendRun: false,
      canUploadProject: false,
    },
    isInternalExecutor: false,
    remoteUploadAllowed: false,
    socket: null,
    status: 'ready',
    target: { type: 'external-debugger', url: 'ws://localhost:21888' },
    url: 'ws://localhost:21888',
  } satisfies ReturnType<ExecutorSessionRuntime['getRuntimeState']>;
}

function getInternalHostedRuntimeState() {
  return {
    capabilities: {
      canBridgeDatasets: false,
      canRecordSocket: false,
      canSendAbort: false,
      canSendPause: false,
      canSendResume: false,
      canSendRun: false,
      canUploadProject: false,
    },
    isInternalExecutor: true,
    remoteUploadAllowed: false,
    socket: null,
    status: 'ready',
    target: { type: 'internal-hosted', url: 'ws://executor.example/internal' },
    url: 'ws://executor.example/internal',
  } satisfies ReturnType<ExecutorSessionRuntime['getRuntimeState']>;
}

describe('useExecutorSessionCoordinator', () => {
  test('derives startup actions for browser, hosted node, desktop node, and plain web fallback', () => {
    assert.deepEqual(
      getExecutorSessionStartupAction({
        isTauri: false,
        selectedExecutor: 'browser',
      }),
      { type: 'disconnect' },
    );

    assert.deepEqual(
      getExecutorSessionStartupAction({
        internalExecutorUrl: 'ws://executor.example/internal',
        isTauri: false,
        selectedExecutor: 'nodejs',
      }),
      { type: 'connect-hosted-internal', url: 'ws://executor.example/internal' },
    );

    assert.deepEqual(
      getExecutorSessionStartupAction({
        isTauri: true,
        selectedExecutor: 'nodejs',
      }),
      { type: 'connect-desktop-internal' },
    );

    assert.deepEqual(
      getExecutorSessionStartupAction({
        isTauri: false,
        selectedExecutor: 'nodejs',
      }),
      { type: 'fallback-browser' },
    );
  });

  test('restores Node executor after an external debugger drops in hosted Node mode', () => {
    assert.equal(
      shouldRestoreInternalNodeExecutorAfterExternalDebuggerDisconnect({
        event: externalDropEvent,
        hasInternalExecutorUrl: true,
        isTauri: false,
        selectedExecutor: 'nodejs',
      }),
      true,
    );
  });

  test('restores Node executor after an external debugger drops in desktop Node mode', () => {
    assert.equal(
      shouldRestoreInternalNodeExecutorAfterExternalDebuggerDisconnect({
        event: externalDropEvent,
        hasInternalExecutorUrl: false,
        isTauri: true,
        selectedExecutor: 'nodejs',
      }),
      true,
    );
  });

  test('restores Node executor after an explicit external debugger disconnect in Node mode', () => {
    assert.equal(
      shouldRestoreInternalNodeExecutorAfterExternalDebuggerDisconnect({
        event: {
          ...externalDropEvent,
          reason: 'manual-disconnect',
        },
        hasInternalExecutorUrl: true,
        isTauri: false,
        selectedExecutor: 'nodejs',
      }),
      true,
    );
  });

  test('external-debugger restore helper ignores Browser mode and internal executor drops', () => {
    assert.equal(
      shouldRestoreInternalNodeExecutorAfterExternalDebuggerDisconnect({
        event: externalDropEvent,
        hasInternalExecutorUrl: true,
        isTauri: false,
        selectedExecutor: 'browser',
      }),
      false,
    );

    assert.equal(
      shouldRestoreInternalNodeExecutorAfterExternalDebuggerDisconnect({
        event: {
          ...externalDropEvent,
          isInternalExecutor: true,
          target: { type: 'internal-hosted', url: 'ws://executor.example/internal' },
          url: 'ws://executor.example/internal',
        },
        hasInternalExecutorUrl: true,
        isTauri: false,
        selectedExecutor: 'nodejs',
      }),
      false,
    );
  });

  test('restores desktop Node executor after an internal desktop drop', () => {
    assert.equal(
      shouldRestoreInternalNodeExecutorAfterDisconnect({
        event: internalDesktopDropEvent,
        hasInternalExecutorUrl: false,
        isTauri: true,
        selectedExecutor: 'nodejs',
      }),
      true,
    );
  });

  test('does not restore Node executor for replacement lifecycle events', () => {
    assert.equal(
      shouldRestoreInternalNodeExecutorAfterExternalDebuggerDisconnect({
        event: {
          ...externalDropEvent,
          reason: 'replaced',
        },
        hasInternalExecutorUrl: true,
        isTauri: false,
        selectedExecutor: 'nodejs',
      }),
      false,
    );
  });

  test('disconnect lifecycle handler restores the current hosted executor URL', () => {
    const harness = createLifecycleHarness();

    handleExecutorSessionCoordinatorDisconnect({
      event: externalDropEvent,
      getInternalExecutorUrl: harness.getInternalExecutorUrl,
      getSelectedExecutor: harness.getSelectedExecutor,
      isTauri: false,
      runtime: harness.runtime,
    });

    harness.setInternalExecutorUrl('ws://executor.example/internal-b');

    handleExecutorSessionCoordinatorDisconnect({
      event: externalDropEvent,
      getInternalExecutorUrl: harness.getInternalExecutorUrl,
      getSelectedExecutor: harness.getSelectedExecutor,
      isTauri: false,
      runtime: harness.runtime,
    });

    assert.deepEqual(harness.calls, [
      'connect-hosted:ws://executor.example/internal-a',
      'connect-hosted:ws://executor.example/internal-b',
    ]);
  });

  test('disconnect lifecycle handler does not restore Node after the user switched to Browser', () => {
    const harness = createLifecycleHarness();

    harness.setSelectedExecutor('browser');

    handleExecutorSessionCoordinatorDisconnect({
      event: externalDropEvent,
      getInternalExecutorUrl: harness.getInternalExecutorUrl,
      getSelectedExecutor: harness.getSelectedExecutor,
      isTauri: false,
      runtime: harness.runtime,
    });

    assert.deepEqual(harness.calls, []);
  });

  test('disconnect lifecycle handler restores desktop Node after the sidecar is ready', async () => {
    const harness = createLifecycleHarness();

    harness.setInternalExecutorUrl(undefined);

    handleExecutorSessionCoordinatorDisconnect({
      event: externalDropEvent,
      getInternalExecutorUrl: harness.getInternalExecutorUrl,
      getSelectedExecutor: harness.getSelectedExecutor,
      isTauri: true,
      runtime: harness.runtime,
      sidecar: harness.sidecar,
    });
    await flushMicrotasks();
    harness.setSidecarStarted(true);
    harness.sidecarStart.resolve();
    await flushMicrotasks();

    assert.deepEqual(harness.calls, ['sidecar-start', 'connect-desktop']);
  });

  test('disconnect lifecycle handler restarts desktop sidecar before reconnecting desktop Node', async () => {
    const harness = createStartupHarness();

    runExecutorSessionStartupAction({
      action: { type: 'connect-desktop-internal' },
      runtime: harness.runtime,
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    await flushMicrotasks();
    harness.setSidecarStarted(true);
    harness.sidecarStart.resolve();
    await flushMicrotasks();

    handleExecutorSessionCoordinatorDisconnect({
      event: internalDesktopDropEvent,
      getInternalExecutorUrl: () => undefined,
      getSelectedExecutor: () => 'nodejs',
      isTauri: true,
      runtime: harness.runtime,
      sidecar: harness.sidecar,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    assert.deepEqual(harness.calls, ['sidecar-start', 'connect-desktop', 'sidecar-restart', 'connect-desktop']);
  });

  test('runs the browser startup action by disconnecting the current session', () => {
    const harness = createStartupHarness();

    const cleanup = runExecutorSessionStartupAction({
      action: { type: 'disconnect' },
      runtime: harness.runtime,
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    cleanup?.();

    assert.deepEqual(harness.calls, ['disconnect']);
  });

  test('runs the hosted Node startup action and keeps the session on coordinator cleanup', async () => {
    const harness = createStartupHarness();

    const cleanup = runExecutorSessionStartupAction({
      action: { type: 'connect-hosted-internal', url: 'ws://executor.example/internal' },
      runtime: harness.runtime,
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    await flushMicrotasks();
    cleanup?.();

    assert.deepEqual(harness.calls, ['connect-hosted:ws://executor.example/internal']);
  });

  test('hosted Node startup cancels an in-flight desktop sidecar startup', async () => {
    const harness = createStartupHarness();

    runExecutorSessionStartupAction({
      action: { type: 'connect-desktop-internal' },
      runtime: harness.runtime,
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    await flushMicrotasks();
    runExecutorSessionStartupAction({
      action: { type: 'connect-hosted-internal', url: 'ws://executor.example/internal' },
      runtime: harness.runtime,
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    harness.setSidecarStarted(true);
    harness.sidecarStart.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.deepEqual(harness.calls, [
      'sidecar-start',
      'sidecar-stop',
      'connect-hosted:ws://executor.example/internal',
    ]);
  });

  test('does not disconnect an external debugger session during coordinator cleanup', async () => {
    const harness = createStartupHarness();
    let runtimeState: ReturnType<ExecutorSessionRuntime['getRuntimeState']> = getInternalHostedRuntimeState();

    const cleanup = runExecutorSessionStartupAction({
      action: { type: 'connect-hosted-internal', url: 'ws://executor.example/internal' },
      runtime: {
        ...harness.runtime,
        getRuntimeState: () => runtimeState,
      },
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    await flushMicrotasks();
    runtimeState = getExternalDebuggerRuntimeState();
    cleanup?.();

    assert.deepEqual(harness.calls, ['connect-hosted:ws://executor.example/internal']);
  });

  test('does not disconnect a restored internal Node session after external debugger cleanup', async () => {
    const harness = createStartupHarness();
    let runtimeState: ReturnType<ExecutorSessionRuntime['getRuntimeState']> = getExternalDebuggerRuntimeState();

    const cleanup = runExecutorSessionStartupAction({
      action: { type: 'connect-hosted-internal', url: 'ws://executor.example/internal' },
      runtime: {
        ...harness.runtime,
        getRuntimeState: () => runtimeState,
      },
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    await flushMicrotasks();
    runtimeState = getInternalHostedRuntimeState();
    cleanup?.();

    assert.deepEqual(harness.calls, []);
  });

  test('does not replace an existing external debugger during automatic startup', async () => {
    const startupActions: ExecutorSessionStartupAction[] = [
      { type: 'disconnect' },
      { type: 'connect-hosted-internal', url: 'ws://executor.example/internal' },
      { type: 'connect-desktop-internal' },
      { type: 'fallback-browser' },
    ];

    for (const action of startupActions) {
      const harness = createStartupHarness();
      const cleanup = runExecutorSessionStartupAction({
        action,
        runtime: {
          ...harness.runtime,
          getRuntimeState: getExternalDebuggerRuntimeState,
        },
        setSelectedExecutor: harness.setSelectedExecutor,
        sidecar: harness.sidecar,
      });

      await flushMicrotasks();
      cleanup?.();

      assert.deepEqual(harness.calls, [], `Expected ${action.type} to preserve the external debugger`);
    }
  });

  test('runs the plain-web Node fallback by selecting Browser and disconnecting', () => {
    const harness = createStartupHarness();

    const cleanup = runExecutorSessionStartupAction({
      action: { type: 'fallback-browser' },
      runtime: harness.runtime,
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });

    assert.equal(cleanup, undefined);
    assert.deepEqual(harness.calls, ['set-executor:browser', 'disconnect']);
  });

  test('runs the desktop Node startup action after the sidecar is ready', async () => {
    const harness = createStartupHarness();

    runExecutorSessionStartupAction({
      action: { type: 'connect-desktop-internal' },
      runtime: harness.runtime,
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    await flushMicrotasks();
    harness.setSidecarStarted(true);
    harness.sidecarStart.resolve();
    await flushMicrotasks();

    assert.deepEqual(harness.calls, ['sidecar-start', 'connect-desktop']);
  });

  test('keeps desktop Node startup alive if coordinator cleanup runs first', async () => {
    const harness = createStartupHarness();

    const cleanup = runExecutorSessionStartupAction({
      action: { type: 'connect-desktop-internal' },
      runtime: harness.runtime,
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    await flushMicrotasks();
    cleanup?.();
    harness.setSidecarStarted(true);
    harness.sidecarStart.resolve();
    await flushMicrotasks();

    assert.deepEqual(harness.calls, ['sidecar-start', 'connect-desktop']);
  });

  test('cancels desktop Node startup when Browser mode is explicitly selected', async () => {
    const harness = createStartupHarness();

    runExecutorSessionStartupAction({
      action: { type: 'connect-desktop-internal' },
      runtime: harness.runtime,
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    await flushMicrotasks();
    runExecutorSessionStartupAction({
      action: { type: 'disconnect' },
      runtime: harness.runtime,
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    harness.setSidecarStarted(true);
    harness.sidecarStart.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(harness.calls.filter((call) => call === 'connect-desktop').length, 0);
    assert.equal(harness.calls.filter((call) => call === 'disconnect').length, 1);
    assert.equal(harness.calls.filter((call) => call === 'sidecar-stop').length, 1);
  });

  test('does not replace an external debugger if desktop startup finishes late', async () => {
    const harness = createStartupHarness();
    let runtimeState: ReturnType<ExecutorSessionRuntime['getRuntimeState']> = getInternalHostedRuntimeState();

    runExecutorSessionStartupAction({
      action: { type: 'connect-desktop-internal' },
      runtime: {
        ...harness.runtime,
        getRuntimeState: () => runtimeState,
      },
      setSelectedExecutor: harness.setSelectedExecutor,
      sidecar: harness.sidecar,
    });
    await flushMicrotasks();
    runtimeState = getExternalDebuggerRuntimeState();
    harness.setSidecarStarted(true);
    harness.sidecarStart.resolve();
    await flushMicrotasks();

    assert.deepEqual(harness.calls, ['sidecar-start']);
  });
});

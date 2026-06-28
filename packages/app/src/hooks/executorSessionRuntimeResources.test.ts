import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachAndStartDesktopSidecarForRuntime,
  createExecutorRuntimeStartupToken,
  invalidateExecutorRuntimeStartup,
  isExecutorRuntimeStartupTokenCurrent,
  releaseDesktopSidecarForRuntime,
  restartDesktopSidecarForRuntime,
} from './executorSessionRuntimeResources.js';

function createSidecarHarness() {
  const calls: string[] = [];
  return {
    calls,
    sidecar: {
      attachAndStart: async () => {
        calls.push('attach');
      },
      detachAndStop: async () => {
        calls.push('detach');
      },
      isStarted: () => true,
    },
  };
}

test('desktop sidecar ownership attaches once per executor runtime', async () => {
  const runtime = {};
  const { calls, sidecar } = createSidecarHarness();

  await attachAndStartDesktopSidecarForRuntime(runtime, sidecar);
  await attachAndStartDesktopSidecarForRuntime(runtime, sidecar);
  releaseDesktopSidecarForRuntime(runtime, sidecar);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ['attach', 'detach']);
});

test('desktop sidecar ownership releases only the owning runtime', async () => {
  const firstRuntime = {};
  const secondRuntime = {};
  const { calls, sidecar } = createSidecarHarness();

  await attachAndStartDesktopSidecarForRuntime(firstRuntime, sidecar);
  await attachAndStartDesktopSidecarForRuntime(secondRuntime, sidecar);
  releaseDesktopSidecarForRuntime(firstRuntime, sidecar);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ['attach', 'attach', 'detach']);

  releaseDesktopSidecarForRuntime(secondRuntime, sidecar);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('desktop sidecar ownership clears a resolved startup that did not actually start', async () => {
  const runtime = {};
  const calls: string[] = [];
  let started = false;
  const sidecar = {
    attachAndStart: async () => {
      calls.push('attach');
    },
    detachAndStop: async () => {
      calls.push('detach');
    },
    isStarted: () => started,
  };

  await attachAndStartDesktopSidecarForRuntime(runtime, sidecar);
  started = true;
  await attachAndStartDesktopSidecarForRuntime(runtime, sidecar);
  releaseDesktopSidecarForRuntime(runtime, sidecar);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ['attach', 'attach', 'detach']);
});

test('desktop sidecar ownership restarts the shared sidecar without releasing ownership', async () => {
  const runtime = {};
  const calls: string[] = [];
  const sidecar = {
    attachAndStart: async () => {
      calls.push('attach');
    },
    detachAndStop: async () => {
      calls.push('detach');
    },
    isStarted: () => true,
    restart: async () => {
      calls.push('restart');
    },
  };

  await attachAndStartDesktopSidecarForRuntime(runtime, sidecar);
  await restartDesktopSidecarForRuntime(runtime, sidecar);
  releaseDesktopSidecarForRuntime(runtime, sidecar);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ['attach', 'restart', 'detach']);
});

test('desktop sidecar ownership restarts the sidecar that owns the runtime', async () => {
  const runtime = {};
  const calls: string[] = [];
  const owningSidecar = {
    attachAndStart: async () => {
      calls.push('attach-owning');
    },
    detachAndStop: async () => {
      calls.push('detach-owning');
    },
    isStarted: () => true,
    restart: async () => {
      calls.push('restart-owning');
    },
  };
  const replacementSidecar = {
    attachAndStart: async () => {
      calls.push('attach-replacement');
    },
    detachAndStop: async () => {
      calls.push('detach-replacement');
    },
    isStarted: () => true,
    restart: async () => {
      calls.push('restart-replacement');
    },
  };

  await attachAndStartDesktopSidecarForRuntime(runtime, owningSidecar);
  await restartDesktopSidecarForRuntime(runtime, replacementSidecar);
  releaseDesktopSidecarForRuntime(runtime, owningSidecar);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ['attach-owning', 'restart-owning', 'detach-owning']);
});

test('desktop sidecar ownership survives a failed preserving restart', async () => {
  const runtime = {};
  const calls: string[] = [];
  let shouldFailRestart = true;
  const sidecar = {
    attachAndStart: async () => {
      calls.push('attach');
    },
    detachAndStop: async () => {
      calls.push('detach');
    },
    isStarted: () => true,
    restart: async () => {
      calls.push('restart');
      if (shouldFailRestart) {
        throw new Error('restart failed');
      }
    },
  };

  await attachAndStartDesktopSidecarForRuntime(runtime, sidecar);
  await assert.rejects(() => restartDesktopSidecarForRuntime(runtime, sidecar), /restart failed/);
  shouldFailRestart = false;
  await restartDesktopSidecarForRuntime(runtime, sidecar);
  releaseDesktopSidecarForRuntime(runtime, sidecar);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ['attach', 'restart', 'restart', 'detach']);
});

test('desktop sidecar ownership survives a preserving restart that leaves the sidecar stopped', async () => {
  const runtime = {};
  const calls: string[] = [];
  let started = true;
  const sidecar = {
    attachAndStart: async () => {
      calls.push('attach');
      started = true;
    },
    detachAndStop: async () => {
      calls.push('detach');
      started = false;
    },
    isStarted: () => started,
    restart: async () => {
      calls.push('restart');
      started = false;
    },
  };

  await attachAndStartDesktopSidecarForRuntime(runtime, sidecar);
  await restartDesktopSidecarForRuntime(runtime, sidecar);
  await restartDesktopSidecarForRuntime(runtime, sidecar);
  releaseDesktopSidecarForRuntime(runtime, sidecar);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ['attach', 'restart', 'restart', 'detach']);
});

test('executor runtime startup tokens can be invalidated without releasing ownership', async () => {
  const runtime = {};
  const firstToken = createExecutorRuntimeStartupToken(runtime);
  const secondToken = createExecutorRuntimeStartupToken(runtime);

  assert.equal(isExecutorRuntimeStartupTokenCurrent(runtime, firstToken), false);
  assert.equal(isExecutorRuntimeStartupTokenCurrent(runtime, secondToken), true);

  invalidateExecutorRuntimeStartup(runtime);

  assert.equal(isExecutorRuntimeStartupTokenCurrent(runtime, secondToken), false);
});

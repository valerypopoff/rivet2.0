import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachAndStartDesktopSidecarForRuntime,
  createExecutorRuntimeStartupToken,
  invalidateExecutorRuntimeStartup,
  isExecutorRuntimeStartupTokenCurrent,
  releaseDesktopSidecarForRuntime,
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

test('executor runtime startup tokens can be invalidated without releasing ownership', async () => {
  const runtime = {};
  const firstToken = createExecutorRuntimeStartupToken(runtime);
  const secondToken = createExecutorRuntimeStartupToken(runtime);

  assert.equal(isExecutorRuntimeStartupTokenCurrent(runtime, firstToken), false);
  assert.equal(isExecutorRuntimeStartupTokenCurrent(runtime, secondToken), true);

  invalidateExecutorRuntimeStartup(runtime);

  assert.equal(isExecutorRuntimeStartupTokenCurrent(runtime, secondToken), false);
});

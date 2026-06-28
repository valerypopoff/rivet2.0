import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachExecutorSidecarConsumer,
  createExecutorSidecarRuntimeState,
  detachExecutorSidecarConsumer,
  forceStopExecutorSidecarForPageUnload,
  restartExecutorSidecar,
  startExecutorSidecar,
  stopExecutorSidecar,
} from './executorSidecarRuntime';

test('sidecar runtime starts once and tracks consumer lifecycle', async () => {
  let spawnCount = 0;
  let killCount = 0;
  let stdoutDataHandler: ((data: string) => void) | undefined;
  const runtime = createExecutorSidecarRuntimeState();

  attachExecutorSidecarConsumer(runtime);

  const startPromise = startExecutorSidecar(
    runtime,
    async () =>
      ({
        stdout: {
          on: (_event: string, handler: (data: string) => void) => {
            stdoutDataHandler = handler;
          },
        },
        stderr: { on: () => {} },
        spawn: async () => {
          spawnCount += 1;
          return {
            kill: async () => {
              killCount += 1;
            },
          } as any;
        },
      }) as any,
    { readyTimeoutMs: 1000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  stdoutDataHandler?.('Rivet app executor websocket listening on 127.0.0.1:21889');
  await startPromise;

  assert.equal(runtime.started, true);
  assert.equal(spawnCount, 1);

  detachExecutorSidecarConsumer(runtime);
  await stopExecutorSidecar(runtime);

  assert.equal(runtime.started, false);
  assert.equal(killCount, 1);
});

test('sidecar runtime reuses pending startup across quick detach and reattach', async () => {
  let spawnCount = 0;
  let stdoutDataHandler: ((data: string) => void) | undefined;
  const runtime = createExecutorSidecarRuntimeState();

  attachExecutorSidecarConsumer(runtime);

  const firstStart = startExecutorSidecar(
    runtime,
    async () =>
      ({
        stdout: {
          on: (_event: string, handler: (data: string) => void) => {
            stdoutDataHandler = handler;
          },
        },
        stderr: { on: () => {} },
        spawn: async () => {
          spawnCount += 1;
          return {
            kill: async () => {},
          } as any;
        },
      }) as any,
    { readyTimeoutMs: 1000 },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));

  detachExecutorSidecarConsumer(runtime);
  const stop = stopExecutorSidecar(runtime);

  attachExecutorSidecarConsumer(runtime);
  const secondStart = startExecutorSidecar(runtime);

  stdoutDataHandler?.('Rivet app executor websocket listening on 127.0.0.1:21889');
  await Promise.all([firstStart, stop, secondStart]);

  assert.equal(spawnCount, 1);
  assert.equal(runtime.started, true);

  detachExecutorSidecarConsumer(runtime);
  await stopExecutorSidecar(runtime);
});

test('sidecar stderr is telemetry and does not report renderer errors', async () => {
  let stdoutDataHandler: ((data: string) => void) | undefined;
  let stderrDataHandler: ((data: string) => void) | undefined;
  const runtime = createExecutorSidecarRuntimeState();
  const originalConsoleError = console.error;
  let consoleErrorCount = 0;

  console.error = () => {
    consoleErrorCount += 1;
  };

  try {
    attachExecutorSidecarConsumer(runtime);

    const startPromise = startExecutorSidecar(
      runtime,
      async () =>
        ({
          stdout: {
            on: (_event: string, handler: (data: string) => void) => {
              stdoutDataHandler = handler;
            },
          },
          stderr: {
            on: (_event: string, handler: (data: string) => void) => {
              stderrDataHandler = handler;
            },
          },
          spawn: async () =>
            ({
              kill: async () => {},
            }) as any,
        }) as any,
      { readyTimeoutMs: 1000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    stdoutDataHandler?.('Rivet app executor websocket listening on 127.0.0.1:21889');
    await startPromise;

    stderrDataHandler?.('expected provider failure log');

    assert.equal(consoleErrorCount, 0);
  } finally {
    console.error = originalConsoleError;
    detachExecutorSidecarConsumer(runtime);
    await stopExecutorSidecar(runtime);
  }
});

test('sidecar runtime waits for ready stdout before reporting started', async () => {
  let stdoutDataHandler: ((data: string) => void) | undefined;
  const runtime = createExecutorSidecarRuntimeState();

  attachExecutorSidecarConsumer(runtime);

  try {
    const startPromise = startExecutorSidecar(
      runtime,
      async () =>
        ({
          stdout: {
            on: (_event: string, handler: (data: string) => void) => {
              stdoutDataHandler = handler;
            },
          },
          stderr: { on: () => {} },
          spawn: async () =>
            ({
              kill: async () => {},
            }) as any,
        }) as any,
      { readyTimeoutMs: 1000 },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(runtime.started, false);

    stdoutDataHandler?.('Rivet app executor websocket listening on 127.0.0.1:21889');
    await startPromise;

    assert.equal(runtime.started, true);
  } finally {
    detachExecutorSidecarConsumer(runtime);
    await stopExecutorSidecar(runtime);
  }
});

test('sidecar runtime treats missing ready stdout as a startup failure', async () => {
  let killCount = 0;
  const runtime = createExecutorSidecarRuntimeState();
  const originalConsoleError = console.error;

  console.error = () => {};

  try {
    attachExecutorSidecarConsumer(runtime);

    await startExecutorSidecar(
      runtime,
      async () =>
        ({
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          spawn: async () =>
            ({
              kill: async () => {
                killCount += 1;
              },
            }) as any,
        }) as any,
      { readyTimeoutMs: 1 },
    );

    assert.equal(runtime.started, false);
    assert.equal(runtime.process, null);
    assert.equal(runtime.startPromise, null);
    assert.equal(killCount, 1);
  } finally {
    console.error = originalConsoleError;
    detachExecutorSidecarConsumer(runtime);
    await stopExecutorSidecar(runtime);
  }
});

test('sidecar runtime force-stops and detaches stream listeners during page unload', async () => {
  let killCount = 0;
  const stdoutHandlers = new Set<(data: string) => void>();
  const stderrHandlers = new Set<(data: string) => void>();
  const runtime = createExecutorSidecarRuntimeState();

  attachExecutorSidecarConsumer(runtime);

  const startPromise = startExecutorSidecar(
    runtime,
    async () =>
      ({
        stdout: {
          on: (_event: string, handler: (data: string) => void) => {
            stdoutHandlers.add(handler);
          },
          off: (_event: string, handler: (data: string) => void) => {
            stdoutHandlers.delete(handler);
          },
        },
        stderr: {
          on: (_event: string, handler: (data: string) => void) => {
            stderrHandlers.add(handler);
          },
          off: (_event: string, handler: (data: string) => void) => {
            stderrHandlers.delete(handler);
          },
        },
        spawn: async () =>
          ({
            kill: async () => {
              killCount += 1;
            },
          }) as any,
      }) as any,
    { readyTimeoutMs: 1000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  stdoutHandlers.forEach((handler) => handler('Rivet app executor websocket listening on 127.0.0.1:21889'));
  await startPromise;

  assert.equal(stdoutHandlers.size, 1);
  assert.equal(stderrHandlers.size, 1);

  forceStopExecutorSidecarForPageUnload(runtime);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(runtime.consumerCount, 0);
  assert.equal(runtime.started, false);
  assert.equal(runtime.process, null);
  assert.equal(stdoutHandlers.size, 0);
  assert.equal(stderrHandlers.size, 0);
  assert.equal(killCount, 1);
});

test('sidecar runtime does not report started after page unload interrupts startup', async () => {
  let killCount = 0;
  let stdoutDataHandler: ((data: string) => void) | undefined;
  const runtime = createExecutorSidecarRuntimeState();

  attachExecutorSidecarConsumer(runtime);

  const startPromise = startExecutorSidecar(
    runtime,
    async () =>
      ({
        stdout: {
          on: (_event: string, handler: (data: string) => void) => {
            stdoutDataHandler = handler;
          },
          off: () => {},
        },
        stderr: { on: () => {}, off: () => {} },
        spawn: async () =>
          ({
            kill: async () => {
              killCount += 1;
            },
          }) as any,
      }) as any,
    { readyTimeoutMs: 1000 },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  forceStopExecutorSidecarForPageUnload(runtime);
  stdoutDataHandler?.('Rivet app executor websocket listening on 127.0.0.1:21889');
  await startPromise;

  assert.equal(runtime.consumerCount, 0);
  assert.equal(runtime.started, false);
  assert.equal(runtime.process, null);
  assert.equal(killCount, 1);
});

test('cancelled sidecar startup does not clear or stop a newer startup', async () => {
  let commandCount = 0;
  let killCount = 0;
  let firstStdoutDataHandler: ((data: string) => void) | undefined;
  let secondStdoutDataHandler: ((data: string) => void) | undefined;
  const runtime = createExecutorSidecarRuntimeState();

  const createSidecarCommand = async () => {
    commandCount += 1;
    const commandNumber = commandCount;

    return {
      stdout: {
        on: (_event: string, handler: (data: string) => void) => {
          if (commandNumber === 1) {
            firstStdoutDataHandler = handler;
          } else {
            secondStdoutDataHandler = handler;
          }
        },
        off: () => {},
      },
      stderr: { on: () => {}, off: () => {} },
      spawn: async () =>
        ({
          kill: async () => {
            killCount += 1;
          },
        }) as any,
    } as any;
  };

  attachExecutorSidecarConsumer(runtime);
  const firstStart = startExecutorSidecar(runtime, createSidecarCommand, { readyTimeoutMs: 1000 });

  await new Promise((resolve) => setTimeout(resolve, 0));
  forceStopExecutorSidecarForPageUnload(runtime);

  attachExecutorSidecarConsumer(runtime);
  const secondStart = startExecutorSidecar(runtime, createSidecarCommand, { readyTimeoutMs: 1000 });

  await new Promise((resolve) => setTimeout(resolve, 0));
  firstStdoutDataHandler?.('Rivet app executor websocket listening on 127.0.0.1:21889');
  await firstStart;

  assert.equal(runtime.started, false);
  assert.notEqual(runtime.startPromise, null);

  secondStdoutDataHandler?.('Rivet app executor websocket listening on 127.0.0.1:21889');
  await secondStart;

  assert.equal(commandCount, 2);
  assert.equal(runtime.started, true);
  assert.equal(killCount, 1);

  detachExecutorSidecarConsumer(runtime);
  await stopExecutorSidecar(runtime);
});

test('sidecar runtime restart preserves consumers and starts a fresh process', async () => {
  let spawnCount = 0;
  let killCount = 0;
  let firstStdoutDataHandler: ((data: string) => void) | undefined;
  let secondStdoutDataHandler: ((data: string) => void) | undefined;
  const runtime = createExecutorSidecarRuntimeState();

  const createSidecarCommand = async () => {
    spawnCount += 1;
    const spawnNumber = spawnCount;

    return {
      stdout: {
        on: (_event: string, handler: (data: string) => void) => {
          if (spawnNumber === 1) {
            firstStdoutDataHandler = handler;
          } else {
            secondStdoutDataHandler = handler;
          }
        },
        off: () => {},
      },
      stderr: { on: () => {}, off: () => {} },
      spawn: async () =>
        ({
          kill: async () => {
            killCount += 1;
          },
        }) as any,
    } as any;
  };

  attachExecutorSidecarConsumer(runtime);
  const start = startExecutorSidecar(runtime, createSidecarCommand, { readyTimeoutMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  firstStdoutDataHandler?.('Rivet app executor websocket listening on 127.0.0.1:21889');
  await start;

  const restart = restartExecutorSidecar(runtime, createSidecarCommand, { readyTimeoutMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  secondStdoutDataHandler?.('Rivet app executor websocket listening on 127.0.0.1:21889');
  await restart;

  assert.equal(runtime.consumerCount, 1);
  assert.equal(runtime.started, true);
  assert.equal(spawnCount, 2);
  assert.equal(killCount, 1);

  detachExecutorSidecarConsumer(runtime);
  await stopExecutorSidecar(runtime);
});

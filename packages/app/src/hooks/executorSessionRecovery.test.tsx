import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Provider, createStore } from 'jotai';
import {
  ExecutionRecorder,
  ExecutorReliableOutbox,
  InMemoryDatasetProvider,
  CodeNodeImpl,
} from '@valerypopoff/rivet2-core';
import { ProvidersProvider, type LocalExecutionRecordingPersistenceProvider } from '../providers/ProvidersContext.js';
import { ExecutorSessionProvider, useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { projectState, projectsState, loadedProjectState } from '../state/savedGraphs.js';
import { graphState } from '../state/graph.js';
import { projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { recordExecutionsState } from '../state/settings.js';
import { configureHybridStorageBackend, MemoryAsyncStorage } from '../state/storage.js';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject.js';
import { useRemoteExecutor } from './useRemoteExecutor.js';
import { FakeWebSocket } from './executorSessionTestUtils.js';

async function fixture(t: TestContext, protocol: 1 | 2, recordingEnabled = false) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://rivet.test/' });
  const values = {
    React,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    window: dom.window,
    WebSocket: FakeWebSocket,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = Object.keys(values).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const previousStorage = configureHybridStorageBackend(new MemoryAsyncStorage());
  FakeWebSocket.instances = [];
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      configureHybridStorageBackend(previousStorage);
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  });
  const store = createStore();
  const project = createBlankProjectWithDefaultGraph();
  const id = project.metadata.id;
  const graph = project.graphs[project.metadata.mainGraphId!]!;
  const node = CodeNodeImpl.create();
  graph.nodes.push(node);
  store.set(projectState, project);
  store.set(graphState, graph);
  store.set(loadedProjectState, { loaded: true, path: '/diagnostic.rivet-project' });
  store.set(projectsState, {
    openedProjects: { [id]: { projectId: id, title: 'Diagnostic', fsPath: '/diagnostic.rivet-project' } },
    openedProjectsSortedIds: [id],
  });
  store.set(recordExecutionsState, recordingEnabled);
  const recordings: Array<Parameters<LocalExecutionRecordingPersistenceProvider['persist']>[0]> = [];
  const unavailable: string[] = [];
  const persistence: LocalExecutionRecordingPersistenceProvider = {
    getCapability: async () => true,
    persist: async (value) => {
      recordings.push(value);
    },
    markUnavailable: async (id) => {
      unavailable.push(id);
    },
  };
  let executor!: ReturnType<typeof useRemoteExecutor>;
  let runtime!: ReturnType<typeof useExecutorSessionRuntime>;
  function Harness() {
    executor = useRemoteExecutor();
    runtime = useExecutorSessionRuntime();
    return null;
  }
  await act(async () =>
    root.render(
      <Provider store={store}>
        <ProvidersProvider
          providers={{
            datasets: new InMemoryDatasetProvider([]),
            environment: { getEnvVar: async () => undefined },
            localExecutionRecordingPersistence: persistence,
          }}
        >
          <ExecutorSessionProvider>
            <Harness />
          </ExecutorSessionProvider>
        </ProvidersProvider>
      </Provider>,
    ),
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ready = () => {
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.emitMessage({ message: 'executor-session', data: { protocol, capability: 'a'.repeat(43) } });
    socket.emitMessage({ message: 'executor-session-ready', data: { protocol } });
    socket.emitMessage({ message: 'graph-upload-allowed', data: {}, ...(protocol === 1 ? { rivetSequence: 1 } : {}) });
    return socket;
  };
  let socket!: FakeWebSocket;
  await act(async () => {
    await runtime.connectInternalHostedExecutor('wss://rivet.test/ws/executor/owner/diagnostic');
    socket = ready();
  });
  let result!: ReturnType<typeof executor.tryRunGraph>;
  let failure: unknown;
  const patches: unknown[] = [];
  await act(async () => {
    result = executor.tryRunGraph({
      waitForResults: true,
      returnWhenGraphOutputsReady: true,
      throwOnError: true,
      webAppStorage: {},
      onWebAppStoragePatch: (patch) => patches.push(patch),
    });
    void result.catch((error) => {
      failure = error;
    });
    await new Promise((resolve) => setImmediate(resolve));
  });
  const request = socket.sent
    .filter((raw) => raw.startsWith('{'))
    .map((raw) => JSON.parse(raw))
    .find((frame) => frame.type === 'run');
  assert.ok(request, String(failure));
  const requestId = request.data.requestId;
  const execution = { projectId: id, graphId: graph.metadata!.id, graphRunId: 'graph', rootRunId: 'root' };
  await act(async () => {
    socket.emitMessage({
      message: 'start',
      requestId,
      ...(protocol === 1 ? { rivetSequence: 2 } : {}),
      data: { execution, project, startGraph: graph, inputs: {}, contextValues: {} },
    });
    socket.emitMessage({
      message: 'nodeStart',
      requestId,
      rivetSequence: protocol === 1 ? 3 : 1,
      data: { execution, node, processId: 'process', inputs: {} },
    });
  });
  return {
    get runtime() {
      return runtime;
    },
    get executor() {
      return executor;
    },
    recordings,
    unavailable,
    store,
    project,
    id,
    graph,
    node,
    socket,
    ready,
    result,
    requestId,
    execution,
    patches,
  };
}

for (const earlyAnswer of [false, true]) {
  test(`hosted preview records exhaustion once after terminal failure (early answer=${earlyAnswer})`, async (t) => {
    const f = await fixture(t, 1, true);
    const outputs = { answer: { type: 'string', value: 'Already delivered' } };
    if (earlyAnswer) {
      await act(async () => {
        f.socket.emitMessage({
          message: 'graphOutputsReady',
          requestId: f.requestId,
          rivetSequence: 4,
          data: { execution: f.execution, graph: f.graph, outputs },
        });
        assert.deepEqual(await f.result, outputs);
      });
      assert.equal(f.recordings.length, 0, 'an early response is not a complete recording');
    }
    await act(async () => {
      f.socket.emitMessage({
        message: 'nodeError',
        requestId: f.requestId,
        rivetSequence: earlyAnswer ? 5 : 4,
        data: {
          execution: f.execution,
          node: f.node,
          processId: 'process',
          error: 'LLM Profile fallback chain exhausted.',
        },
      });
      f.socket.emitMessage({
        message: 'error',
        requestId: f.requestId,
        rivetSequence: earlyAnswer ? 6 : 5,
        data: { error: 'LLM Profile fallback chain exhausted.' },
      });
      await new Promise((resolve) => setImmediate(resolve));
    });
    if (!earlyAnswer) await assert.rejects(f.result, /fallback chain exhausted/);
    else assert.deepEqual(await f.result, outputs);
    assert.equal(f.recordings.length, 1);
    assert.equal(f.recordings[0]!.status, 'failed');
    assert.equal(f.recordings[0]!.projectId, f.id);
    assert.match(
      JSON.stringify(ExecutionRecorder.deserializeFromString(f.recordings[0]!.recordingSerialized).events),
      /fallback chain exhausted/,
    );
    assert.deepEqual(f.unavailable, []);
  });
}

test('overlapping hosted previews retain separate recordings when terminal events arrive out of order', async (t) => {
  const f = await fixture(t, 1, true);
  let second!: ReturnType<typeof f.executor.tryRunGraph>;
  await act(async () => {
    second = f.executor.tryRunGraph({ waitForResults: true, throwOnError: true, webAppStorage: {} });
    void second.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
  });
  const runs = f.socket.sent
    .filter((raw) => raw.startsWith('{'))
    .map((raw) => JSON.parse(raw))
    .filter((frame) => frame.type === 'run');
  assert.equal(runs.length, 2);
  const secondId = runs[1].data.requestId;
  const secondExecution = { ...f.execution, rootRunId: 'second-root', graphRunId: 'second-graph' };
  await act(async () => {
    f.socket.emitMessage({
      message: 'start',
      requestId: secondId,
      rivetSequence: 4,
      data: { execution: secondExecution, project: f.project, startGraph: f.graph, inputs: {}, contextValues: {} },
    });
    f.socket.emitMessage({
      message: 'error',
      requestId: secondId,
      rivetSequence: 5,
      data: { error: 'second failure' },
    });
    f.socket.emitMessage({
      message: 'error',
      requestId: f.requestId,
      rivetSequence: 6,
      data: { error: 'first failure' },
    });
    await new Promise((resolve) => setImmediate(resolve));
  });
  await assert.rejects(second, /second failure/);
  await assert.rejects(f.result, /first failure/);
  assert.equal(f.recordings.length, 2);
  assert.equal(new Set(f.recordings.map((run) => run.executionIdentity.correlationId)).size, 2);
  assert.deepEqual(f.recordings.map((run) => run.errorMessage).sort(), ['first failure', 'second failure']);
});

test('recovery expiry rejects preview once, marks the outcome unknown and clears spinning node displays', async (t) => {
  const f = await fixture(t, 1);
  assert.equal(f.store.get(projectExecutionSnapshotsState)[f.id]!.graphRunning, true);
  await act(async () => {
    f.socket.emitClose();
    t.mock.timers.tick(60_001);
    await new Promise((resolve) => setImmediate(resolve));
  });
  await assert.rejects(f.result, /outcome is unknown.*not resubmitted/);
  const snapshot = f.store.get(projectExecutionSnapshotsState)[f.id]!;
  assert.equal(snapshot.graphRunning, false);
  assert.equal(snapshot.lastRunDataByNode[f.node.id]![0]!.data.status?.type, 'interrupted');
  assert.equal(snapshot.runActivityJournal.rootsById.root!.status, 'unavailable');
});

test('v2 preview recovers a missing diagnostic interval and applies a chunked result and storage patch only once', async (t) => {
  const f = await fixture(t, 2, true);
  await act(async () => {
    f.socket.emitClose();
    t.mock.timers.tick(200);
  });
  const outbox = new ExecutorReliableOutbox();
  const output = { answer: { type: 'string' as const, value: 'λ😀'.repeat(100000) } };
  outbox.add(
    JSON.stringify({
      message: 'webAppStoragePatch',
      requestId: f.requestId,
      data: { storagePatch: { saved: 'once' } },
    }),
  );
  outbox.add(
    JSON.stringify({
      message: 'graphOutputsReady',
      requestId: f.requestId,
      data: { execution: f.execution, graph: f.graph, outputs: output },
    }),
  );
  let socket!: FakeWebSocket;
  await act(async () => {
    socket = f.ready();
    socket.emitMessage({
      message: 'executor-diagnostics-gap',
      data: { after: 1, through: 100, requestIds: [f.requestId] },
    });
    for (let chunk = outbox.next(); chunk; chunk = outbox.next())
      socket.emitMessage({ message: 'executor-reliable', data: chunk });
    assert.deepEqual(await f.result, output);
  });
  await act(async () => {
    outbox.replay();
    for (let chunk = outbox.next(); chunk; chunk = outbox.next())
      socket.emitMessage({ message: 'executor-reliable', data: chunk });
  });
  assert.deepEqual(f.patches, [{ saved: 'once' }]);
  assert.equal(
    FakeWebSocket.instances.flatMap((connection) => connection.sent).filter((raw) => raw.includes('"type":"run"'))
      .length,
    1,
  );
  assert.equal(f.runtime.hasIncompleteDiagnostics?.(f.requestId), true);
  assert.equal(f.store.get(projectExecutionSnapshotsState)[f.id]!.runActivityJournal.rootsById.root!.isPartial, true);
  await act(async () => f.runtime.disconnect());
  assert.deepEqual(await f.result, output, 'losing the background tail does not revoke the returned response');
  assert.match(
    f.store.get(projectExecutionSnapshotsState)[f.id]!.runActivityJournal.rootsById.root!.terminalErrorSummary!,
    /response was returned/,
  );
  assert.equal(f.recordings.length, 0, 'missing history must not become a complete replay');
  assert.equal(f.unavailable.length, 1);
});

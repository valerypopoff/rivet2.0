import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Provider, createStore } from 'jotai';
import { ExecutionRecorder, InMemoryDatasetProvider, TextNodeImpl } from '@valerypopoff/rivet2-core';
import { ProvidersProvider, type LocalExecutionRecordingPersistenceProvider } from '../providers/ProvidersContext.js';
import { ExecutorSessionProvider, useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { projectState, projectsState, loadedProjectState } from '../state/savedGraphs.js';
import { graphState } from '../state/graph.js';
import { projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { renewProjectBindingState } from '../state/projectBindings.js';
import { recordExecutionsState } from '../state/settings.js';
import { configureHybridStorageBackend, MemoryAsyncStorage } from '../state/storage.js';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject.js';
import { useRemoteExecutor } from './useRemoteExecutor.js';
import { FakeWebSocket } from './executorSessionTestUtils.js';

test(
  'replaced Node tab keeps request callbacks and early-output cancellation, without stale canvas writes',
  { timeout: 5000 },
  async (t) => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'https://rivet.test/' });
    const keys = [
      'React',
      'document',
      'localStorage',
      'navigator',
      'window',
      'WebSocket',
      'IS_REACT_ACT_ENVIRONMENT',
    ] as const;
    const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    const values = [
      React,
      dom.window.document,
      dom.window.localStorage,
      dom.window.navigator,
      dom.window,
      FakeWebSocket,
      true,
    ];
    keys.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: values[index] }));
    const previousStorage = configureHybridStorageBackend(new MemoryAsyncStorage());
    FakeWebSocket.instances = [];
    const root = createRoot(dom.window.document.getElementById('root')!);
    t.after(async () => {
      try {
        await act(async () => root.unmount());
      } finally {
        configureHybridStorageBackend(previousStorage);
        keys.forEach((key, index) => {
          const descriptor = descriptors[index];
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        });
        dom.window.close();
      }
    });
    const store = createStore();
    const project = createBlankProjectWithDefaultGraph();
    const id = project.metadata.id;
    const graph = project.graphs[project.metadata.mainGraphId!]!;
    const progressNode = TextNodeImpl.create();
    graph.nodes.push(progressNode);
    store.set(projectState, project);
    store.set(graphState, graph);
    store.set(loadedProjectState, { loaded: true, path: '/a.rivet-project' });
    store.set(projectsState, {
      openedProjects: { [id]: { projectId: id, title: 'A', fsPath: '/a.rivet-project' } },
      openedProjectsSortedIds: [id],
    });
    store.set(recordExecutionsState, true);
    const recordings: Array<Parameters<LocalExecutionRecordingPersistenceProvider['persist']>[0]> = [];
    const unavailable: string[] = [];
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
              localExecutionRecordingPersistence: {
                getCapability: async () => true,
                persist: async (recording) => {
                  recordings.push(recording);
                },
                markUnavailable: async (id) => {
                  unavailable.push(id);
                },
              },
            }}
          >
            <ExecutorSessionProvider>
              <Harness />
            </ExecutorSessionProvider>
          </ProvidersProvider>
        </Provider>,
      ),
    );
    await act(async () => {
      await runtime.connectInternalHostedExecutor('ws://fixture/internal');
      FakeWebSocket.instances.at(-1)!.open();
    });
    const socket = FakeWebSocket.instances.at(-1)!;
    const controller = new AbortController();
    const progress: unknown[] = [],
      patches: unknown[] = [],
      traces: unknown[] = [];
    let result!: ReturnType<typeof executor.tryRunGraph>;
    let failure: unknown;
    await act(async () => {
      result = executor.tryRunGraph({
        waitForResults: true,
        returnWhenGraphOutputsReady: true,
        throwOnError: true,
        abortSignal: controller.signal,
        onProgress: (value) => {
          progress.push(value);
        },
        onWebAppStoragePatch: (value) => {
          patches.push(value);
        },
        onResponseTrace: (value) => {
          traces.push(value);
        },
      });
      void result.catch((error) => {
        failure = error;
      });
      await new Promise((resolve) => setImmediate(resolve));
    });
    const request = socket.sent.map((raw) => JSON.parse(raw)).find((frame) => frame.type === 'run');
    assert.ok(request, `the actual hook admitted exactly one Node command: ${String(failure)}`);
    assert.equal(socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === 'run').length, 1);
    const requestId = request.data.requestId;
    await act(async () => store.set(renewProjectBindingState, id));
    const retained = store.get(projectExecutionSnapshotsState)[id];
    const execution = { projectId: id, graphId: graph.metadata!.id, graphRunId: 'graph', rootRunId: 'root' };
    const outputs = { output: { type: 'string', value: 'accepted result' } };
    await act(async () => {
      socket.emitMessage({
        message: 'start',
        requestId,
        data: { execution, project, startGraph: graph, inputs: {}, contextValues: {} },
      });
      socket.emitMessage({
        message: 'progress',
        requestId,
        data: { execution, node: progressNode, processId: 'progress', progress: { completed: 1, total: 2 } },
      });
      socket.emitMessage({
        message: 'webAppStoragePatch',
        requestId,
        data: { storagePatch: { key: 'accepted write' } },
      });
      socket.emitMessage({ message: 'graphOutputsReady', requestId, data: { execution, graph, outputs } });
      assert.deepEqual(await result, outputs);
    });
    assert.equal(progress.length, 1);
    assert.deepEqual(patches, [{ key: 'accepted write' }]);
    assert.equal(traces.length, 1);
    assert.equal(recordings.length, 0, 'Early outputs must not finalize a recording before execution settles');
    assert.equal(store.get(projectExecutionSnapshotsState)[id], retained);
    await act(async () => controller.abort());
    const aborts = socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === 'abort');
    assert.equal(aborts.length, 1, 'early outputs retain the accepted tail cancellation owner');
    assert.equal(aborts[0].data.requestId, requestId);
    await act(async () => socket.emitMessage({ message: 'error', requestId, data: { execution, error: 'aborted' } }));
    assert.equal(runtime.getActiveGraphRunRequestId(), null);
    assert.equal(store.get(projectExecutionSnapshotsState)[id], retained);
    assert.equal(traces.length, 1, 'late terminal delivery cannot duplicate an early response trace');
    assert.equal(recordings.length, 1, 'The accepted run retains artifact ownership after tab replacement');
    assert.equal(recordings[0]!.projectId, id);
    assert.equal(recordings[0]!.projectPath, '/a.rivet-project');
    assert.equal(recordings[0]!.status, 'failed');
    assert.deepEqual(unavailable, []);
    assert.ok(
      ExecutionRecorder.deserializeFromString(recordings[0]!.recordingSerialized).events.some(
        (event) => event.type === 'error',
      ),
    );
  },
);

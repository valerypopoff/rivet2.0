import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { TextNodeImpl, type DataValue, type GraphId, type ProcessEventMessageMap } from '@valerypopoff/rivet2-core';
import { ProvidersProvider, type DataRefStore } from '../providers/ProvidersContext.js';
import { projectState, projectsState } from '../state/savedGraphs.js';
import { graphState } from '../state/graph.js';
import { graphNavigationStackState } from '../state/graphBuilder.js';
import { createRootGraphViewContext } from '../domain/graphEditing/navigationActions.js';
import { createEmptyProjectExecutionSnapshot, projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject.js';
import { useCurrentExecution } from './useCurrentExecution.js';
import { createProcessEventDispatcher } from './remoteExecutorHelpers.js';
import { routeProjectExecutionDisplay } from './projectExecutionSnapshotRouting.js';

test('interactive and inactive full lifecycle transcripts have identical snapshot/ref effects under equivalent policy', async (t) => {
  t.mock.method(Date, 'now', () => 123456);
  t.mock.method(console, 'error', () => {});
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://rivet.test/' });
  const globals = {
    React,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true });
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  });
  const active = createStore(),
    inactive = createStore();
  const project = createBlankProjectWithDefaultGraph(),
    id = project.metadata.id;
  const graph = project.graphs[project.metadata.mainGraphId!]!,
    node = TextNodeImpl.create();
  graph.nodes.push(node);
  const refs = [new Map<string, DataValue>(), new Map<string, DataValue>()];
  const deletes: string[][] = [[], []];
  const stores = refs.map(
    (values, index): DataRefStore => ({
      get: (key) => values.get(key),
      set: (key, value) => {
        values.set(key, value);
      },
      delete: (key) => {
        deletes[index]!.push(key);
        values.delete(key);
      },
    }),
  );
  active.set(projectState, project);
  active.set(graphState, graph);
  active.set(graphNavigationStackState, { stack: [createRootGraphViewContext(graph.metadata!.id!)], index: 0 });
  for (const store of [active, inactive])
    store.set(projectsState, {
      openedProjects: { [id]: { projectId: id, title: 'A' } },
      openedProjectsSortedIds: [id],
    });
  let dispatcher!: ReturnType<typeof createProcessEventDispatcher>;
  function Harness() {
    dispatcher = createProcessEventDispatcher(useCurrentExecution());
    return null;
  }
  await act(async () =>
    root.render(
      <Provider store={active}>
        <ProvidersProvider providers={{ dataRefs: stores[0]! }}>
          <Harness />
        </ProvidersProvider>
      </Provider>,
    ),
  );
  const emit = async (message: keyof typeof dispatcher, data: unknown) => {
    await act(async () =>
      routeProjectExecutionDisplay({
        store: active,
        projectId: id,
        message: message as keyof ProcessEventMessageMap,
        data: data as never,
        refStore: stores[0]!,
        interactive: () => {
          (dispatcher[message] as (data: unknown) => unknown)(data);
        },
      }),
    );
    routeProjectExecutionDisplay({
      store: inactive,
      projectId: id,
      message: message as keyof ProcessEventMessageMap,
      data: data as never,
      refStore: stores[1]!,
    });
    assert.deepEqual(
      active.get(projectExecutionSnapshotsState)[id],
      inactive.get(projectExecutionSnapshotsState)[id],
      message,
    );
    assert.deepEqual(refs[0], refs[1], `${message} refs`);
    assert.deepEqual(deletes[0], deletes[1], `${message} ref deletion effects`);
  };
  for (const outcome of ['success', 'failure', 'abort'] as const) {
    for (const store of [active, inactive])
      store.set(projectExecutionSnapshotsState, { [id]: createEmptyProjectExecutionSnapshot() });
    refs.forEach((values) => values.clear());
    deletes.forEach((values) => {
      values.length = 0;
    });
    const execution = {
      projectId: id,
      graphId: graph.metadata!.id as GraphId,
      graphRunId: outcome,
      rootRunId: `root-${outcome}`,
    };
    const event = { execution, node, processId: `process-${outcome}` };
    const value = { type: 'string', value: 'payload'.repeat(20000) };
    await emit('start', { execution, project, startGraph: graph, inputs: {}, contextValues: {} });
    await emit('graphStart', { execution, graph });
    await emit('nodeStart', { ...event, inputs: { input: value } });
    await emit('partialOutput', { ...event, index: 0, outputs: { output: value } });
    await emit('userInput', { ...event, inputStrings: ['Question?'] });
    await emit('pause', { execution });
    await emit('resume', { execution });
    if (outcome === 'failure') {
      await emit('nodeError', { ...event, error: 'failed', durationMs: 1 });
      await emit('graphError', { execution, graph, error: 'failed' });
      await emit('error', { execution, error: 'failed' });
    } else {
      await emit('nodeFinish', { ...event, outputs: { output: value }, durationMs: 1 });
      if (outcome === 'abort') {
        await emit('graphAbort', { execution, graph });
        await emit('abort', { execution, successful: true });
      }
      await emit('graphFinish', { execution, graph, outputs: {} });
      await emit('done', { execution, results: {} });
    }
    const count = refs[0]!.size;
    await emit('partialOutput', {
      ...event,
      index: 0,
      outputs: { output: { type: 'string', value: 'stale'.repeat(20000) } },
    });
    assert.equal(refs[0]!.size, count, 'late partials allocate no payload refs');
    await emit('nodeOutputsCleared', event);
    assert.equal(refs[0]!.size, 0);
  }
});

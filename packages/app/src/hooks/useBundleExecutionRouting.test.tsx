import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { Provider, createStore } from 'jotai';
import {
  ExecutionRecorder,
  TextNodeImpl,
  getSubgraphProjectKey,
  type GraphExecutionMetadata,
  type GraphRunId,
  type DataValue,
  type NodeId,
  type PortId,
  type ProcessId,
  type ProjectId,
  type RootRunId,
} from '@valerypopoff/rivet2-core';
import { ProvidersProvider } from '../providers/ProvidersContext.js';
import { projectState, projectsState } from '../state/savedGraphs.js';
import {
  createEmptyProjectExecutionSnapshot,
  graphRunningState,
  projectExecutionSnapshotsState,
} from '../state/dataFlow.js';
import { loadedRecordingState } from '../state/execution.js';
import { remoteObservationsState } from '../state/remoteObservation.js';
import { configureHybridStorageBackend, MemoryAsyncStorage } from '../state/storage.js';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject.js';
import { captureProjectExecutionSnapshot } from './projectExecutionSnapshotBindings.js';
import { useBundleExecutionRouting } from './useBundleExecutionRouting.js';
import { projectBindingRegistryState } from '../state/projectBindings.js';
import { getGraphRunsForView } from '../state/selectors/executionSelectors.js';
import { createRootGraphViewContext } from '../domain/graphEditing/navigationActions.js';

// Mount only the real routing hook. Workspace IO/activation integration remains
// in useLoadProject.test.tsx and the real hosted/desktop Playwright scenarios.
async function mountRouting(t: TestContext, ingressCount = 1) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://rivet.test/' });
  const keys = ['React', 'document', 'localStorage', 'navigator', 'window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const values = [React, dom.window.document, dom.window.localStorage, dom.window.navigator, dom.window, true];
  keys.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: values[index] }));
  const previousStorage = configureHybridStorageBackend(new MemoryAsyncStorage());
  let unmount = () => {
    /* No root exists until setup succeeds. */
  };
  // Register before setup/render: even a failed mount or unmount must restore
  // the shared process globals/storage before another case uses them.
  t.after(async () => {
    try {
      await act(async () => unmount());
    } finally {
      configureHybridStorageBackend(previousStorage);
      keys.forEach((key, index) => {
        const descriptor = previous[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      });
      dom.window.close();
    }
  });
  const store = createStore();
  const [a, b, c] = [
    createBlankProjectWithDefaultGraph(),
    createBlankProjectWithDefaultGraph(),
    createBlankProjectWithDefaultGraph(),
  ] as const;
  const node = TextNodeImpl.create();
  node.id = 'shared-node' as NodeId;
  const projects = new Map([a, b, c].map((project) => [project.metadata.id, project]));
  const graph = (id: ProjectId) => {
    const project = projects.get(id)!;
    return project.graphs[project.metadata.mainGraphId!]!;
  };
  // Every project really declares the cloned node ID used by its event stream.
  // Otherwise a definition check could make isolation assertions pass trivially.
  for (const project of projects.values()) graph(project.metadata.id).nodes.push(structuredClone(node));
  store.set(projectState, a);
  const opened = Object.fromEntries(
    [a, b, c].map((project) => [
      project.metadata.id,
      {
        projectId: project.metadata.id,
        title: project.metadata.title,
        fsPath: `${project.metadata.id}.rivet-project`,
        hostedBundleKey: 'server:bundle',
      },
    ]),
  );
  store.set(projectsState, {
    openedProjects: opened,
    openedProjectsSortedIds: [a.metadata.id, b.metadata.id, c.metadata.id],
  });
  let route!: ReturnType<typeof useBundleExecutionRouting>;
  const refs = new Map<string, DataValue>();
  let onRefDelete: ((key: string) => void) | undefined;
  const providers = {
    dataRefs: {
      get: (key: string) => refs.get(key),
      set: (key: string, value: DataValue) => {
        refs.set(key, value);
      },
      delete: (key: string) => {
        refs.delete(key);
        onRefDelete?.(key);
      },
    },
  };
  function Harness() {
    route = useBundleExecutionRouting();
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  unmount = () => root.unmount();
  const renderIngress = (count: number) =>
    root.render(
      <Provider store={store}>
        <ProvidersProvider providers={providers}>
          {Array.from({ length: count }, (_, index) => (
            <Harness key={index} />
          ))}
        </ProvidersProvider>
      </Provider>,
    );
  await act(async () => renderIngress(ingressCount));
  const rootExecution = (run: string): GraphExecutionMetadata => ({
    projectId: a.metadata.id,
    rootRunId: run as RootRunId,
    graphRunId: `${run}:entry` as GraphRunId,
    graphId: a.metadata.mainGraphId!,
  });
  const child = (
    run: string,
    id = b.metadata.id,
    invocation = 'child',
    parent?: GraphRunId,
  ): GraphExecutionMetadata => ({
    ...rootExecution(run),
    projectId: id,
    graphId: graph(id).metadata!.id!,
    graphRunId: `${run}:${id}:${invocation}` as GraphRunId,
    parentGraphRunId: parent ?? rootExecution(run).graphRunId,
    projectScope: getSubgraphProjectKey({ projectId: id, version: 'latest' }),
  });
  const begin = (run: string) =>
    route(a.metadata.id, 'start', {
      execution: rootExecution(run),
      project: a,
      startGraph: graph(a.metadata.id),
      inputs: {},
      contextValues: {},
    });
  const startChild = (execution: GraphExecutionMetadata, replayRecordedAt?: number) =>
    route(a.metadata.id, 'graphStart', { graph: graph(execution.projectId!), inputs: {}, execution, replayRecordedAt });
  const finishChild = (execution: GraphExecutionMetadata, value: string, replayRecordedAt?: number) =>
    route(a.metadata.id, 'nodeFinish', {
      node,
      processId: `${execution.graphRunId}:process` as ProcessId,
      outputs: { ['output' as PortId]: { type: 'string', value } },
      execution,
      replayRecordedAt,
    });
  const paint = (execution: GraphExecutionMetadata, value: string) => {
    startChild(execution);
    finishChild(execution, value);
  };
  const snapshot = (id = b.metadata.id) =>
    store.get(projectState).metadata.id === id
      ? captureProjectExecutionSnapshot(store)
      : store.get(projectExecutionSnapshotsState)[id];
  const history = (id = b.metadata.id) => snapshot(id)?.lastRunDataByNode;
  const assertOutput = (id: ProjectId, value: string, label: string) => {
    const data = history(id)?.[node.id]?.at(-1)?.data;
    assert.equal(data?.status?.type, 'ok', `${label}: the invocation finishes successfully`);
    const output = data?.outputData?.['output' as PortId];
    assert.deepEqual(output, { type: 'string', storage: 'inline', value }, label);
  };
  const end = (run: string) =>
    route(a.metadata.id, 'graphFinish', { execution: rootExecution(run), graph: graph(a.metadata.id), outputs: {} });
  return {
    a,
    b,
    c,
    store,
    route,
    opened,
    graph,
    node,
    refs,
    onRefDelete(callback: (key: string) => void) {
      onRefDelete = callback;
    },
    rootExecution,
    child,
    begin,
    startChild,
    finishChild,
    paint,
    snapshot,
    history,
    assertOutput,
    end,
    async setIngressCount(count: number) {
      await act(async () => renderIngress(count));
    },
    async dispose() {
      const stop = unmount;
      unmount = () => {};
      await act(async () => stop());
    },
    activate(id: ProjectId) {
      store.set(projectState, projects.get(id)!);
    },
  };
}

for (const active of [false, true])
  for (const kind of ['browser', 'desktop-node', 'hosted-node'] as const)
    test(`${kind}: ${active ? 'active' : 'inactive'} dependency history belongs only to the newest root`, async (t) => {
      const f = await mountRouting(t);
      if (active) f.activate(f.b.metadata.id);
      let source = {};
      const begin = (root: string) =>
        f.route(
          f.a.metadata.id,
          'start',
          {
            execution: f.rootExecution(root),
            project: f.a,
            startGraph: f.graph(f.a.metadata.id),
            inputs: {},
            contextValues: {},
          },
          source,
          kind,
        );
      const paint = (root: string, call: string) => {
        const execution = f.child(root, f.b.metadata.id, call);
        f.route(
          f.a.metadata.id,
          'graphStart',
          { execution, graph: f.graph(f.b.metadata.id), inputs: {} },
          source,
          kind,
        );
        f.route(
          f.a.metadata.id,
          'nodeFinish',
          {
            execution,
            node: f.node,
            processId: call as ProcessId,
            outputs: { ['output' as PortId]: { type: 'string', value: root } },
          },
          source,
          kind,
        );
      };
      const runs = () =>
        getGraphRunsForView({
          currentGraphView: createRootGraphViewContext(f.b.metadata.mainGraphId!),
          graphRunHistoryByView: f.snapshot()!.graphRunHistoryByView,
        });
      begin('first');
      paint('first', 'one');
      paint('first', 'two');
      assert.equal(runs().length, 2, 'multiple calls within a root remain selectable');
      const first = f.snapshot();
      begin('first');
      assert.equal(f.snapshot(), first, 'duplicate root starts never clear the current run');
      f.route.settle(source);
      source = {};
      begin('second');
      assert.equal(runs().length, 0, 'new admission clears previously owned dependencies even before they run');
      paint('second', 'three');
      assert.deepEqual(
        runs().map((r) => r.rootRunId),
        ['second'],
      );
      assert.equal(f.history()![f.node.id]!.length, 1);
      f.route.settle(source);
      source = {};
      begin('skipped');
      assert.equal(runs().length, 0, 'a skipped dependency cannot show executions from a past root');
      assert.deepEqual(f.history(), {});
    });

test('settled bundle roots release their terminal confirmations without consuming another root', async (t) => {
  const f = await mountRouting(t);
  const pendingSibling = 'pending-sibling' as RootRunId;
  f.store.set(projectExecutionSnapshotsState, {
    [f.b.metadata.id]: { ...createEmptyProjectExecutionSnapshot(), completedRootRunIds: [pendingSibling] },
  });
  for (let index = 0; index < 12; index++) {
    const run = `completed-${index}`;
    f.begin(run);
    const execution = f.child(run);
    f.paint(execution, run);
    f.route(f.a.metadata.id, 'graphFinish', { graph: f.graph(f.b.metadata.id), execution, outputs: {} });
    assert.deepEqual(f.snapshot()!.completedRootRunIds, [pendingSibling, run], 'child finish awaits root settlement');
    if (index % 3 === 0) f.end(run);
    else {
      if (index % 3 === 2) f.route(f.a.metadata.id, 'abort', { execution: f.rootExecution(run), successful: true });
      f.route(f.a.metadata.id, 'error', { execution: f.rootExecution(run), error: new Error('source failed') });
    }
    assert.deepEqual(f.snapshot()!.completedRootRunIds, [pendingSibling], 'settlement consumes only its exact root');
    f.assertOutput(f.b.metadata.id, run, 'retained output survives metadata cleanup');
  }
});

test('overlapping roots fence stale starts and outputs but settle their retained activity without changing the current canvas', async (t) => {
  const f = await mountRouting(t);
  f.begin('old');
  f.paint(f.child('old'), 'old value');
  f.begin('current');
  f.paint(f.child('current'), 'current value');
  const current = f.snapshot()!;
  f.paint(f.child('old', f.b.metadata.id, 'late'), 'stale value');
  assert.equal(f.snapshot(), current, 'superseded frames cannot even create activity rows');
  f.end('old');
  assert.equal(f.snapshot()!.lastRunDataByNode, current.lastRunDataByNode);
  assert.equal(f.snapshot()!.graphRunHistoryByView, current.graphRunHistoryByView);
  assert.equal(f.snapshot()!.runActivityJournal.rootsById['old' as RootRunId]!.status, 'completed');
  f.assertOutput(f.b.metadata.id, 'current value', 'new root remains displayed after old settlement');
});

test('superseded roots still remember abort notices when settling their retained activity', async (t) => {
  const f = await mountRouting(t);
  for (const notice of ['abort', 'graphAbort'] as const) {
    const old = `${notice}:old`;
    const current = `${notice}:current`;
    f.begin(old);
    f.paint(f.child(old), 'old value');
    f.begin(current);
    f.paint(f.child(current), 'current value');
    const before = f.snapshot()!;
    const execution = f.rootExecution(old);
    if (notice === 'graphAbort')
      f.route(f.a.metadata.id, notice, { execution, graph: f.graph(f.a.metadata.id), successful: false });
    else f.route(f.a.metadata.id, notice, { execution, successful: false });
    assert.equal(f.snapshot(), before, 'an abort notice does not repaint or prematurely settle the old root');
    f.route(f.a.metadata.id, 'error', { execution, error: 'cancelled' });
    assert.equal(f.snapshot()!.runActivityJournal.rootsById[old as RootRunId]!.status, 'aborted');
    assert.equal(f.snapshot()!.lastRunDataByNode, before.lastRunDataByNode);
    assert.equal(f.snapshot()!.graphRunHistoryByView, before.graphRunHistoryByView);
    f.end(current);
  }
});

test('root termination fences reentrant child events before notifying settlement subscribers', async (t) => {
  const f = await mountRouting(t);
  for (const terminal of ['graphFinish', 'graphError', 'source settlement'] as const) {
    const source = {};
    const root = terminal;
    const execution = f.rootExecution(root);
    f.route(
      f.a.metadata.id,
      'start',
      {
        execution,
        project: f.a,
        startGraph: f.graph(f.a.metadata.id),
        inputs: {},
        contextValues: {},
      },
      source,
    );
    f.route(
      f.a.metadata.id,
      'graphStart',
      {
        execution: f.child(root),
        graph: f.graph(f.b.metadata.id),
        inputs: {},
      },
      source,
    );
    const before = f.snapshot(f.c.metadata.id);
    let entered = false;
    const stop = f.store.sub(projectExecutionSnapshotsState, () => {
      if (entered || f.snapshot()!.runActivityJournal.rootsById[root as RootRunId]?.status === 'running') return;
      entered = true;
      f.route(
        f.a.metadata.id,
        'graphStart',
        {
          execution: f.child(root, f.c.metadata.id),
          graph: f.graph(f.c.metadata.id),
          inputs: {},
        },
        source,
      );
    });
    try {
      if (terminal === 'source settlement') f.route.settle(source);
      else if (terminal === 'graphFinish')
        f.route(f.a.metadata.id, terminal, { execution, graph: f.graph(f.a.metadata.id), outputs: {} }, source);
      else f.route(f.a.metadata.id, terminal, { execution, graph: f.graph(f.a.metadata.id), error: 'failed' }, source);
      assert.equal(entered, true, `${terminal}: settlement must exercise the subscriber`);
      assert.equal(f.snapshot(f.c.metadata.id), before, `${terminal}: terminal callbacks cannot enroll another child`);
    } finally {
      stop();
      f.route.settle(source);
    }
  }
});

test('a delayed first dependency event cannot displace a newer root, even after its receiver conflict ends', async (t) => {
  const f = await mountRouting(t);
  f.begin('delayed');
  f.begin('newer');
  f.paint(f.child('newer'), 'newer value');
  const untouched = f.snapshot(f.c.metadata.id);
  f.paint(f.child('delayed', f.c.metadata.id), 'late first visit');
  assert.equal(f.snapshot(f.c.metadata.id), untouched, 'a superseded source cannot enroll an untouched receiver');
  f.paint(f.child('delayed'), 'must not display');
  f.store.set(projectExecutionSnapshotsState, (state) => ({
    ...state,
    [f.b.metadata.id]: { ...state[f.b.metadata.id]!, graphRunning: true },
  }));
  f.store.set(projectExecutionSnapshotsState, (state) => ({
    ...state,
    [f.b.metadata.id]: { ...state[f.b.metadata.id]!, graphRunning: false },
  }));
  const before = f.snapshot();
  f.paint(f.child('delayed', f.b.metadata.id, 'after-conflict'), 'must stay rejected');
  assert.equal(f.snapshot(), before);
});

test('new admission clears only its own prior participants, not another source or independently run project', async (t) => {
  const f = await mountRouting(t);
  f.begin('a-old');
  f.paint(f.child('a-old'), 'from A');
  const other = { ...f.rootExecution('c-root'), projectId: f.c.metadata.id, graphId: f.c.metadata.mainGraphId! };
  f.route(f.c.metadata.id, 'start', {
    execution: other,
    project: f.c,
    startGraph: f.graph(f.c.metadata.id),
    inputs: {},
    contextValues: {},
  });
  const target = { ...f.child('c-root'), parentGraphRunId: other.graphRunId };
  f.route(f.c.metadata.id, 'graphStart', { execution: target, graph: f.graph(f.b.metadata.id), inputs: {} });
  const fromC = f.snapshot();
  f.begin('a-new');
  assert.equal(f.snapshot(), fromC, 'another source keeps its current display until actually superseded');
  f.store.set(projectExecutionSnapshotsState, (state) => ({
    ...state,
    [f.b.metadata.id]: { ...state[f.b.metadata.id]!, graphRunning: true },
  }));
  f.store.set(projectExecutionSnapshotsState, (state) => ({
    ...state,
    [f.b.metadata.id]: { ...state[f.b.metadata.id]!, graphRunning: false },
  }));
  const independent = f.snapshot();
  f.begin('a-later');
  assert.equal(f.snapshot(), independent, 'completed independent ownership is not mistaken for an A participant');
});

test('a newer admission during reset wins before the older child can paint', async (t) => {
  const f = await mountRouting(t);
  f.begin('first');
  f.paint(f.child('first'), 'first');
  let entered = false;
  const stop = f.store.sub(projectExecutionSnapshotsState, () => {
    if (!entered && Object.keys(f.history() ?? {}).length === 0) {
      entered = true;
      f.begin('newest');
      f.paint(f.child('newest'), 'newest');
    }
  });
  t.after(stop);
  f.begin('middle');
  f.paint(f.child('middle'), 'obsolete');
  assert.equal(entered, true);
  f.assertOutput(f.b.metadata.id, 'newest', 'reset subscribers cannot return ownership to the older root');
});

test('reset reference cleanup cannot overwrite a receiver closed and rebound during the callback', async (t) => {
  const f = await mountRouting(t);
  f.begin('initial');
  f.paint(f.child('initial'), 'old');
  f.refs.set('old-reference', { type: 'string', value: 'old' });
  f.store.set(projectExecutionSnapshotsState, (snapshots) => ({
    ...snapshots,
    [f.b.metadata.id]: {
      ...snapshots[f.b.metadata.id]!,
      lastRunDataByNode: {
        [f.node.id]: [
          {
            processId: 'old' as ProcessId,
            data: {
              outputData: {
                ['output' as PortId]: {
                  type: 'string',
                  storage: 'ref',
                  refId: 'old-reference',
                  preview: { kind: 'summary', label: 'old' },
                },
              },
            },
          },
        ],
      },
    },
  }));
  const replacement = { ...createEmptyProjectExecutionSnapshot(), lastRecording: 'replacement-recording' };
  let cleanupCalled = false;
  f.onRefDelete(() => {
    cleanupCalled = true;
    f.store.set(projectsState, (state) => {
      const openedProjects = { ...state.openedProjects };
      delete openedProjects[f.b.metadata.id];
      return { ...state, openedProjects };
    });
    f.store.set(projectsState, (state) => ({
      ...state,
      openedProjects: { ...state.openedProjects, [f.b.metadata.id]: f.opened[f.b.metadata.id]! },
    }));
    f.store.set(projectExecutionSnapshotsState, (state) => ({ ...state, [f.b.metadata.id]: replacement }));
  });
  f.begin('during-rebind');
  f.paint(f.child('during-rebind'), 'obsolete');
  assert.equal(cleanupCalled, true, 'the reference cleanup must actually exercise the replacement callback');
  assert.equal(f.snapshot(), replacement);
});

test('legacy root graphStart admission resets dependencies once while return calls preserve source controls', async (t) => {
  const f = await mountRouting(t);
  for (const root of ['one', 'two']) {
    f.route(f.a.metadata.id, 'graphStart', {
      graph: f.graph(f.a.metadata.id),
      inputs: {},
      execution: f.rootExecution(root),
    });
    f.paint(f.child(root), root);
    f.route(f.a.metadata.id, 'graphStart', {
      graph: f.graph(f.a.metadata.id),
      inputs: {},
      execution: f.rootExecution(root),
    });
    assert.equal(Object.values(f.snapshot()!.graphRunHistoryByView).flat().length, 1);
    f.end(root);
  }
  f.begin('return');
  f.store.set(projectExecutionSnapshotsState, (state) => ({
    ...state,
    [f.a.metadata.id]: {
      ...createEmptyProjectExecutionSnapshot(),
      graphRunning: true,
      lastRecording: 'source-recording',
    },
  }));
  f.paint(f.child('return'), 'B value');
  f.paint(f.child('return', f.a.metadata.id, 'back-to-a'), 'return value');
  f.assertOutput(f.a.metadata.id, 'return value', 'return call still paints the source');
  assert.equal(f.snapshot(f.a.metadata.id)!.graphRunning, true);
  assert.equal(f.snapshot(f.a.metadata.id)!.lastRecording, 'source-recording');
});

test('workspace disposal invalidates every captured binding while preserving retained output values', async (t) => {
  const f = await mountRouting(t, 2);
  f.begin('workspace');
  f.paint(f.child('workspace'), 'retained result');
  const registry = f.store.get(projectBindingRegistryState);
  const captured = registry.capture();
  const epoch = registry.getWorkspaceToken();
  await f.setIngressCount(1);
  for (const [id, binding] of captured) assert.equal(registry.isCurrent(id, binding.token), true);
  assert.equal(registry.getWorkspaceToken(), epoch, 'one surviving ingress still owns the workspace');
  const output = f.snapshot()!.lastRunDataByNode[f.node.id]!.at(-1)!.data.outputData;
  await f.dispose();
  for (const [id, binding] of captured) assert.equal(registry.isCurrent(id, binding.token), false);
  assert.equal(f.snapshot()!.lastRunDataByNode[f.node.id]!.at(-1)!.data.outputData, output);
  const before = f.snapshot();
  f.finishChild(f.child('workspace'), 'stale after disposal');
  assert.equal(f.snapshot(), before);
});

for (const active of [false, true])
  for (const timing of ['initial', 'between events', 'before child'] as const)
    test(`${active ? 'active' : 'inactive'} receiver preserves all three independent owners (${timing})`, async (t) => {
      const f = await mountRouting(t);

      if (active) f.activate(f.b.metadata.id);
      for (const owner of ['run', 'recording', 'remote observation'] as const) {
        const run = `${timing}:${owner}`;
        const execution = f.child(run);
        const setRunning = (running: boolean) =>
          active
            ? f.store.set(graphRunningState, running)
            : f.store.set(projectExecutionSnapshotsState, (snapshots) => ({
                ...snapshots,
                [f.b.metadata.id]: {
                  ...(snapshots[f.b.metadata.id] ?? createEmptyProjectExecutionSnapshot()),
                  graphRunning: running,
                },
              }));
        if (timing !== 'initial') {
          f.begin(run);
          if (timing === 'between events') f.startChild(execution);
        }
        if (owner === 'run') setRunning(true);
        else if (owner === 'recording')
          f.store.set(loadedRecordingState, {
            path: 'recording',
            recorder: new ExecutionRecorder(),
            projectId: f.b.metadata.id,
            projectPath: f.opened[f.b.metadata.id]!.fsPath,
          });
        else
          f.store.set(remoteObservationsState, {
            [f.b.metadata.id]: [
              {
                id: run,
                sourceProjectId: f.a.metadata.id,
                sourceTitle: 'Remote source',
                rootRunId: run,
                status: 'observing',
              },
            ],
          });
        if (timing === 'initial') f.begin(run);
        setRunning(false);
        f.store.set(loadedRecordingState, null);
        f.store.set(remoteObservationsState, {});
        const before = structuredClone(f.snapshot());
        f.paint(execution, 'must not appear');
        assert.deepEqual(f.snapshot(), before, `${owner}: old root stays excluded after the conflict ends`);
        const sibling = f.child(run, f.c.metadata.id);
        assert.notEqual(execution.graphRunId, sibling.graphRunId, 'distinct project calls need distinct graph-run IDs');
        f.paint(sibling, 'unaffected sibling');
        f.assertOutput(f.c.metadata.id, 'unaffected sibling', `${owner}: exclusion is not global`);
        f.end(run);
        const fresh = `${run}:fresh`;
        f.begin(fresh);
        f.paint(f.child(fresh), 'fresh root');
        f.assertOutput(f.b.metadata.id, 'fresh root', `${owner}: a new root can observe the idle receiver`);
        f.end(fresh);
      }
    });

test('live routing guards reject independently, with a fresh positive control for every rejection', async (t) => {
  const f = await mountRouting(t);

  f.begin('existing-history');
  f.paint(f.child('existing-history'), 'retained output');
  f.end('existing-history');
  for (const guard of [
    'replay',
    'foreign desktop',
    'foreign hosted',
    'hosted detach',
    'portable nonmember',
    'missing owner',
    'missing root',
    'foreign root shape',
    'source child',
  ] as const) {
    f.store.set(projectsState, {
      openedProjects: structuredClone(f.opened),
      openedProjectsSortedIds: [f.a.metadata.id, f.b.metadata.id, f.c.metadata.id],
    });
    f.store.set(projectsState, (state) => {
      const openedProjects = Object.fromEntries(
        Object.entries(state.openedProjects).map(([id, info]) => [id, { ...info }]),
      );
      const info = openedProjects[f.b.metadata.id]!;
      if (guard === 'foreign desktop' || guard === 'portable nonmember' || guard === 'hosted detach') {
        for (const member of Object.values(openedProjects)) {
          member.hostedBundleKey = undefined;
          member.bundleManifestPath = 'same/rivet-bundle.json';
        }
        if (guard === 'foreign desktop') info.bundleManifestPath = 'other/rivet-bundle.json';
        if (guard === 'portable nonmember') info.bundleMember = false;
        if (guard === 'hosted detach') info.hostedBundleKey = null;
      }
      if (guard === 'foreign hosted') info.hostedBundleKey = 'server:other';
      return { ...state, openedProjects };
    });
    if (!['missing root', 'foreign root shape', 'source child'].includes(guard)) f.begin(guard);
    const execution = f.child(guard);
    const before = structuredClone(f.snapshot());
    if (guard === 'replay') {
      f.startChild(execution, 1);
      f.finishChild(execution, 'replay', 1);
    } else if (guard === 'missing owner') {
      // Malformed producer input is intentionally outside the typed event contract.
      f.route(f.a.metadata.id, 'graphStart', { graph: f.graph(f.b.metadata.id), inputs: {} } as never);
      f.route(f.a.metadata.id, 'nodeFinish', { node: f.node, processId: 'unknown', outputs: {} } as never);
    } else if (guard === 'foreign root shape') f.paint({ ...execution, parentGraphRunId: undefined }, guard);
    else if (guard === 'source child') {
      f.startChild({
        ...f.rootExecution(guard),
        parentGraphRunId: 'unknown' as GraphRunId,
        projectScope: getSubgraphProjectKey({ projectId: f.a.metadata.id, version: 'latest' }),
      });
      f.paint(execution, guard);
    } else f.paint(execution, guard);
    assert.deepEqual(f.snapshot(), before, `${guard}: rejection is not masked by an earlier ownership conflict`);
    f.end(guard);
    f.store.set(projectsState, {
      openedProjects: structuredClone(f.opened),
      openedProjectsSortedIds: [f.a.metadata.id, f.b.metadata.id, f.c.metadata.id],
    });
    const fresh = `${guard}:positive`;
    f.begin(fresh);
    f.paint(f.child(fresh), fresh);
    f.assertOutput(f.b.metadata.id, fresh, `${guard}: valid traffic is still admitted`);
    f.end(fresh);
  }
});

for (const change of [
  'receiver reopen',
  'receiver rebind',
  'receiver membership round-trip',
  'source reopen',
  'source membership round-trip',
])
  test(`binding fence survives ${change} between events, but a new root can display`, async (t) => {
    const f = await mountRouting(t);

    f.begin('old');
    f.paint(f.child('old'), 'before change');
    const id = change.startsWith('source') ? f.a.metadata.id : f.b.metadata.id;
    const original = f.store.get(projectsState).openedProjects[id]!;
    f.store.set(projectsState, (state) => {
      const opened = { ...state.openedProjects };
      if (change.endsWith('reopen')) delete opened[id];
      else
        opened[id] = {
          ...original,
          ...(change.endsWith('rebind')
            ? { fsPath: 'replacement.rivet-project' }
            : { hostedBundleKey: 'other:bundle' }),
        };
      return { ...state, openedProjects: opened };
    });
    f.store.set(projectsState, (state) => ({
      ...state,
      openedProjects: { ...state.openedProjects, [id]: original },
    }));
    const before = structuredClone(f.snapshot());
    f.finishChild(f.child('old'), 'late result');
    assert.deepEqual(f.snapshot(), before);
    f.end('old');
    f.begin('new');
    f.paint(f.child('new'), 'new result');
    f.assertOutput(f.b.metadata.id, 'new result', change);
  });

test('a newly opened receiver skips the in-flight root and joins the next root', async (t) => {
  const f = await mountRouting(t);

  f.store.set(projectsState, (state) => {
    const opened = { ...state.openedProjects };
    delete opened[f.b.metadata.id];
    return { ...state, openedProjects: opened };
  });
  f.begin('old');
  f.store.set(projectsState, (state) => ({
    ...state,
    openedProjects: { ...state.openedProjects, [f.b.metadata.id]: f.opened[f.b.metadata.id]! },
  }));
  const before = structuredClone(f.snapshot());
  f.paint(f.child('old'), 'partial');
  assert.deepEqual(f.snapshot(), before);
  f.end('old');
  f.begin('new');
  f.paint(f.child('new'), 'complete');
  f.assertOutput(f.b.metadata.id, 'complete', 'late-open exclusion is not permanent');
});

test('passive local canvas rebases ancestry while Run Activity keeps the real cross-project caller', async (t) => {
  const f = await mountRouting(t);
  f.begin('ancestry');
  const execution = f.child('ancestry');
  f.paint(execution, 'child value');
  const snapshot = f.snapshot();
  assert.ok(snapshot);
  const canvasRun = Object.values(snapshot.graphRunHistoryByView)
    .flat()
    .find((run) => run.graphRunId === execution.graphRunId)!;
  const activityRun = snapshot.runActivityJournal.rootsById[execution.rootRunId]!.graphRunsById[execution.graphRunId]!;
  assert.equal(canvasRun.parentGraphRunId, undefined);
  assert.equal(activityRun.parentGraphRunId, execution.parentGraphRunId);
  assert.deepEqual(activityRun.executor, execution.executor);
  assert.equal(activityRun.projectId, f.b.metadata.id);
  f.end('ancestry');
  assert.equal(f.snapshot()!.runActivityJournal.rootsById[execution.rootRunId]!.status, 'completed');
  assert.deepEqual(f.snapshot()!.runActivityJournal.activeRootRunIds, []);
});

for (const complete of [true, false])
  test(`${complete ? 'completed' : 'concurrent'} root pressure retains conflict fences without reviving superseded displays`, async (t) => {
    const f = await mountRouting(t);

    f.begin('held');
    f.paint(f.child('held'), 'blocked initial');
    f.paint(f.child('held', f.c.metadata.id), 'eligible initial');
    f.store.set(projectExecutionSnapshotsState, (state) => ({
      ...state,
      [f.b.metadata.id]: { ...state[f.b.metadata.id]!, graphRunning: true },
    }));
    f.store.set(projectExecutionSnapshotsState, (state) => ({
      ...state,
      [f.b.metadata.id]: { ...state[f.b.metadata.id]!, graphRunning: false },
    }));
    for (let i = 0; i < 40; i++) {
      f.begin(`pressure:${i}`);
      if (complete) f.end(`pressure:${i}`);
    }
    const before = structuredClone(f.snapshot());
    f.paint(f.child('held', f.b.metadata.id, 'later'), 'blocked late');
    assert.deepEqual(f.snapshot(), before, 'the conflict fence must survive pressure');
    f.paint(f.child('held', f.c.metadata.id, 'later'), 'eligible late');
    assert.deepEqual(
      f.history(f.c.metadata.id),
      {},
      'an older root cannot repopulate a display cleared by a newer admission',
    );
    f.begin('fresh-control');
    f.paint(f.child('fresh-control', f.c.metadata.id), 'fresh value');
    f.assertOutput(f.c.metadata.id, 'fresh value', 'current roots still route actual values under pressure');
  });

test('every identified root terminal fences late child starts and completions without blocking future roots', async (t) => {
  const f = await mountRouting(t);

  for (const terminal of ['graphFinish', 'graphError', 'done', 'error'] as const) {
    f.begin(terminal);
    f.paint(f.child(terminal), 'before terminal');
    const execution = f.rootExecution(terminal);
    const graph = f.graph(f.a.metadata.id);
    if (terminal === 'graphFinish') f.route(f.a.metadata.id, terminal, { execution, graph, outputs: {} });
    else if (terminal === 'graphError') f.route(f.a.metadata.id, terminal, { execution, graph, error: 'failed' });
    else if (terminal === 'done') f.route(f.a.metadata.id, terminal, { execution, results: {} });
    else f.route(f.a.metadata.id, terminal, { execution, error: 'failed' });
    const before = structuredClone(f.snapshot());
    f.paint(f.child(terminal, f.b.metadata.id, 'late'), 'after terminal');
    assert.deepEqual(f.snapshot(), before, `${terminal}: late evidence cannot reopen projection`);
    const fresh = `${terminal}:fresh`;
    f.begin(fresh);
    f.paint(f.child(fresh), 'fresh');
    f.assertOutput(f.b.metadata.id, 'fresh', `${terminal}: future roots still work`);
    f.end(fresh);
  }
});

test('A to B to C projection retains actual output ownership and same-project nesting with cloned node IDs', async (t) => {
  const f = await mountRouting(t);

  f.begin('nested');
  const b = f.child('nested');
  const c = f.child('nested', f.c.metadata.id, 'c', b.graphRunId);
  f.paint(b, 'from B');
  f.paint(c, 'from C');
  f.paint(f.child('nested', f.c.metadata.id, 'c-local', c.graphRunId), 'nested C');
  f.assertOutput(f.b.metadata.id, 'from B', 'B retains its own cloned node output');
  f.assertOutput(f.c.metadata.id, 'nested C', 'C has its own cloned node output');
  assert.equal(f.history(f.a.metadata.id)?.[f.node.id], undefined, 'caller canvas cannot receive foreign cloned nodes');
  const runs = f.history(f.c.metadata.id)![f.node.id]!;
  assert.equal(runs[0]!.parentGraphRunId, undefined);
  assert.equal(runs[1]!.parentGraphRunId, c.graphRunId);
  assert.equal(f.store.get(projectExecutionSnapshotsState)[f.c.metadata.id]!.graphRunning, false);
});

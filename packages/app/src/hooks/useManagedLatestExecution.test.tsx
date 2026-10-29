import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { TextNodeImpl, getSubgraphProjectKey, type DataValue, type ProjectId } from '@valerypopoff/rivet2-core';
import { ProvidersProvider } from '../providers/ProvidersContext.js';
import type { ExecutorSessionRegistry } from '../providers/ExecutorSessionContext.js';
import {
  projectState,
  projectsState,
  openedProjectSnapshotsState,
  projectUnsavedChangesState,
} from '../state/savedGraphs.js';
import { remoteObservationNoticesState } from '../state/remoteObservation.js';
import { loadedRecordingState } from '../state/execution.js';
import { getExecutorProductState } from '../state/selectors/executionSelectors.js';
import { projectExecutionSnapshotsState, createEmptyProjectExecutionSnapshot } from '../state/dataFlow.js';
import { getManagedLatestControlState } from './managedLatestControlState.js';
import { projectRemoteExecutionEvent } from './remoteExecutionProjection.js';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject.js';
import { createExecutorSessionRuntime } from './executorSession.js';
import { FakeWebSocket } from './executorSessionTestUtils.js';
import { useManagedLatestExecution } from './useManagedLatestExecution.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
import { executionObservationCoordinatorState } from '../state/executionObservation.js';

test('real managed ingress projects only selected roots, reconstructs a retained view, and fences a reopened tab', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://rivet.test' });
  const values = {
    React,
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    WebSocket: FakeWebSocket,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = Object.keys(values).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.entries(values).forEach(([key, value]) =>
    Object.defineProperty(globalThis, key, { configurable: true, value }),
  );
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = createStore(),
    project = createBlankProjectWithDefaultGraph(),
    id = project.metadata.id;
  const member = createBlankProjectWithDefaultGraph(),
    memberId = member.metadata.id;
  const memberGraph = member.graphs[member.metadata.mainGraphId!]!,
    memberNode = TextNodeImpl.create();
  memberGraph.nodes.push(memberNode);
  store.set(openedProjectSnapshotsState, { [memberId]: { project: member } });
  const graph = project.graphs[project.metadata.mainGraphId!]!,
    node = TextNodeImpl.create();
  graph.nodes.push(node);
  store.set(projectState, project);
  const opened = { projectId: id, title: 'Fixture', fsPath: null };
  const tabs = {
    openedProjects: { [id]: opened, [memberId]: { projectId: memberId, title: 'Member' } },
    openedProjectsSortedIds: [id, memberId],
  };
  store.set(projectsState, tabs);
  const runtime = createExecutorSessionRuntime({ projectId: id, onStateChange() {} });
  const owners = new Map([
    [id, runtime],
    [memberId, runtime],
  ]);
  const registry = {
    getRemoteDebuggerRuntime: (projectId: ProjectId) => owners.get(projectId),
  } as unknown as ExecutorSessionRegistry;
  const refs = new Map<string, DataValue>();
  let adapter!: ReturnType<typeof useManagedLatestExecution>;
  function Harness() {
    adapter = useManagedLatestExecution(registry);
    return null;
  }
  await act(async () =>
    root.render(
      <Provider store={store}>
        <ProvidersProvider
          providers={{
            dataRefs: {
              get: (key) => refs.get(key),
              set: (key, value) => {
                refs.set(key, value);
              },
              delete: (key) => {
                refs.delete(key);
              },
            },
          }}
        >
          <Harness />
        </ProvidersProvider>
      </Provider>,
    ),
  );
  const unsubscribe = runtime.subscribeMessages(
    (message, data, _request, admission) => {
      if (admission?.managedLatest) adapter.receive(runtime, message, data, admission.managedLatest);
    },
    (frame, admission) => {
      if (admission.managedLatest) adapter.receive(runtime, frame.message, frame.data, admission.managedLatest);
    },
  );
  const unsubscribeDisconnect = runtime.subscribeLifecycle('disconnect', () => adapter.disconnect(runtime));
  t.after(async () => {
    unsubscribe();
    unsubscribeDisconnect();
    runtime.disconnect();
    await act(async () => root.unmount());
    descriptors.forEach(([key, descriptor]) =>
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key),
    );
    dom.window.close();
  });
  await runtime.connectExternalDebugger('ws://test/ws/latest-debugger%40A');
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.emitMessage({
    message: 'latest-session',
    data: { protocol: 2, channel: 'A', channelIsolation: true, runScopedControls: true },
  });
  assert.equal(
    getExecutorProductState({ selectedExecutor: 'browser', session: runtime.buildSessionState() }).type,
    'external-debugger-ready',
    'UI readiness consumes the verified protocol, not the raw URL spelling',
  );
  const emit = async (run: string, message: string, extra: object = {}, promptId?: string) =>
    act(async () =>
      socket.emitMessage({
        message,
        rivetScope: {
          channel: 'A',
          rootRunId: run,
          projectId: id,
          owner: 'owner',
          incarnation: 'process',
          promptLifecycle: 1,
          ...(promptId ? { promptId } : {}),
        },
        data: {
          eventOccurredAt: Date.now(),
          execution: { projectId: id, rootRunId: run, graphRunId: run, graphId: graph.metadata!.id! },
          ...extra,
        },
      }),
    );
  const begin = async (run: string) => {
    await emit(run, 'start', { project, startGraph: graph });
    await emit(run, 'graphStart', { graph, inputs: {} });
    await emit(run, 'nodeStart', { node, processId: run, inputs: {} });
  };
  const snapshot = () => store.get(projectExecutionSnapshotsState)[id]!;
  const controls = (projectId = id) => getManagedLatestControlState(store, registry, runtime, projectId)!;
  await begin('old');
  await begin('new');
  assert.equal(controls().graphRunning, true);
  await emit('old', 'pause');
  const capturedOldKey = runtime.getLatestDebuggerState()!.runs.find((run) => run.scope.rootRunId === 'old')!.key;
  assert.equal(
    getManagedLatestControlState(store, registry, runtime, id, capturedOldKey)!.canSendResume,
    true,
    'captured-root policy must not borrow the currently selected run capabilities',
  );
  assert.equal(controls().canSendPause, true);
  await emit('old', 'resume');
  assert.equal(controls(memberId).readOnly, true, 'a bundle observer never owns root controls');
  store.set(projectUnsavedChangesState, { [id]: true, [memberId]: true });
  await emit('new', 'graphStart', { graph, inputs: {} });
  assert.match(store.get(remoteObservationNoticesState)[id] ?? '', /saved graph/);
  assert.equal(snapshot().graphRunning, true);
  await emit('old', 'nodeFinish', {
    node,
    processId: 'old',
    outputs: { output: { type: 'string', value: 'old'.repeat(50_000) } },
  });
  await emit('old', 'done', { results: {} });
  assert.equal(snapshot().graphRunning, true, 'older completion cannot stop the selected root');
  assert.deepEqual(
    snapshot().lastRunDataByNode[node.id]!.map((item) => item.rootRunId),
    ['new'],
  );
  const returned = {
    projectId: id,
    rootRunId: 'new',
    graphRunId: 'return',
    graphId: graph.metadata!.id!,
    parentGraphRunId: 'new',
    projectScope: getSubgraphProjectKey({ projectId: id, version: 'latest' }),
  };
  await emit('new', 'graphStart', { graph, inputs: {}, execution: returned });
  await emit('new', 'nodeStart', { node, processId: 'returned', inputs: {}, execution: returned });
  await emit('new', 'nodeFinish', {
    node,
    processId: 'returned',
    outputs: { output: { type: 'string', value: 'return-to-source' } },
    execution: returned,
  });
  assert.equal(
    snapshot().lastRunDataByNode[node.id]!.find((item) => item.processId === 'returned')?.graphRunId,
    'return',
    'same-project return calls use their own invocation without losing the root',
  );
  const old = runtime.getLatestDebuggerState()!.runs.find((run) => run.scope.rootRunId === 'old')!;
  await act(async () => runtime.selectLatestDebuggerRun(old.key));
  assert.equal(snapshot().graphRunning, false);
  assert.equal(snapshot().lastRunDataByNode[node.id]![0]!.rootRunId, 'old');
  for (let i = 0; i < 3; i++) {
    assert.ok(refs.size > 0, 'retained selection materializes large values through the existing ref store');
    await act(async () => runtime.selectLatestDebuggerRun(runtime.getLatestDebuggerState()!.runs.at(-1)!.key));
    assert.equal(refs.size, 0, 'leaving a retained view releases its payload references');
    await act(async () => runtime.selectLatestDebuggerRun(old.key));
  }
  assert.equal(socket.sent.length, 0, 'reconstruction never dispatches execution');
  await act(async () => store.set(projectsState, { openedProjects: {}, openedProjectsSortedIds: [] }));
  await act(async () => store.set(projectsState, tabs));
  const before = snapshot();
  await act(async () => runtime.selectLatestDebuggerRun(old.key));
  assert.equal(snapshot(), before, 'historical selection cannot adopt a reopened lifetime');
  assert.equal(controls().readOnly, true, 'a reopened source cannot acquire retained run controls');
  await begin('missing-terminal');
  await emit(
    'missing-terminal',
    'userInput',
    {
      node,
      inputs: {},
      processId: 'missing-terminal',
      inputStrings: ['Waiting'],
      renderingType: 'text',
    },
    'pending',
  );
  assert.ok(Object.keys(snapshot().userInputQuestions).length > 0);
  await act(async () => runtime.selectLatestDebuggerRun(runtime.getLatestDebuggerState()!.selected!));
  assert.ok(
    Object.keys(snapshot().userInputQuestions).length > 0,
    'a verified pending prompt remains answerable on return',
  );
  await emit('missing-terminal', 'latest-prompt-closed', { promptId: 'pending' });
  assert.deepEqual(snapshot().userInputQuestions, {}, 'closure settles the precise prompt immediately');
  await act(async () => runtime.selectLatestDebuggerRun(runtime.getLatestDebuggerState()!.selected!));
  assert.deepEqual(snapshot().userInputQuestions, {}, 'history cannot resurrect an answered prompt');
  await emit(
    'missing-terminal',
    'userInput',
    {
      node,
      inputs: {},
      processId: 'missing-terminal',
      inputStrings: ['Still waiting'],
      renderingType: 'text',
    },
    'pending-next',
  );
  const nodeEvidence = () =>
    snapshot().lastRunDataByNode[node.id]!.map((entry) => {
      // Reconstruction has a new local delivery clock, but preserves the
      // recorded execution clock, identity, inputs, outputs and status.
      const { startedAt: _receiptStart, finishedAt: _receiptFinish, ...data } = entry.data;
      return { ...entry, data };
    });
  const beforeGap = nodeEvidence();
  const beforeOwnerNotice = snapshot();
  await act(async () =>
    socket.emitMessage({ message: 'latest-diagnostic', data: { protocol: 1, code: 'owner-unavailable' } }),
  );
  assert.equal(snapshot(), beforeOwnerNotice, 'an unavailable control owner is not a history gap');
  await act(async () =>
    socket.emitMessage({ message: 'latest-diagnostic', data: { protocol: 1, code: 'history-gap' } }),
  );
  assert.deepEqual(snapshot().userInputQuestions, {}, 'a stream gap withdraws uncertifiable open prompts');
  assert.equal(controls().graphRunning, true, 'missing diagnostics do not settle accepted execution');
  assert.deepEqual(nodeEvidence(), beforeGap, 'gap recovery preserves retained execution data and timing');
  assert.equal(socket.sent.length, 0, 'gap recovery never replays commands');
  await emit('missing-terminal', 'latest-settled');
  assert.equal(controls().graphRunning, false);
  assert.equal(controls().canSendAbort, false);
  assert.equal(snapshot().graphRunning, false, 'physical settlement closes an incomplete source view');
  assert.deepEqual(snapshot().userInputQuestions, {}, 'a settled owner cannot retain interactive prompts');
  assert.equal(snapshot().lastRunDataByNode[node.id]![0]!.data.status?.type, 'interrupted');
  await act(async () => runtime.selectLatestDebuggerRun(runtime.getLatestDebuggerState()!.runs.at(-1)!.key));
  const outside = createBlankProjectWithDefaultGraph();
  const outsideScope = {
    channel: 'A',
    rootRunId: 'outside',
    projectId: outside.metadata.id,
    owner: 'owner',
    incarnation: 'process',
  };
  const outsideExecution = {
    projectId: outside.metadata.id,
    rootRunId: 'outside',
    graphRunId: 'outside',
    graphId: outside.metadata.mainGraphId!,
  };
  const beforeOutside = snapshot();
  await act(async () =>
    socket.emitMessage({
      message: 'start',
      rivetScope: outsideScope,
      data: {
        project: outside,
        startGraph: outside.graphs[outside.metadata.mainGraphId!]!,
        execution: outsideExecution,
      },
    }),
  );
  assert.equal(snapshot(), beforeOutside, 'an unrelated closed caller cannot steal this group selection');
  const called = {
    projectId: id,
    rootRunId: 'outside',
    graphRunId: 'outside-child',
    graphId: graph.metadata!.id!,
    parentGraphRunId: 'outside',
    projectScope: getSubgraphProjectKey({ projectId: id, version: 'latest' }),
  };
  await act(async () => {
    socket.emitMessage({
      message: 'graphStart',
      rivetScope: outsideScope,
      data: { graph, inputs: {}, execution: called },
    });
    socket.emitMessage({
      message: 'nodeStart',
      rivetScope: outsideScope,
      data: { node, inputs: {}, processId: 'outside-child-node', execution: called },
    });
  });
  assert.equal(
    runtime.getLatestDebuggerState()!.runs.find((run) => run.key === runtime.getLatestDebuggerState()!.selected)?.scope
      .rootRunId,
    'outside',
    'called member makes an outside root relevant',
  );
  assert.equal(
    snapshot().lastRunDataByNode[node.id]![0]!.rootRunId,
    'outside',
    'an open member can observe a root outside its group',
  );
  assert.equal(store.get(projectState), project, 'observation never replaces the authored project');
  const beginMember = async (run: string) => {
    await begin(run);
    const execution = {
      projectId: memberId,
      rootRunId: run,
      graphRunId: `${run}-member`,
      graphId: memberGraph.metadata!.id!,
      parentGraphRunId: run,
      projectScope: getSubgraphProjectKey({ projectId: memberId, version: 'latest' }),
    };
    await emit(run, 'graphStart', { execution, graph: memberGraph, inputs: {} });
    await emit(run, 'nodeStart', { execution, node: memberNode, processId: 'member-node', inputs: {} });
    return execution;
  };
  const memberSnapshot = () => store.get(projectExecutionSnapshotsState)[memberId]!;
  await beginMember('retained-member');
  const retained = runtime.getLatestDebuggerState()!.selected!;
  const removed = await beginMember('removed-member');
  const removedKey = runtime.getLatestDebuggerState()!.selected!;
  owners.delete(memberId);
  await act(async () => adapter.disconnect(runtime, memberId));
  assert.equal(memberSnapshot().lastRunDataByNode[memberNode.id]![0]!.data.status?.type, 'interrupted');
  assert.equal(snapshot().graphRunning, true, 'removing one member preserves the remaining debugger group');
  await emit('removed-member', 'nodeFinish', { node, processId: 'removed-member', outputs: {} });
  assert.equal(snapshot().lastRunDataByNode[node.id]![0]!.data.status?.type, 'ok');
  owners.set(memberId, runtime);
  const departedView = memberSnapshot();
  await act(async () => runtime.selectLatestDebuggerRun(retained));
  assert.equal(memberSnapshot(), departedView, 'retained roots cannot reacquire a departed member');
  await act(async () => runtime.selectLatestDebuggerRun(removedKey));
  await emit('removed-member', 'nodeStart', { execution: removed, node: memberNode, processId: 'late', inputs: {} });
  assert.equal(memberSnapshot().lastRunDataByNode[memberNode.id]!.length, 1, 'rejoining cannot revive old admission');
  await act(async () => runtime.selectLatestDebuggerRun(runtime.getLatestDebuggerState()!.runs.at(-1)!.key));
  await beginMember('disconnected');
  assert.equal(memberSnapshot().lastRunDataByNode[memberNode.id]![0]!.data.status?.type, 'running');
  // Exercise the production buffer bounds against the actual runtime and store.
  // Missing starts must not hide controls or make an empty passive tab editable.
  let retainedRoot = 'disconnected';
  for (const limit of ['events', 'bytes']) {
    if (limit === 'bytes') {
      retainedRoot = 'disconnected-bytes';
      await beginMember(retainedRoot);
    }
    await act(async () => {
      const count = limit === 'events' ? 8200 : 34;
      for (let index = 0; index < count; index++)
        socket.emitMessage({
          message: 'trace',
          rivetScope: {
            channel: 'A',
            rootRunId: retainedRoot,
            projectId: id,
            owner: 'owner',
            incarnation: 'process',
            promptLifecycle: 1,
          },
          data: { log: limit === 'bytes' ? 'x'.repeat(1024 * 1024) : 'trace' },
        });
      runtime.selectLatestDebuggerRun(runtime.getLatestDebuggerState()!.selected!);
    });
    assert.equal(runtime.getLatestDebuggerState()!.runs.at(-1)!.incomplete, true);
    assert.equal(snapshot().graphRunning, false, 'canvas reconstruction does not fabricate a start');
    assert.equal(controls().graphRunning, true, `${limit} eviction cannot stop live lifecycle presentation`);
    assert.equal(controls().canSendAbort, true);
    assert.equal(controls(memberId).readOnly, true);
    assert.equal(controls(memberId).canSendPause, false);
    await emit(retainedRoot, 'pause');
    await emit(retainedRoot, 'graphOutputsReady', { outputs: {} });
    await act(async () => runtime.selectLatestDebuggerRun(runtime.getLatestDebuggerState()!.selected!));
    assert.equal(controls().graphPaused, true, 'paused lifecycle survives history reconstruction');
    assert.equal(controls().canSendResume, true);
    assert.equal(controls().canSendPause, false, 'ready outputs cannot enable an invalid second Pause');
    await emit(retainedRoot, 'resume');
    await emit(retainedRoot, limit === 'events' ? 'error' : 'abort', { error: 'Synthetic terminal' });
    await emit(retainedRoot, 'latest-settled');
    assert.equal(controls().graphRunning, false, 'failed/cancelled roots settle even with missing starts');
    assert.equal(controls().canSendAbort, false);
    await act(async () => runtime.selectLatestDebuggerRun(runtime.getLatestDebuggerState()!.runs.at(-1)!.key));
  }
  await act(async () => runtime.selectLatestDebuggerRun(runtime.getLatestDebuggerState()!.runs.at(-1)!.key));
  for (let index = 0; index < 10; index++) {
    await begin(`catalogue-${index}`);
    assert.equal(
      snapshot().runActivityJournal?.rootOrder.at(-1),
      `catalogue-${index}`,
      'evicting the previous remote display must not classify it as local work',
    );
    assert.equal(controls().readOnly, false);
  }
  await begin('recording-conflict');
  const coordinator = store.get(executionObservationCoordinatorState);
  let checks = 0;
  const check = coordinator.check;
  coordinator.check = (...args) => {
    checks++;
    return check(...args);
  };
  await act(async () => {
    for (let i = 0; i < 100; i++)
      store.set(projectExecutionSnapshotsState, (previous) => ({
        ...previous,
        [id]: { ...previous[id]!, lastRunDataByNode: { ...previous[id]!.lastRunDataByNode } },
      }));
  });
  assert.equal(checks, 0, 'payload-only snapshot updates do not scan retained admissions');
  for (let index = 0; index < 100; index++)
    await emit('recording-conflict', 'partialOutput', {
      node,
      processId: 'recording-conflict',
      outputs: { output: { type: 'string', value: `stream-${index}` } },
    });
  assert.equal(checks, 100, 'streaming retains one targeted check per source event, not scans of eight retained roots');
  coordinator.check = check;
  await act(async () =>
    store.set(loadedRecordingState, {
      path: 'fixture-recording',
      recorder: {} as never,
      projectId: id,
      projectPath: null,
    }),
  );
  const recordingView = snapshot();
  await act(async () => runtime.selectLatestDebuggerRun(runtime.getLatestDebuggerState()!.selected!));
  assert.equal(snapshot(), recordingView, 'reconstruction cannot overwrite a recording-owned snapshot');
  assert.equal(controls().readOnly, true);
  await act(async () => store.set(loadedRecordingState, null));
  assert.equal(controls().readOnly, true, 'unloading recording cannot renew an old admission');
  await act(async () => runtime.selectLatestDebuggerRun(runtime.getLatestDebuggerState()!.runs.at(-1)!.key));
  await beginMember('after-eviction');
  assert.equal(
    memberSnapshot().lastRunDataByNode[memberNode.id]?.[0]?.data.status?.type,
    'running',
    'fresh member data follows history eviction',
  );
  // A same-lifetime local run has replaced the source view before disconnect notification.
  await act(async () =>
    store.set(projectExecutionSnapshotsState, {
      ...store.get(projectExecutionSnapshotsState),
      [id]: applyProcessEventToProjectExecutionSnapshot({
        projectId: id,
        snapshot: snapshot(),
        message: 'start',
        data: {
          project,
          startGraph: graph,
          execution: { projectId: id, rootRunId: 'local', graphRunId: 'local', graphId: graph.metadata!.id! },
        } as never,
        refStore: {
          get: (key) => refs.get(key),
          set: (key, value) => {
            refs.set(key, value);
          },
          delete: (key) => {
            refs.delete(key);
          },
        },
      }).snapshot,
    }),
  );
  const localView = snapshot();
  assert.equal(controls().readOnly, true, 'a replacement local run revokes remote controls');
  await act(async () =>
    store.set(projectExecutionSnapshotsState, {
      ...store.get(projectExecutionSnapshotsState),
      [id]: { ...localView, graphRunning: false },
    }),
  );
  assert.equal(controls().readOnly, true, 'finishing a replacement run does not revive the superseded admission');
  const finishedLocalView = snapshot();
  owners.clear();
  await act(async () => runtime.disconnect());
  assert.equal(
    memberSnapshot().lastRunDataByNode[memberNode.id]![0]!.data.status?.type,
    'interrupted',
    'disconnect settles passive node displays',
  );
  assert.deepEqual(memberSnapshot().runningGraphs, []);
  assert.equal(snapshot(), finishedLocalView, 'disconnect cannot settle a replacement local execution');
  assert.equal(socket.sent.length, 0, 'settling observation never sends abort or execution commands');
});

test('shared remote projection preserves dirty graphs, rejects missing identities, and keeps passive policy explicit', () => {
  const project = createBlankProjectWithDefaultGraph();
  const graph = project.graphs[project.metadata.mainGraphId!]!;
  const node = TextNodeImpl.create();
  graph.nodes.push(node);
  const saved = structuredClone(graph);
  const before = structuredClone(project);
  const refs = { get: () => undefined, set() {}, delete() {} };
  for (const passive of [false, true]) {
    for (const difference of ['none', 'dirty', 'definitions', 'missing-graph', 'missing-node']) {
      const notices: string[] = [];
      const snapshot = createEmptyProjectExecutionSnapshot();
      const runtimeGraph = structuredClone(saved);
      if (difference === 'definitions') runtimeGraph.nodes[0]!.title = 'Different saved title';
      const result = projectRemoteExecutionEvent({
        projectId: project.metadata.id,
        project,
        snapshot,
        refStore: refs,
        message: difference === 'missing-node' ? 'nodeStart' : 'graphStart',
        data: {
          graph: runtimeGraph,
          node: difference === 'missing-node' ? { ...node, id: 'missing' } : node,
          inputs: {},
          processId: 'process',
          execution: {
            projectId: project.metadata.id,
            rootRunId: 'root',
            graphRunId: 'graph',
            graphId: difference === 'missing-graph' ? 'missing' : graph.metadata!.id!,
          },
        } as never,
        dirty: difference === 'dirty',
        clearFrozenOnGraphStart: passive,
        notice: (message) => notices.push(message),
      });
      if (difference.startsWith('missing')) {
        assert.equal(result, snapshot);
        assert.match(notices[0]!, /Missing graph\/node/);
      } else {
        assert.equal(notices.length, difference === 'none' ? 0 : 1);
        if (notices.length) assert.match(notices[0]!, /Unsaved definitions were not changed/);
      }
      assert.deepEqual(project, before);
    }
  }
});

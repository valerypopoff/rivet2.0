import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore, Provider } from 'jotai';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  coreCreateProcessor,
  ExecutionRecorder,
  GraphProcessor,
  type GraphId,
  type ProcessEventMessageMap,
  type ProjectId,
  type NodeId,
  type ProcessId,
  type PortId,
  type GraphRunId,
  type RootRunId,
  type DatasetProvider,
} from '@valerypopoff/rivet2-core';
import { createChildPlaybackFixture } from './fixtures/childPlaybackRecording.js';
import { loadedProjectState, projectState, projectsState } from '../state/savedGraphs.js';
import {
  clearLoadedRecordingForTabState,
  loadedRecordingState,
  rebindLoadedRecordingPathState,
  type LoadedRecording,
} from '../state/execution.js';
import { createEmptyProjectExecutionSnapshot, projectExecutionSnapshotsState } from '../state/dataFlow.js';
import {
  captureProjectExecutionSnapshot,
  restoreProjectExecutionSnapshot,
} from './projectExecutionSnapshotBindings.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
import { resetRecordingPlaybackDisplay } from './recordingPlaybackDisplay.js';
import { getDefaultProviders, ProvidersProvider, type DataRefStore } from '../providers/ProvidersContext.js';
import { storeNodeDataForHistory } from '../utils/executionDataStorage.js';
import { useGraphExecutionEvents, type GraphExecutionEventsApi } from './useGraphExecutionEvents.js';
import { BrowserIOProvider } from '../io/BrowserIOProvider.js';
import { graphState } from '../state/graph.js';
import type { IOProvider } from '../io/IOProvider.js';

function setup() {
  const store = createStore();
  const id = store.get(projectState).metadata.id;
  const recording: LoadedRecording = {
    recorder: new ExecutionRecorder(),
    path: '/child.recording',
    projectId: id,
    projectPath: '/child',
  };
  recording.recorder.events.push({ type: 'graphStart', data: { graphId: 'main' as GraphId, inputs: {} }, ts: 1 });
  store.set(loadedProjectState, { path: '/child', loaded: true });
  store.set(loadedRecordingState, recording);
  store.set(projectsState, {
    openedProjects: { [id]: { projectId: id, title: 'Child', fsPath: '/child' } },
    openedProjectsSortedIds: [id],
  });
  const values = new Map();
  const refs: DataRefStore = {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
    delete: (key) => {
      values.delete(key);
    },
  };
  return { store, recording, refs, values, id };
}

test('playback resets only display fields, preserves recording/journal/frozen config, and releases refs after installation', () => {
  const { store, recording, refs, values, id } = setup();
  const before = createEmptyProjectExecutionSnapshot();
  before.graphPaused = true;
  before.runningGraphs = ['old' as GraphId];
  before.lastRecording = 'old live recording';
  before.runActivityJournal.nextSequence = 44;
  before.frozenNodeOutputs = {};
  before.selectedProcessPageNodes = { ['node' as NodeId]: 3 };
  before.selectedLLMChatOutputPageByInvocation = { stale: 'snapshot-1' };
  before.userInputQuestions = {
    ['node' as NodeId]: [{ nodeId: 'node' as NodeId, processId: 'process' as ProcessId, questions: ['old prompt'] }],
  };
  before.lastRunDataByNode = {
    ['node' as NodeId]: [
      {
        processId: 'process' as ProcessId,
        data: storeNodeDataForHistory(
          { outputData: { ['output' as PortId]: { type: 'string', value: 'x'.repeat(100_000) } } },
          refs,
          { projectId: id, nodeId: 'node', processId: 'process' },
        ),
      },
    ],
  };
  assert.ok(values.size > 0);
  restoreProjectExecutionSnapshot(store, before);
  const project = store.get(projectState);
  const checkedRefs = {
    ...refs,
    delete: (key: string) => {
      assert.deepEqual(captureProjectExecutionSnapshot(store).lastRunDataByNode, {});
      assert.deepEqual(store.get(projectExecutionSnapshotsState)[id]!.lastRunDataByNode, {});
      refs.delete(key);
    },
  };
  assert.equal(resetRecordingPlaybackDisplay(store, recording, checkedRefs, true), true);
  const after = captureProjectExecutionSnapshot(store);
  assert.deepEqual(after, {
    ...createEmptyProjectExecutionSnapshot(),
    graphRunning: true,
    rootGraph: 'main',
    graphStartTime: after.graphStartTime,
    runActivityJournal: before.runActivityJournal,
    frozenNodeOutputs: before.frozenNodeOutputs,
  });
  assert.equal(after.runActivityJournal, before.runActivityJournal);
  assert.equal(store.get(loadedRecordingState), recording);
  assert.equal(store.get(projectState), project);
  assert.equal(values.size, 0);
});

test('tab switches reset the inactive owner, never its neighbor; stale/closed/replaced/path-changed selections are rejected', () => {
  const { store, recording, refs, id } = setup();
  const neighbor = 'neighbor' as ProjectId;
  const neighborSnapshot = { ...createEmptyProjectExecutionSnapshot(), graphStartTime: 123 };
  store.set(projectExecutionSnapshotsState, { [neighbor]: neighborSnapshot });
  store.set(projectState, {
    ...store.get(projectState),
    metadata: { ...store.get(projectState).metadata, id: neighbor },
  });
  const active = captureProjectExecutionSnapshot(store);
  assert.equal(resetRecordingPlaybackDisplay(store, recording, refs, true), true);
  assert.deepEqual(captureProjectExecutionSnapshot(store), active);
  assert.equal(store.get(projectExecutionSnapshotsState)[id]!.graphRunning, true);
  assert.equal(store.get(projectExecutionSnapshotsState)[neighbor], neighborSnapshot);
  const snapshots = store.get(projectExecutionSnapshotsState);
  store.set(loadedRecordingState, { ...recording });
  assert.equal(resetRecordingPlaybackDisplay(store, recording, refs, true), false);
  store.set(loadedRecordingState, recording);
  store.set(projectsState, { openedProjects: {}, openedProjectsSortedIds: [] });
  assert.equal(resetRecordingPlaybackDisplay(store, recording, refs, true), false);
  store.set(projectsState, {
    openedProjects: { [id]: { projectId: id, title: 'Reopened', fsPath: '/different' } },
    openedProjectsSortedIds: [id],
  });
  assert.equal(resetRecordingPlaybackDisplay(store, recording, refs, true), false);
  assert.equal(store.get(projectExecutionSnapshotsState), snapshots);
});

test('unloaded recordings and active path changes cannot clear existing results', () => {
  const { store, recording, refs } = setup();
  const before = captureProjectExecutionSnapshot(store);
  store.set(loadedRecordingState, null);
  assert.equal(resetRecordingPlaybackDisplay(store, recording, refs, true), false);
  store.set(loadedRecordingState, recording);
  store.set(loadedProjectState, { loaded: true, path: '/replacement' });
  assert.equal(resetRecordingPlaybackDisplay(store, recording, refs, true), false);
  assert.deepEqual(captureProjectExecutionSnapshot(store), before);
});

test('standalone desktop playback works without an opened-project registry', () => {
  const { store, recording, refs } = setup();
  store.set(projectsState, { openedProjects: {}, openedProjectsSortedIds: [] });
  assert.equal(resetRecordingPlaybackDisplay(store, recording, refs, false), true);
  assert.equal(captureProjectExecutionSnapshot(store).rootGraph, 'main');
});

test('a recorded root start in the same render turn cannot release already-reset output refs twice', (t) => {
  t.mock.method(BrowserIOProvider, 'isSupported', () => false);
  const { store, recording, refs, id } = setup();
  const before = createEmptyProjectExecutionSnapshot();
  before.lastRunDataByNode = {
    ['node' as NodeId]: [
      {
        processId: 'old' as ProcessId,
        data: storeNodeDataForHistory(
          { outputData: { ['output' as PortId]: { type: 'string', value: 'old'.repeat(100_000) } } },
          refs,
          { projectId: id, nodeId: 'node', processId: 'old' },
        ),
      },
    ],
  };
  restoreProjectExecutionSnapshot(store, before);
  const deleted = new Set<string>();
  const checkedRefs = {
    ...refs,
    delete: (key: string) => {
      assert.equal(deleted.has(key), false, 'reference deleted twice');
      deleted.add(key);
      refs.delete(key);
    },
  };
  let events: GraphExecutionEventsApi | undefined;
  function Harness() {
    events = useGraphExecutionEvents({
      clearNodeRunDataPreservationForNextStart: () => {},
      consumeNodeRunDataPreservationForNextStart: () => undefined,
      evaluationRunningLatest: { current: false },
    });
    return null;
  }
  renderToStaticMarkup(
    createElement(
      Provider,
      { store },
      createElement(ProvidersProvider, { providers: { dataRefs: checkedRefs } }, createElement(Harness)),
    ),
  );
  assert.equal(resetRecordingPlaybackDisplay(store, recording, checkedRefs, true), true);
  events!.onStart({
    project: store.get(projectState),
    startGraph: { metadata: { id: 'main' as GraphId, name: 'Main' }, nodes: [], connections: [] },
    inputs: {},
    contextValues: {},
    execution: {
      graphId: 'main' as GraphId,
      graphRunId: 'replay-graph' as GraphRunId,
      rootRunId: 'replay-root' as RootRunId,
    },
  });
  assert.ok(deleted.size > 0);
});

test('aborting editor playback from an inner graph reports the recording entry graph', async (t) => {
  t.mock.method(BrowserIOProvider, 'isSupported', () => false);
  // Capture the real hook callbacks without a browser/effect lifecycle. Only
  // suppress React's expected SSR layout-effect diagnostic, not runtime errors.
  const consoleError = console.error;
  t.mock.method(console, 'error', (message: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('Warning: useLayoutEffect does nothing on the server'))
      return;
    consoleError(message, ...args);
  });
  const { useLocalExecutor } = await import('./useLocalExecutor.js');
  const { child, recording: artifact } = await createChildPlaybackFixture(2);
  const { store, recording, refs } = setup();
  recording.projectId = child.metadata.id as ProjectId;
  recording.recorder = artifact;
  store.set(projectState, child);
  store.set(graphState, child.graphs['leaf' as GraphId]!);
  store.set(projectsState, {
    openedProjects: { [recording.projectId]: { projectId: recording.projectId, title: 'Replay', fsPath: '/child' } },
    openedProjectsSortedIds: [recording.projectId],
  });
  const abortedGraphs: GraphId[] = [];
  let datasetExports = 0;
  const datasets = Object.create(getDefaultProviders().datasets) as DatasetProvider;
  datasets.exportDatasetsForProject = async () => {
    datasetExports++;
    return [];
  };
  const io = Object.create(getDefaultProviders().io) as IOProvider;
  io.readProjectBundle = async () => {
    throw new Error('Playback must not load a live bundle');
  };
  const replay = GraphProcessor.prototype.replayRecording;
  t.mock.method(
    GraphProcessor.prototype,
    'replayRecording',
    async function (this: GraphProcessor, recorder: ExecutionRecorder) {
      this.on('graphAbort', (event) => {
        abortedGraphs.push(event.graph.metadata!.id!);
      });
      this.on('graphStart', () => {
        void this.abort();
      });
      return replay.call(this, recorder);
    },
  );
  let executor: ReturnType<typeof useLocalExecutor> | undefined;
  function Harness() {
    executor = useLocalExecutor();
    return null;
  }
  renderToStaticMarkup(
    createElement(
      Provider,
      { store },
      createElement(ProvidersProvider, { providers: { dataRefs: refs, datasets, io } }, createElement(Harness)),
    ),
  );
  // These selections are irrelevant to replay and must not enter the live
  // planner or install preload/preservation flags on the active workspace.
  await executor!.tryRunGraph({
    throwOnError: true,
    from: 'not-in-the-recording' as NodeId,
    to: ['also-absent' as NodeId],
  });
  assert.deepEqual(abortedGraphs, ['main']);
  assert.equal(datasetExports, 0);
});

for (const destination of ['ordinary tab', 'closed owner', 'other recording'] as const) {
  test(`playback preparation after switching to ${destination} releases only its own reservation`, async (t) => {
    const keepOwnerOpen = destination !== 'closed owner';
    t.mock.method(BrowserIOProvider, 'isSupported', () => false);
    const consoleError = console.error;
    t.mock.method(console, 'error', (message: unknown, ...args: unknown[]) => {
      if (typeof message === 'string' && message.startsWith('Warning: useLayoutEffect does nothing on the server'))
        return;
      consoleError(message, ...args);
    });
    const { useLocalExecutor } = await import('./useLocalExecutor.js');
    const { store, refs, id, recording } = setup();
    const before = createEmptyProjectExecutionSnapshot();
    before.lastRecording = 'previous live artifact';
    before.lastRunDataByNode = {
      ['old-node' as NodeId]: [{ processId: 'old-process' as ProcessId, data: { status: { type: 'ok' } } }],
    };
    restoreProjectExecutionSnapshot(store, before);
    let executor: ReturnType<typeof useLocalExecutor> | undefined;
    function Harness() {
      executor = useLocalExecutor();
      return null;
    }
    renderToStaticMarkup(
      createElement(
        Provider,
        { store },
        createElement(ProvidersProvider, { providers: { dataRefs: refs } }, createElement(Harness)),
      ),
    );
    const controller = new AbortController();
    const playback = executor!.tryRunGraph({ abortSignal: controller.signal, throwOnError: true });
    const pending = captureProjectExecutionSnapshot(store);
    assert.equal(pending.graphRunning, true);
    const neighbor = 'neighbor' as ProjectId;
    const neighborSnapshot = { ...createEmptyProjectExecutionSnapshot(), graphStartTime: 123 };
    store.set(projectExecutionSnapshotsState, { [id]: pending, [neighbor]: neighborSnapshot });
    store.set(projectsState, {
      openedProjects: {
        ...store.get(projectsState).openedProjects,
        [neighbor]: { projectId: neighbor, title: 'Neighbor', fsPath: '/neighbor' },
      },
      openedProjectsSortedIds: [id, neighbor],
    });
    store.set(projectState, {
      ...store.get(projectState),
      metadata: { ...store.get(projectState).metadata, id: neighbor },
    });
    store.set(loadedProjectState, { loaded: true, path: '/neighbor' });
    restoreProjectExecutionSnapshot(store, neighborSnapshot);
    if (destination === 'other recording') {
      store.set(loadedRecordingState, {
        ...recording,
        projectId: neighbor,
        projectPath: '/neighbor',
        recorder: new ExecutionRecorder(),
      });
    }
    if (!keepOwnerOpen) {
      store.set(clearLoadedRecordingForTabState, { projectId: id, projectPath: '/child' });
      store.set(projectsState, {
        openedProjects: { [neighbor]: store.get(projectsState).openedProjects[neighbor]! },
        openedProjectsSortedIds: [neighbor],
      });
      store.set(projectExecutionSnapshotsState, { [neighbor]: neighborSnapshot });
    }
    if (destination === 'other recording') await playback;
    else {
      controller.abort(new DOMException('Canceled during preparation', 'AbortError'));
      await assert.rejects(playback, { name: 'AbortError' });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const source = store.get(projectExecutionSnapshotsState)[id];
    if (keepOwnerOpen) {
      assert.ok(source);
      assert.equal(source.graphRunning, false);
      assert.equal(source.graphPaused, false);
      assert.deepEqual(source.runningGraphs, []);
      assert.equal(source.lastRunDataByNode, before.lastRunDataByNode);
      assert.equal(source.runActivityJournal, before.runActivityJournal);
      assert.equal(source.lastRecording, before.lastRecording);
    } else {
      assert.equal(source, undefined);
    }
    assert.deepEqual(captureProjectExecutionSnapshot(store), neighborSnapshot);
  });
}

for (const transition of ['replacement', 'path move', 'recording switch'] as const) {
  test(`running playback ownership handles ${transition}`, async (t) => {
    t.mock.method(BrowserIOProvider, 'isSupported', () => false);
    const consoleError = console.error;
    t.mock.method(console, 'error', (message: unknown, ...args: unknown[]) => {
      if (typeof message === 'string' && message.startsWith('Warning: useLayoutEffect does nothing on the server'))
        return;
      consoleError(message, ...args);
    });
    const { useLocalExecutor } = await import('./useLocalExecutor.js');
    const { child, recording: artifact } = await createChildPlaybackFixture();
    const { store, recording, refs } = setup();
    recording.projectId = child.metadata.id as ProjectId;
    recording.recorder = artifact;
    store.set(projectState, child);
    store.set(graphState, child.graphs['main' as GraphId]!);
    const ownerTab = { projectId: recording.projectId, title: 'Replay', fsPath: '/child' };
    store.set(projectsState, {
      openedProjects: { [recording.projectId]: ownerTab },
      openedProjectsSortedIds: [recording.projectId],
    });
    const replacement = { ...recording, recorder: ExecutionRecorder.deserializeFromString(artifact.serialize()) };
    const replacementSnapshot = { ...createEmptyProjectExecutionSnapshot(), graphStartTime: 456, graphRunning: true };
    let replaced = false;
    let aborted = false;
    let currentSelection: LoadedRecording | null = null;
    const replay = GraphProcessor.prototype.replayRecording;
    t.mock.method(
      GraphProcessor.prototype,
      'replayRecording',
      async function (this: GraphProcessor, recorder: ExecutionRecorder) {
        this.on('abort', () => {
          aborted = true;
        });
        this.on('graphStart', () => {
          if (replaced) return;
          replaced = true;
          if (transition === 'path move') {
            store.set(rebindLoadedRecordingPathState, { fromPath: '/child', toPath: '/moved' });
            store.set(projectsState, {
              openedProjects: { [recording.projectId]: { ...ownerTab, fsPath: '/moved' } },
              openedProjectsSortedIds: [recording.projectId],
            });
            store.set(loadedProjectState, { loaded: true, path: '/moved' });
            currentSelection = store.get(loadedRecordingState);
            return;
          }
          if (transition === 'recording switch') {
            const neighborId = 'other-recording' as ProjectId;
            store.set(projectExecutionSnapshotsState, {
              [recording.projectId]: captureProjectExecutionSnapshot(store),
            });
            store.set(projectsState, {
              openedProjects: {
                [recording.projectId]: ownerTab,
                [neighborId]: { projectId: neighborId, title: 'Other recording', fsPath: '/other' },
              },
              openedProjectsSortedIds: [recording.projectId, neighborId],
            });
            store.set(projectState, { ...child, metadata: { ...child.metadata, id: neighborId } });
            store.set(loadedProjectState, { loaded: true, path: '/other' });
            currentSelection = { ...replacement, projectId: neighborId, projectPath: '/other' };
            store.set(loadedRecordingState, currentSelection);
            restoreProjectExecutionSnapshot(store, replacementSnapshot);
            return;
          }
          // Closing and reopening can settle before React's close effect runs.
          store.set(clearLoadedRecordingForTabState, { projectId: recording.projectId, projectPath: '/child' });
          store.set(projectsState, { openedProjects: {}, openedProjectsSortedIds: [] });
          store.set(projectExecutionSnapshotsState, {});
          store.set(projectsState, {
            openedProjects: { [recording.projectId]: { ...ownerTab } },
            openedProjectsSortedIds: [recording.projectId],
          });
          store.set(loadedRecordingState, replacement);
          currentSelection = replacement;
          restoreProjectExecutionSnapshot(store, replacementSnapshot);
        });
        return replay.call(this, recorder);
      },
    );
    let executor: ReturnType<typeof useLocalExecutor> | undefined;
    function Harness() {
      executor = useLocalExecutor();
      return null;
    }
    renderToStaticMarkup(
      createElement(
        Provider,
        { store },
        createElement(ProvidersProvider, { providers: { dataRefs: refs } }, createElement(Harness)),
      ),
    );
    await executor!.tryRunGraph();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(replaced, true);
    assert.equal(store.get(loadedRecordingState), currentSelection);
    const after =
      transition === 'recording switch'
        ? store.get(projectExecutionSnapshotsState)[recording.projectId]!
        : captureProjectExecutionSnapshot(store);
    if (transition === 'replacement') {
      assert.equal(aborted, true);
      assert.deepEqual(after, replacementSnapshot);
    } else {
      assert.equal(aborted, false);
      assert.equal(after.graphRunning, false);
      assert.equal(after.lastRunDataByNode['child-text' as NodeId]?.[0]?.data.status?.type, 'ok');
      if (transition === 'path move') assert.equal(store.get(loadedRecordingState)?.projectPath, '/moved');
      else assert.deepEqual(captureProjectExecutionSnapshot(store), replacementSnapshot);
    }
  });
}

for (const kind of [
  'child',
  'nested child',
  'legacy child',
  'root',
  'failed child',
  'aborted child',
  'prompt child',
] as const) {
  test(`three replays of a real ${kind} artifact replace canvas history, retain real invocations and fresh identities`, async () => {
    const fixture = await createChildPlaybackFixture(
      kind === 'nested child' ? 2 : 0,
      kind === 'failed child'
        ? 'fail'
        : kind === 'aborted child'
          ? 'abort'
          : kind === 'prompt child'
            ? 'prompt'
            : 'complete',
    );
    assert.equal(
      fixture.recording.events.some((event) => event.type === 'start'),
      false,
    );
    let artifact = kind === 'root' ? fixture.rootRecording : fixture.recording;
    if (kind === 'legacy child') {
      const serialized = JSON.parse(artifact.serialize());
      for (const event of serialized.recording.events) if (event.data) delete event.data.execution;
      artifact = ExecutionRecorder.deserializeFromString(JSON.stringify(serialized));
      assert.ok(
        artifact.events.every(
          (event) => !('data' in event && event.data && typeof event.data === 'object' && 'execution' in event.data),
        ),
      );
    }
    const serializedBefore = artifact.serialize();
    const project = kind === 'root' ? fixture.parent : fixture.child;
    const { store, recording, refs } = setup();
    store.set(projectState, project);
    recording.projectId = project.metadata.id as ProjectId;
    recording.recorder = artifact;
    const initial = captureProjectExecutionSnapshot(store);
    restoreProjectExecutionSnapshot(store, {
      ...initial,
      runActivityJournal: {
        ...initial.runActivityJournal,
        limits: { ...initial.runActivityJournal.limits, completedRootCount: 3 },
      },
    });
    store.set(projectsState, {
      openedProjects: { [recording.projectId]: { projectId: recording.projectId, title: 'Replay', fsPath: '/child' } },
      openedProjectsSortedIds: [recording.projectId],
    });
    const observedIds = new Set<string>();
    for (let play = 0; play < 3; play++) {
      assert.equal(resetRecordingPlaybackDisplay(store, recording, refs, true), true);
      assert.deepEqual(captureProjectExecutionSnapshot(store).selectedGraphRunByView, {});
      assert.equal(captureProjectExecutionSnapshot(store).rootGraph, 'main');
      const player = coreCreateProcessor(project, {});
      const messages = new Set([
        'start',
        'graphStart',
        'graphFinish',
        'graphError',
        'graphAbort',
        'nodeStart',
        'nodeFinish',
        'nodeError',
        'done',
        'error',
        'abort',
        'userInput',
      ]);
      player.processor.onAny((message, data) => {
        if (!messages.has(String(message))) return;
        const next = applyProcessEventToProjectExecutionSnapshot({
          snapshot: captureProjectExecutionSnapshot(store),
          projectId: recording.projectId,
          refStore: refs,
          message: message as keyof ProcessEventMessageMap,
          data: data as ProcessEventMessageMap[keyof ProcessEventMessageMap],
        }).snapshot;
        restoreProjectExecutionSnapshot(store, next);
      });
      try {
        await player.processor.replayRecording(artifact);
      } finally {
        player.dispose();
      }
      const snapshot = captureProjectExecutionSnapshot(store);
      const runs = Object.values(snapshot.graphRunHistoryByView).flat();
      assert.equal(runs.length, kind === 'nested child' ? 3 : 1);
      if (kind === 'nested child') assert.equal(runs.filter((run) => run.graphId === 'leaf').length, 2);
      if (kind === 'nested child')
        assert.ok(Object.values(snapshot.graphRunHistoryByView).some((view) => view.length === 2));
      for (const run of runs) {
        assert.equal(observedIds.has(run.graphRunId), false);
        observedIds.add(run.graphRunId);
      }
      assert.deepEqual(snapshot.userInputQuestions, {});
      assert.equal(snapshot.graphRunning, false);
      assert.equal(snapshot.runActivityJournal.rootOrder.length, play + 1);
      assert.equal(artifact.serialize(), serializedBefore);
      restoreProjectExecutionSnapshot(store, {
        ...snapshot,
        selectedGraphRunByView: Object.fromEntries(
          Object.keys(snapshot.graphRunHistoryByView).map((key) => [key, runs[0]!.graphRunId]),
        ),
      });
    }
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TextNodeImpl,
  type DataValue,
  type GraphId,
  type GraphRunId,
  type RootRunId,
  type NodeId,
  type PortId,
  type ProcessId,
  type ProjectId,
  type ProcessEventMessageMap,
} from '@valerypopoff/rivet2-core';
import { createStore } from 'jotai';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import {
  createEmptyProjectExecutionSnapshot,
  projectExecutionSnapshotsState,
  type ProjectExecutionSnapshot,
} from '../state/dataFlow.js';
import { projectState, projectsState } from '../state/savedGraphs.js';
import { restoreStoredPortMap } from '../utils/executionDataReaders.js';
import { captureProjectExecutionActivity, routeProjectExecutionDisplay } from './projectExecutionSnapshotRouting.js';
import { renewProjectBindingState, retireWorkspaceExecutionState } from '../state/projectBindings.js';

type ProjectExecutionSnapshots = Record<ProjectId, ProjectExecutionSnapshot | undefined>;

function applySnapshot<K extends keyof ProcessEventMessageMap>(options: {
  snapshots: ProjectExecutionSnapshots;
  projectId: ProjectId;
  refStore: DataRefStore;
  data: ProcessEventMessageMap[K];
  message: K;
  previousDataPerNodeToKeep?: number;
  mapSnapshot?: (
    snapshot: NonNullable<ProjectExecutionSnapshots[ProjectId]>,
  ) => NonNullable<ProjectExecutionSnapshots[ProjectId]>;
  shouldApply?: (snapshot: NonNullable<ProjectExecutionSnapshots[ProjectId]>) => boolean;
}) {
  const store = createStore();
  store.set(projectsState, {
    openedProjects: { [options.projectId]: { projectId: options.projectId, title: 'Hidden' } },
    openedProjectsSortedIds: [options.projectId],
  });
  store.set(projectExecutionSnapshotsState, options.snapshots);
  routeProjectExecutionDisplay({ ...options, store });
  return store.get(projectExecutionSnapshotsState);
}

function disconnectSnapshot(options: {
  snapshots: ProjectExecutionSnapshots;
  projectId: ProjectId;
  refStore: DataRefStore;
  errorMessage: string;
}) {
  return applySnapshot({
    ...options,
    message: 'error',
    data: { error: new Error(options.errorMessage) },
    shouldApply: (snapshot) => snapshot.graphRunning,
  });
}

function createDataRefStore(): DataRefStore {
  const values = new Map<string, DataValue>();

  return {
    delete: (key) => {
      values.delete(key);
    },
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

test('evaluation activity retains its source across selection and rejects replacement, reopen and workspace retirement', () => {
  const store = createStore();
  const a = 'evaluation-a' as ProjectId;
  const b = 'neighbor-b' as ProjectId;
  const opened = {
    openedProjects: { [a]: { projectId: a, title: 'A' }, [b]: { projectId: b, title: 'B' } },
    openedProjectsSortedIds: [a, b],
  };
  store.set(projectsState, opened);
  const neighbor = createEmptyProjectExecutionSnapshot();
  store.set(projectExecutionSnapshotsState, { [b]: neighbor });
  const refs: DataRefStore = {
    get: () => undefined,
    set: () => assert.fail('activity must not allocate payload refs'),
    delete: () => assert.fail('activity must not delete canvas refs'),
  };
  const graph = { metadata: { id: 'main' as GraphId }, nodes: [], connections: [] };
  const execution = {
    projectId: a,
    graphId: graph.metadata.id,
    rootRunId: 'evaluation-root' as RootRunId,
    graphRunId: 'trial' as GraphRunId,
  };
  const activity = captureProjectExecutionActivity(store, a, refs);
  const selected = store.get(projectState);
  store.set(projectState, { ...selected, metadata: { ...selected.metadata, id: b } });
  activity.event('graphStart', { graph, execution, inputs: {} });
  activity.event('graphFinish', { graph, execution, outputs: {} });
  const snapshot = store.get(projectExecutionSnapshotsState)[a]!;
  assert.equal(snapshot.runActivityJournal.rootsById[execution.rootRunId]!.status, 'completed');
  assert.equal(snapshot.graphRunning, false, 'activity never owns canvas execution');
  assert.deepEqual(snapshot.lastRunDataByNode, {});
  assert.equal(store.get(projectExecutionSnapshotsState)[b], neighbor);
  for (const retire of [
    () => store.set(renewProjectBindingState, a),
    () => {
      store.set(projectsState, { openedProjects: { [b]: opened.openedProjects[b]! }, openedProjectsSortedIds: [b] });
      store.set(projectsState, opened);
    },
    () => store.set(retireWorkspaceExecutionState),
  ]) {
    const captured = captureProjectExecutionActivity(store, a, refs);
    retire();
    const before = store.get(projectExecutionSnapshotsState);
    assert.equal(captured.isCurrent(), false);
    captured.event('graphStart', { graph, execution, inputs: {} });
    assert.equal(store.get(projectExecutionSnapshotsState), before, 'retired activity cannot write');
  }
});

test('inactive request callbacks cannot resurrect closed tabs or overwrite replacement lifetimes', () => {
  for (const transition of ['close', 'replace', 'update'] as const) {
    const store = createStore();
    const id = 'callback-owner' as ProjectId;
    const opened = { openedProjects: { [id]: { projectId: id, title: 'A' } }, openedProjectsSortedIds: [id] };
    store.set(projectsState, opened);
    const replacement = { ...createEmptyProjectExecutionSnapshot(), lastRecording: 'new-binding' };
    let allocated = 0;
    let callbacks = 0;
    routeProjectExecutionDisplay({
      store,
      projectId: id,
      message: 'nodeFinish',
      data: {
        execution: {
          projectId: id,
          graphId: 'graph' as GraphId,
          graphRunId: 'graph-run' as GraphRunId,
          rootRunId: 'root' as RootRunId,
        },
        node: TextNodeImpl.create(),
        processId: 'process' as ProcessId,
        outputs: { ['output' as PortId]: { type: 'string', value: 'old-binding'.repeat(20_000) } },
      },
      refStore: {
        get: () => undefined,
        set: () => {
          allocated++;
        },
        delete: () => {},
      },
      onInactive: () => {
        callbacks++;
        if (transition === 'close') {
          store.set(projectsState, { openedProjects: {}, openedProjectsSortedIds: [] });
          store.set(projectExecutionSnapshotsState, {});
        } else {
          if (transition === 'replace') store.set(renewProjectBindingState, id);
          store.set(projectExecutionSnapshotsState, { [id]: replacement });
        }
      },
    });
    assert.equal(callbacks, 1, 'accepted request bookkeeping still completes');
    const snapshot = store.get(projectExecutionSnapshotsState)[id];
    if (transition === 'update') {
      assert.equal(allocated, 1, 'an unchanged owner still receives its accepted display event');
      assert.equal(
        snapshot!.lastRecording,
        replacement.lastRecording,
        'callback state is not overwritten by an old snapshot',
      );
      assert.equal(Object.values(snapshot!.lastRunDataByNode)[0]![0]!.data.status?.type, 'ok');
    } else {
      assert.equal(allocated, 0, 'retired display must be rejected before payload effects');
      assert.equal(snapshot, transition === 'close' ? undefined : replacement);
    }
  }
});

test('project execution event routing accepts only inactive open projects', () => {
  const projectId = 'project-a' as ProjectId;
  const store = createStore();
  let interactive = 0;
  const selected = store.get(projectState);
  store.set(projectState, { ...selected, metadata: { ...selected.metadata, id: projectId } });
  const event = {
    store,
    projectId,
    message: 'pause' as const,
    data: {} as ProcessEventMessageMap['pause'],
    refStore: createDataRefStore(),
    interactive: () => {
      interactive++;
    },
  };
  routeProjectExecutionDisplay(event);
  assert.equal(interactive, 1);
  assert.deepEqual(store.get(projectExecutionSnapshotsState), {});
  store.set(projectState, selected);
  routeProjectExecutionDisplay(event);
  assert.deepEqual(store.get(projectExecutionSnapshotsState), {}, 'closed projects cannot be recreated');
  store.set(projectsState, {
    openedProjects: { [projectId]: { projectId, title: 'Hidden' } },
    openedProjectsSortedIds: [projectId],
  });
  routeProjectExecutionDisplay(event);
  assert.equal(store.get(projectExecutionSnapshotsState)[projectId]!.graphPaused, true);
  assert.equal(interactive, 1);
});

test('project execution snapshot map update writes changed process events to the owner project', () => {
  const projectId = 'project-a' as ProjectId;
  const graphId = 'graph-a' as GraphId;
  const nodeId = 'node-a' as NodeId;
  const processId = 'process-a' as ProcessId;
  const refStore = createDataRefStore();
  const neighborId = 'project-b' as ProjectId;
  const neighbor = { ...createEmptyProjectExecutionSnapshot(), lastRecording: 'neighbor-recording' };
  const previousSnapshots: ProjectExecutionSnapshots = { [neighborId]: neighbor };
  const before = structuredClone(previousSnapshots);
  const node = TextNodeImpl.create();
  node.id = nodeId;

  const nextSnapshots = applySnapshot({
    data: {
      execution: {
        projectId,
        graphId,
        rootRunId: 'root' as RootRunId,
        graphRunId: 'graph-run' as GraphRunId,
      },
      inputs: {},
      node,
      processId,
    },
    message: 'nodeStart',
    projectId,
    refStore,
    snapshots: previousSnapshots,
  });

  assert.notEqual(nextSnapshots, previousSnapshots);
  assert.equal(nextSnapshots[projectId]?.lastRunDataByNode[nodeId]?.[0]?.data.status?.type, 'running');
  assert.equal(nextSnapshots[neighborId], neighbor, 'updating one project preserves its neighbor');
  assert.deepEqual(previousSnapshots, before, 'the prior map and snapshots are immutable');
});

test('project execution snapshot map update can map reducer-ignored snapshots for session-side cleanup', () => {
  const projectId = 'project-a' as ProjectId;
  const snapshot = createEmptyProjectExecutionSnapshot();
  snapshot.frozenNodeOutputs = {
    ['graph-a' as GraphId]: {
      ['node-a' as NodeId]: [],
    },
  };
  const previousSnapshots: ProjectExecutionSnapshots = {
    [projectId]: snapshot,
  };

  const nextSnapshots = applySnapshot({
    data: {
      args: [],
      level: 'log',
    },
    mapSnapshot: (nextSnapshot) => ({ ...nextSnapshot, frozenNodeOutputs: {} }),
    message: 'codeConsole',
    projectId,
    refStore: createDataRefStore(),
    snapshots: previousSnapshots,
  });

  assert.notEqual(nextSnapshots, previousSnapshots);
  assert.deepEqual(nextSnapshots[projectId]?.frozenNodeOutputs, {});
});

test('project routing applies the captured payload retention limit and releases evicted evidence', () => {
  const projectId = 'project-a' as ProjectId;
  const nodeId = 'node-a' as NodeId;
  const values = new Map<string, DataValue>();
  const refStore: DataRefStore = {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    delete: (key) => {
      values.delete(key);
    },
  };
  let snapshots: ProjectExecutionSnapshots = {};
  const node = TextNodeImpl.create();
  node.id = nodeId;
  node.data.text = '{{input}}';
  const execution = {
    projectId,
    graphId: 'graph-a' as GraphId,
    graphRunId: 'graph-run' as GraphRunId,
    rootRunId: 'root' as RootRunId,
  };
  for (const processId of ['first', 'second'] as ProcessId[]) {
    snapshots = applySnapshot({
      snapshots,
      projectId,
      refStore,
      previousDataPerNodeToKeep: 0,
      message: 'nodeStart',
      data: {
        execution,
        node,
        processId,
        inputs: { ['input' as PortId]: { type: 'string', value: processId.repeat(20_000) } },
      },
    });
    if (processId === 'first') {
      // Older persisted display snapshots predate round-page selection state.
      Reflect.deleteProperty(snapshots[projectId]!, 'selectedLLMChatOutputPageByInvocation');
    }
  }
  const runs = snapshots[projectId]!.lastRunDataByNode[nodeId]!;
  assert.equal(runs.length, 2, 'retention preserves invocation metadata');
  assert.deepEqual(runs[0]!.data.inputData, {});
  assert.deepEqual(
    restoreStoredPortMap(runs[1]!.data.inputData, refStore),
    {
      input: { type: 'string', value: 'second'.repeat(20_000) },
    },
    'the actual latest payload survives, not merely a truthy port map',
  );
  assert.equal(values.size, 1, 'the older invocation no longer owns a stored payload');
  assert.deepEqual(snapshots[projectId]!.selectedLLMChatOutputPageByInvocation, {});
  Reflect.deleteProperty(snapshots[projectId]!, 'selectedLLMChatOutputPageByInvocation');
  snapshots = applySnapshot({
    snapshots,
    projectId,
    refStore,
    message: 'nodeOutputsCleared',
    data: { node, execution },
  });
  assert.equal(values.size, 0, 'clearing an older snapshot also releases its remaining payload');
  assert.deepEqual(snapshots[projectId]!.selectedLLMChatOutputPageByInvocation, {});
});

test('executor disconnect snapshot update interrupts only running hidden snapshots', () => {
  const projectId = 'project-a' as ProjectId;
  const stoppedSnapshot = createEmptyProjectExecutionSnapshot();
  const stoppedSnapshots: ProjectExecutionSnapshots = {
    [projectId]: stoppedSnapshot,
  };

  assert.equal(
    disconnectSnapshot({
      errorMessage: 'Executor session disconnected',
      projectId,
      refStore: createDataRefStore(),
      snapshots: stoppedSnapshots,
    }),
    stoppedSnapshots,
  );

  const runningSnapshot = createEmptyProjectExecutionSnapshot();
  runningSnapshot.graphRunning = true;
  const nodeId = 'node' as NodeId;
  runningSnapshot.lastRunDataByNode[nodeId] = [
    { processId: 'target' as ProcessId, data: { status: { type: 'running' } } },
  ];
  const neighborId = 'project-b' as ProjectId;
  const neighbor = structuredClone(runningSnapshot);
  neighbor.lastRecording = 'keep-neighbor';
  const runningSnapshots: ProjectExecutionSnapshots = {
    [projectId]: runningSnapshot,
    [neighborId]: neighbor,
  };
  const before = structuredClone(runningSnapshots);
  const nextSnapshots = disconnectSnapshot({
    errorMessage: 'Executor session disconnected',
    projectId,
    refStore: createDataRefStore(),
    snapshots: runningSnapshots,
  });

  assert.notEqual(nextSnapshots, runningSnapshots);
  assert.equal(nextSnapshots[projectId]?.graphRunning, false);
  assert.equal(nextSnapshots[projectId]?.lastRunDataByNode[nodeId]?.[0]?.data.status?.type, 'interrupted');
  assert.equal(nextSnapshots[neighborId], neighbor, 'disconnect cleanup preserves the other running project');
  assert.deepEqual(runningSnapshots, before, 'cleanup does not mutate the prior map');
});

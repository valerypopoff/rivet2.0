import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from 'jotai';
import type { ProjectId, NodeId } from '@valerypopoff/rivet2-core';
import { activeExecutionSnapshotState } from './projectExecutionStore.js';
import {
  graphPausedState,
  graphRunningState,
  createEmptyProjectExecutionSnapshot,
  projectExecutionSnapshotsState,
} from './dataFlow.js';
import { projectState, projectsState } from './savedGraphs.js';
import { projectBindingRegistryState, renewProjectBindingState } from './projectBindings.js';
import {
  updateOpenProjectExecutionSnapshot,
  updateCurrentProjectExecutionSnapshot,
} from '../hooks/projectExecutionSnapshotRouting.js';
import { applyProcessEventToProjectExecutionSnapshot } from '../hooks/projectExecutionSnapshotEvents.js';

test('legacy terminal confirmations stay with their project while tabs change', () => {
  const store = createStore(),
    project = store.get(projectState),
    a = project.metadata.id,
    b = 'queue-b' as ProjectId;
  const snapshot = (root: string) =>
    ({
      ...createEmptyProjectExecutionSnapshot(),
      lastRunDataByNode: {
        node: [root, 'unrelated'].map((id) => ({
          processId: id,
          rootRunId: id,
          data: { status: { type: 'running' } },
        })),
      },
    }) as ReturnType<typeof createEmptyProjectExecutionSnapshot>;
  store.set(projectsState, {
    openedProjects: { [a]: { projectId: a, title: 'A' }, [b]: { projectId: b, title: 'B' } },
    openedProjectsSortedIds: [a, b],
  });
  store.set(projectExecutionSnapshotsState, { [a]: snapshot('root-a'), [b]: snapshot('root-b') });
  const refs = { get: () => undefined, set() {}, delete() {} };
  const finish = (root: string) =>
    updateCurrentProjectExecutionSnapshot(
      store,
      (before) =>
        applyProcessEventToProjectExecutionSnapshot({
          snapshot: before,
          message: 'graphFinish',
          projectId: store.get(projectState).metadata.id,
          refStore: refs,
          activityData: false,
          data: {
            graph: { metadata: { id: 'graph' } },
            execution: { graphId: 'graph', graphRunId: root, rootRunId: root },
          } as never,
        }).snapshot,
    );
  finish('root-a');
  store.set(projectState, { ...project, metadata: { ...project.metadata, id: b } });
  finish('root-b');
  store.set(projectState, project);
  updateCurrentProjectExecutionSnapshot(
    store,
    (before) =>
      applyProcessEventToProjectExecutionSnapshot({
        snapshot: before,
        message: 'done',
        data: { results: {} },
        projectId: a,
        refStore: refs,
        activityData: false,
      }).snapshot,
  );
  const snapshots = store.get(projectExecutionSnapshotsState);
  assert.equal(snapshots[a]!.lastRunDataByNode['node' as NodeId]![0]!.data.status?.type, 'ok');
  assert.equal(snapshots[a]!.lastRunDataByNode['node' as NodeId]![1]!.data.status?.type, 'running');
  assert.deepEqual(snapshots[a]!.completedRootRunIds, []);
  assert.deepEqual(snapshots[b]!.completedRootRunIds, ['root-b']);
  assert.equal(snapshots[b]!.lastRunDataByNode['node' as NodeId]![0]!.data.status?.type, 'running');
});

test('tab selection is a lens over one canonical snapshot, with no capture/restore and no cross-store state', () => {
  const store = createStore();
  const other = createStore();
  const project = store.get(projectState);
  const a = project.metadata.id;
  const b = 'b' as ProjectId;
  const first = { ...createEmptyProjectExecutionSnapshot(), graphPaused: true, graphRunning: true };
  const second = { ...createEmptyProjectExecutionSnapshot(), graphStartTime: 321 };
  store.set(projectExecutionSnapshotsState, { [a]: first, [b]: second });
  assert.equal(store.get(activeExecutionSnapshotState), first);
  store.set(projectState, { ...project, metadata: { ...project.metadata, id: b } });
  assert.equal(store.get(activeExecutionSnapshotState), second);
  assert.equal(store.get(graphRunningState), false);
  store.set(graphPausedState, true);
  assert.equal(store.get(projectExecutionSnapshotsState)[a], first);
  assert.equal(store.get(projectExecutionSnapshotsState)[b]!.graphPaused, true);
  store.set(projectState, project);
  assert.equal(store.get(activeExecutionSnapshotState), first);
  assert.deepEqual(other.get(projectExecutionSnapshotsState), {});
  assert.notEqual(other.get(projectBindingRegistryState), store.get(projectBindingRegistryState));
});

test('actual workspace writes fence close/reopen and same-path replacement before reference effects run', () => {
  const store = createStore();
  const id = store.get(projectState).metadata.id;
  const opened = {
    openedProjects: { [id]: { projectId: id, title: 'A', fsPath: '/a', hostedBundleKey: 'bundle' } },
    openedProjectsSortedIds: [id],
  };
  store.set(projectsState, opened);
  const token = store.get(projectBindingRegistryState).get(id)!.token;
  store.set(projectsState, { openedProjects: {}, openedProjectsSortedIds: [] });
  store.set(projectsState, opened);
  let effects = 0;
  updateOpenProjectExecutionSnapshot(
    store,
    id,
    (snapshot) => {
      effects++;
      return { ...snapshot, graphPaused: true };
    },
    token,
  );
  assert.equal(effects, 0, 'rejected events cannot allocate/delete payload references');
  const current = store.get(projectBindingRegistryState).get(id)!.token;
  store.set(renewProjectBindingState, id);
  updateOpenProjectExecutionSnapshot(
    store,
    id,
    (snapshot) => {
      effects++;
      return snapshot;
    },
    current,
  );
  assert.equal(effects, 0);
  const fresh = store.get(projectBindingRegistryState).get(id)!.token;
  updateOpenProjectExecutionSnapshot(
    store,
    id,
    (snapshot) => {
      effects++;
      return { ...snapshot, graphPaused: true };
    },
    fresh,
  );
  assert.equal(effects, 1);
  assert.equal(store.get(graphPausedState), true);
});

test('explicit replacement retires old display controls and running evidence without deleting saved outputs', () => {
  const store = createStore();
  const id = store.get(projectState).metadata.id;
  store.set(projectsState, {
    openedProjects: { [id]: { projectId: id, title: 'A', fsPath: '/a' } },
    openedProjectsSortedIds: [id],
  });
  const snapshot = {
    ...createEmptyProjectExecutionSnapshot(),
    graphRunning: true,
    graphPaused: true,
    lastRecording: 'retained',
  };
  snapshot.lastRunDataByNode = {
    node: [
      {
        processId: 'process',
        data: {
          status: { type: 'running' },
          outputData: { value: { type: 'string', storage: 'inline', value: 'retained output' } },
        },
      },
    ],
  } as never;
  store.set(projectExecutionSnapshotsState, { [id]: snapshot });
  store.set(renewProjectBindingState, id);
  const next = store.get(projectExecutionSnapshotsState)[id]!;
  assert.equal(next.graphRunning, false);
  assert.equal(next.graphPaused, false);
  assert.equal(next.lastRecording, 'retained');
  const oldProcess = Object.values(snapshot.lastRunDataByNode)[0]![0]!;
  const newProcess = Object.values(next.lastRunDataByNode)[0]![0]!;
  assert.equal(newProcess.data.status?.type, 'interrupted');
  assert.equal(newProcess.data.outputData, oldProcess.data.outputData);
  assert.equal(oldProcess.data.status?.type, 'running');
});

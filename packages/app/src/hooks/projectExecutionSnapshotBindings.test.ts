import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from 'jotai';
import {
  type NodeId,
  type ProcessId,
  type GraphId,
  type GraphRunId,
  type RootRunId,
  type PortId,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import {
  createEmptyProjectExecutionSnapshot,
  graphRunningState,
  lastRunDataByNodeState,
  projectExecutionSnapshotsState,
} from '../state/dataFlow.js';
import { projectState, projectsState } from '../state/savedGraphs.js';
import { updateOpenProjectExecutionSnapshot } from './projectExecutionSnapshotRouting.js';
import {
  captureProjectExecutionSnapshot,
  restoreProjectExecutionSnapshot,
} from './projectExecutionSnapshotBindings.js';

test('every snapshot field round-trips across tab changes and large data retains identity', () => {
  const store = createStore();
  const snapshot = createEmptyProjectExecutionSnapshot();
  snapshot.graphPaused = true;
  snapshot.graphRunning = true;
  snapshot.graphStartTime = 123;
  snapshot.lastRecording = 'recording';
  snapshot.rootGraph = 'graph' as GraphId;
  snapshot.runningGraphs = [snapshot.rootGraph];
  snapshot.graphRunHistoryByView = {
    view: [{ graphId: snapshot.rootGraph, graphRunId: 'graph-run' as GraphRunId, rootRunId: 'root-run' as RootRunId }],
  };
  snapshot.selectedGraphRunByView = { view: 'graph-run' as GraphRunId };
  snapshot.frozenNodeOutputs = {
    [snapshot.rootGraph]: { ['node' as NodeId]: [{ ['output' as PortId]: { type: 'string', value: 'frozen' } }] },
  };
  snapshot.runActivityJournal.nextSequence = 42;
  snapshot.selectedLLMChatOutputPageByInvocation = { invocation: 'snapshot-2' };
  snapshot.lastRunDataByNode = {
    ['node' as NodeId]: [{ processId: 'process' as ProcessId, data: { status: { type: 'running' } } }],
  };
  snapshot.selectedProcessPageNodes = { ['node' as NodeId]: 2 };
  snapshot.userInputQuestions = {
    ['node' as NodeId]: [{ nodeId: 'node' as NodeId, processId: 'process' as ProcessId, questions: ['Question?'] }],
  };
  restoreProjectExecutionSnapshot(store, snapshot);
  assert.deepEqual(captureProjectExecutionSnapshot(store), snapshot);
  assert.equal(store.get(lastRunDataByNodeState), snapshot.lastRunDataByNode);
  restoreProjectExecutionSnapshot(store, undefined);
  assert.deepEqual(captureProjectExecutionSnapshot(store), createEmptyProjectExecutionSnapshot());
  restoreProjectExecutionSnapshot(store, snapshot);
  assert.equal(store.get(graphRunningState), true);
  assert.equal(store.get(lastRunDataByNodeState), snapshot.lastRunDataByNode);
});

test('legacy additive fields are restored to empty values without changing the saved snapshot', () => {
  const snapshot = createEmptyProjectExecutionSnapshot();
  const legacy = { ...snapshot };
  delete legacy.frozenNodeOutputs;
  delete (legacy as Partial<typeof legacy>).runActivityJournal;
  delete (legacy as Partial<typeof legacy>).selectedLLMChatOutputPageByInvocation;
  delete (legacy as Partial<typeof legacy>).userInputQuestions;
  const store = createStore();
  restoreProjectExecutionSnapshot(store, legacy);
  assert.deepEqual(captureProjectExecutionSnapshot(store), snapshot);
  assert.equal(Object.hasOwn(legacy, 'runActivityJournal'), false);
});

test('passive snapshot boundary runs reference effects once and writes only changed active fields', () => {
  const store = createStore();
  const id = store.get(projectState).metadata.id;
  store.set(projectsState, {
    openedProjects: { [id]: { projectId: id, title: 'A', fsPath: '/a' } },
    openedProjectsSortedIds: [id],
  });
  const originalData = store.get(lastRunDataByNodeState);
  let writes = 0;
  let updates = 0;
  const unsubscribe = store.sub(lastRunDataByNodeState, () => writes++);
  updateOpenProjectExecutionSnapshot(store, id, (before) => {
    updates++;
    return { ...before, graphPaused: true };
  });
  assert.equal(updates, 1);
  assert.equal(writes, 0);
  assert.equal(store.get(lastRunDataByNodeState), originalData);
  assert.equal(captureProjectExecutionSnapshot(store).graphPaused, true);
  assert.equal(store.get(projectExecutionSnapshotsState)[id]!.graphPaused, true);
  unsubscribe();
});

test('passive snapshots update inactive tabs, but never recreate closed tabs or touch active atoms', () => {
  const store = createStore();
  const id = 'inactive' as ProjectId;
  store.set(projectsState, {
    openedProjects: { [id]: { projectId: id, title: 'B', fsPath: '/b' } },
    openedProjectsSortedIds: [id],
  });
  updateOpenProjectExecutionSnapshot(store, id, (before) => ({ ...before, graphPaused: true }));
  assert.equal(store.get(projectExecutionSnapshotsState)[id]!.graphPaused, true);
  assert.equal(captureProjectExecutionSnapshot(store).graphPaused, false);
  store.set(projectsState, { openedProjects: {}, openedProjectsSortedIds: [] });
  const snapshots = store.get(projectExecutionSnapshotsState);
  updateOpenProjectExecutionSnapshot(store, id, () => assert.fail('Closed tab update was evaluated'));
  assert.equal(store.get(projectExecutionSnapshotsState), snapshots);
});

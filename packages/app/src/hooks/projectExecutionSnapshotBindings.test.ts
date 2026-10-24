import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from 'jotai';
import {
  TextNodeImpl,
  type NodeId,
  type ProcessId,
  type GraphId,
  type GraphRunId,
  type RootRunId,
  type PortId,
  type ProjectId,
  type DataValue,
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
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';

test('every snapshot field round-trips across tab changes without replacing node-history identity', () => {
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
  const values = new Map<string, DataValue>();
  let allocations = 0;
  const refStore = {
    get: (key: string) => values.get(key),
    set: (key: string, value: DataValue) => {
      allocations++;
      values.set(key, value);
    },
    delete: (key: string) => {
      values.delete(key);
    },
  };
  const node = TextNodeImpl.create();
  const project = store.get(projectState);
  updateOpenProjectExecutionSnapshot(
    store,
    id,
    (snapshot) =>
      applyProcessEventToProjectExecutionSnapshot({
        snapshot,
        refStore,
        projectId: id,
        message: 'nodeStart',
        data: {
          node,
          processId: 'process' as ProcessId,
          execution: {
            projectId: id,
            rootRunId: 'root' as RootRunId,
            graphRunId: 'graph-run' as GraphRunId,
            graphId: project.metadata.mainGraphId!,
          },
          inputs: { ['input' as PortId]: { type: 'string', value: 'large'.repeat(20_000) } },
        },
      }).snapshot,
  );
  assert.equal(allocations, 1, 'one real reducer event allocates its payload reference exactly once');
  assert.equal(values.size, 1);
  assert.equal(writes, 1, 'only the event that changes node history writes that atom');
  assert.equal(captureProjectExecutionSnapshot(store).graphPaused, true, 'unrelated fields survive the payload update');
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

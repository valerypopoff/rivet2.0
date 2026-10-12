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
} from '@valerypopoff/rivet2-core';
import { createEmptyProjectExecutionSnapshot, graphRunningState, lastRunDataByNodeState } from '../state/dataFlow.js';
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

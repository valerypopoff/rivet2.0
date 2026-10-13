import type { PrimitiveAtom, createStore } from 'jotai';
import {
  createEmptyProjectExecutionSnapshot,
  frozenNodeOutputsState,
  graphPausedState,
  graphRunHistoryByViewState,
  graphRunningState,
  graphStartTimeState,
  lastRunDataByNodeState,
  rootGraphState,
  runActivityJournalState,
  runningGraphsState,
  selectedGraphRunByViewState,
  selectedLLMChatOutputPageByInvocationState,
  selectedProcessPageNodesState,
  type ProjectExecutionSnapshot,
} from '../state/dataFlow.js';
import { lastRecordingState } from '../state/execution.js';
import { userInputModalQuestionsState } from '../state/userInput.js';
import { createRunActivityJournal } from '../features/runActivity/runActivityJournal.js';

type Store = ReturnType<typeof createStore>;
type SnapshotBinding = {
  capture(store: Store, snapshot: ProjectExecutionSnapshot): void;
  restore(store: Store, snapshot: ProjectExecutionSnapshot): void;
};

function snapshotField<K extends keyof ProjectExecutionSnapshot, V extends ProjectExecutionSnapshot[K]>(
  key: K,
  atom: PrimitiveAtom<V>,
  restoreValue: (value: ProjectExecutionSnapshot[K]) => V,
): SnapshotBinding {
  return {
    capture: (store, snapshot) => {
      snapshot[key] = store.get(atom);
    },
    restore: (store, snapshot) => {
      store.set(atom, restoreValue(snapshot[key]));
    },
  };
}

// One exhaustive declaration for tab capture and restoration. No copies of large payloads.
const snapshotBindings = {
  graphPaused: snapshotField('graphPaused', graphPausedState, (value) => value),
  graphRunHistoryByView: snapshotField('graphRunHistoryByView', graphRunHistoryByViewState, (value) => value),
  graphRunning: snapshotField('graphRunning', graphRunningState, (value) => value),
  graphStartTime: snapshotField('graphStartTime', graphStartTimeState, (value) => value),
  frozenNodeOutputs: snapshotField('frozenNodeOutputs', frozenNodeOutputsState, (value) => value ?? {}),
  lastRecording: snapshotField('lastRecording', lastRecordingState, (value) => value),
  lastRunDataByNode: snapshotField('lastRunDataByNode', lastRunDataByNodeState, (value) => value),
  rootGraph: snapshotField('rootGraph', rootGraphState, (value) => value),
  runActivityJournal: snapshotField(
    'runActivityJournal',
    runActivityJournalState,
    (value) => value ?? createRunActivityJournal(),
  ),
  runningGraphs: snapshotField('runningGraphs', runningGraphsState, (value) => value),
  selectedGraphRunByView: snapshotField('selectedGraphRunByView', selectedGraphRunByViewState, (value) => value),
  selectedLLMChatOutputPageByInvocation: snapshotField(
    'selectedLLMChatOutputPageByInvocation',
    selectedLLMChatOutputPageByInvocationState,
    (value) => value ?? {},
  ),
  selectedProcessPageNodes: snapshotField('selectedProcessPageNodes', selectedProcessPageNodesState, (value) => value),
  userInputQuestions: snapshotField('userInputQuestions', userInputModalQuestionsState, (value) => value ?? {}),
} satisfies Record<keyof ProjectExecutionSnapshot, SnapshotBinding>;

export function captureProjectExecutionSnapshot(store: Store): ProjectExecutionSnapshot {
  const snapshot = createEmptyProjectExecutionSnapshot();
  for (const binding of Object.values(snapshotBindings)) binding.capture(store, snapshot);
  return snapshot;
}

export function restoreProjectExecutionSnapshot(store: Store, snapshot: ProjectExecutionSnapshot | undefined): void {
  const next = snapshot ?? createEmptyProjectExecutionSnapshot();
  for (const binding of Object.values(snapshotBindings)) binding.restore(store, next);
}

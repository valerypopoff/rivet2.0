import type { createStore } from 'jotai';
import { createEmptyProjectExecutionSnapshot, type ProjectExecutionSnapshot } from '../state/dataFlow.js';
import { activeExecutionSnapshotState } from '../state/projectExecutionStore.js';

type Store = ReturnType<typeof createStore>;

/** Compatibility helpers for reset/recording callers, not a tab-transfer mechanism. */
export function captureProjectExecutionSnapshot(store: Store): ProjectExecutionSnapshot {
  return store.get(activeExecutionSnapshotState);
}

export function restoreProjectExecutionSnapshot(store: Store, snapshot: ProjectExecutionSnapshot | undefined): void {
  const empty = createEmptyProjectExecutionSnapshot();
  store.set(
    activeExecutionSnapshotState,
    snapshot
      ? {
          ...empty,
          ...snapshot,
          frozenNodeOutputs: snapshot.frozenNodeOutputs ?? empty.frozenNodeOutputs,
          runActivityJournal: snapshot.runActivityJournal ?? empty.runActivityJournal,
          selectedLLMChatOutputPageByInvocation: snapshot.selectedLLMChatOutputPageByInvocation ?? {},
          userInputQuestions: snapshot.userInputQuestions ?? {},
        }
      : empty,
  );
}

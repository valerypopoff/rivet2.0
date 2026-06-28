import { type ProjectId } from '@valerypopoff/rivet2-core';
import { useCallback } from 'react';
import { useSetAtom, useStore } from 'jotai';
import {
  createEmptyProjectExecutionSnapshot,
  frozenNodeOutputsState,
  graphPausedState,
  graphRunHistoryByViewState,
  graphRunningState,
  graphStartTimeState,
  lastRunDataByNodeState,
  projectExecutionSnapshotsState,
  rootGraphState,
  runningGraphsState,
  selectedGraphRunByViewState,
  selectedProcessPageNodesState,
  type ProjectExecutionSnapshot,
} from '../state/dataFlow.js';
import { lastRecordingState } from '../state/execution.js';
import { userInputModalQuestionsState } from '../state/userInput.js';
import { useDataRefs } from '../providers/ProvidersContext.js';
import { clearExecutionDataRefs } from '../utils/executionDataStorage.js';

export function useProjectExecutionSnapshots() {
  const store = useStore();
  const dataRefs = useDataRefs();
  const setProjectExecutionSnapshots = useSetAtom(projectExecutionSnapshotsState);

  const captureCurrentProjectExecutionSnapshot = useCallback((): ProjectExecutionSnapshot => {
    return {
      graphPaused: store.get(graphPausedState),
      graphRunHistoryByView: store.get(graphRunHistoryByViewState),
      graphRunning: store.get(graphRunningState),
      graphStartTime: store.get(graphStartTimeState),
      frozenNodeOutputs: store.get(frozenNodeOutputsState),
      lastRecording: store.get(lastRecordingState),
      lastRunDataByNode: store.get(lastRunDataByNodeState),
      rootGraph: store.get(rootGraphState),
      runningGraphs: store.get(runningGraphsState),
      selectedGraphRunByView: store.get(selectedGraphRunByViewState),
      selectedProcessPageNodes: store.get(selectedProcessPageNodesState),
      userInputQuestions: store.get(userInputModalQuestionsState),
    };
  }, [store]);

  const restoreProjectExecutionSnapshot = useCallback(
    (snapshot: ProjectExecutionSnapshot | undefined) => {
      const nextSnapshot = snapshot ?? createEmptyProjectExecutionSnapshot();

      store.set(graphPausedState, nextSnapshot.graphPaused);
      store.set(graphRunHistoryByViewState, nextSnapshot.graphRunHistoryByView);
      store.set(graphRunningState, nextSnapshot.graphRunning);
      store.set(graphStartTimeState, nextSnapshot.graphStartTime);
      store.set(frozenNodeOutputsState, nextSnapshot.frozenNodeOutputs ?? {});
      store.set(lastRecordingState, nextSnapshot.lastRecording);
      store.set(lastRunDataByNodeState, nextSnapshot.lastRunDataByNode);
      store.set(rootGraphState, nextSnapshot.rootGraph);
      store.set(runningGraphsState, nextSnapshot.runningGraphs);
      store.set(selectedGraphRunByViewState, nextSnapshot.selectedGraphRunByView);
      store.set(selectedProcessPageNodesState, nextSnapshot.selectedProcessPageNodes);
      store.set(userInputModalQuestionsState, nextSnapshot.userInputQuestions ?? {});
    },
    [store],
  );

  const persistCurrentProjectExecutionSnapshot = useCallback(
    (projectId: ProjectId | undefined) => {
      if (!projectId) {
        return undefined;
      }

      const snapshot = captureCurrentProjectExecutionSnapshot();
      setProjectExecutionSnapshots((previousSnapshots) => ({
        ...previousSnapshots,
        [projectId]: snapshot,
      }));
      return snapshot;
    },
    [captureCurrentProjectExecutionSnapshot, setProjectExecutionSnapshots],
  );

  const removeProjectExecutionSnapshot = useCallback(
    (projectId: ProjectId, options: { currentSnapshot?: ProjectExecutionSnapshot } = {}) => {
      const snapshot = options.currentSnapshot ?? store.get(projectExecutionSnapshotsState)[projectId];
      if (snapshot) {
        clearExecutionDataRefs(dataRefs, snapshot.lastRunDataByNode);
      }

      setProjectExecutionSnapshots((previousSnapshots) => {
        if (!previousSnapshots[projectId]) {
          return previousSnapshots;
        }

        const nextSnapshots = { ...previousSnapshots };
        delete nextSnapshots[projectId];
        return nextSnapshots;
      });
    },
    [dataRefs, setProjectExecutionSnapshots, store],
  );

  return {
    captureCurrentProjectExecutionSnapshot,
    persistCurrentProjectExecutionSnapshot,
    removeProjectExecutionSnapshot,
    restoreProjectExecutionSnapshot,
  };
}

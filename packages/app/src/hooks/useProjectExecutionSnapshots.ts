import { type ProjectId } from '@valerypopoff/rivet2-core';
import { useCallback } from 'react';
import { useSetAtom, useStore } from 'jotai';
import { projectExecutionSnapshotsState, type ProjectExecutionSnapshot } from '../state/dataFlow.js';
import { useDataRefs } from '../providers/ProvidersContext.js';
import { clearExecutionDataRefs } from '../utils/executionDataStorage.js';
import {
  captureProjectExecutionSnapshot,
  restoreProjectExecutionSnapshot,
} from './projectExecutionSnapshotBindings.js';

export function useProjectExecutionSnapshots() {
  const store = useStore();
  const dataRefs = useDataRefs();
  const setProjectExecutionSnapshots = useSetAtom(projectExecutionSnapshotsState);

  const captureCurrentProjectExecutionSnapshot = useCallback(() => captureProjectExecutionSnapshot(store), [store]);
  const restoreSnapshot = useCallback(
    (snapshot: ProjectExecutionSnapshot | undefined) => restoreProjectExecutionSnapshot(store, snapshot),
    [store],
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
    removeProjectExecutionSnapshot,
    restoreProjectExecutionSnapshot: restoreSnapshot,
  };
}

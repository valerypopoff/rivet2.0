import { useEffect, useMemo } from 'react';
import { useStore } from 'jotai';
import type { ProcessEventMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import { useDataRefs } from '../providers/ProvidersContext.js';
import { projectsState } from '../state/savedGraphs.js';
import { projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { getLoadedRecordingForTab, loadedRecordingState } from '../state/execution.js';
import {
  getProjectRemoteObservations,
  isProjectObservingRemote,
  remoteObservationsState,
} from '../state/remoteObservation.js';
import { projectBindingRegistryState, retireWorkspaceExecutionState } from '../state/projectBindings.js';
import { localExecutionObservationState } from '../state/executionObservation.js';
import { updateOpenProjectExecutionSnapshot } from './projectExecutionSnapshotRouting.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
import { handleError } from '../utils/errorHandling.js';
import { previousDataPerNodeToKeepState } from '../state/settings.js';
import type { ExecutionSourceKind } from '../domain/execution/executionEventNormalization.js';
import { settleProjectExecutionObservation } from './projectExecutionObservationSettlement.js';

/** One workspace display coordinator, shared by browser and Node ingress hooks. */
export function useBundleExecutionRouting() {
  const store = useStore();
  const refStore = useDataRefs();
  const state = store.get(localExecutionObservationState);
  const options = useMemo(
    () => ({
      bindings() {
        store.get(projectsState);
        return store.get(projectBindingRegistryState).capture();
      },
      conflict(id: ProjectId) {
        const info = store.get(projectsState).openedProjects[id];
        return Boolean(
          getLoadedRecordingForTab(store.get(loadedRecordingState), id, info?.fsPath) ||
            isProjectObservingRemote(getProjectRemoteObservations(store.get(remoteObservationsState), id), id) ||
            store.get(projectExecutionSnapshotsState)[id]?.graphRunning,
        );
      },
      settle(id: ProjectId, root: string, status: 'completed' | 'error' | 'aborted', token: number) {
        try {
          updateOpenProjectExecutionSnapshot(
            store,
            id,
            (snapshot) => settleProjectExecutionObservation(snapshot, root, status),
            token,
          );
        } catch (error) {
          handleError(error, 'Failed to finish bundle execution display', { toastError: false });
        }
      },
      project<K extends keyof ProcessEventMessageMap>(
        id: ProjectId,
        message: K,
        data: ProcessEventMessageMap[K],
        activityData: ProcessEventMessageMap[K] | false,
        token: number,
      ) {
        try {
          updateOpenProjectExecutionSnapshot(
            store,
            id,
            (snapshot) => {
              const result = applyProcessEventToProjectExecutionSnapshot({
                message,
                data,
                activityData,
                projectId: id,
                refStore,
                snapshot,
                previousDataPerNodeToKeep: store.get(previousDataPerNodeToKeepState),
              });
              return result.changed ? result.snapshot : snapshot;
            },
            token,
          );
        } catch (error) {
          handleError(error, 'Failed to display bundle execution data', { toastError: false });
        }
      },
    }),
    [store, refStore],
  );
  useEffect(() => {
    state.users++;
    const reconcile = () => state.router.reconcile(options);
    const unsubscribe = [
      projectExecutionSnapshotsState,
      loadedRecordingState,
      remoteObservationsState,
      projectsState,
    ].map((atom) => store.sub(atom, reconcile));
    return () => {
      unsubscribe.forEach((stop) => stop());
      if (--state.users === 0) {
        state.router.dispose(options);
        store.set(retireWorkspaceExecutionState);
      }
    };
  }, [store, state, options]);
  return useMemo(
    () =>
      Object.assign(
        <K extends keyof ProcessEventMessageMap>(
          entryId: ProjectId,
          message: K,
          data: ProcessEventMessageMap[K],
          source?: object,
          kind?: ExecutionSourceKind,
        ) => {
          state.router.receive(entryId, message, data, options, source, kind);
        },
        { settle: (source: object) => state.router.settle(source, options) },
      ),
    [state, options],
  );
}

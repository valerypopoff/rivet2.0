import { useEffect, useMemo } from 'react';
import { useStore } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { ExecutorSessionRegistry } from '../providers/ExecutorSessionContext.js';
import { useDataRefs } from '../providers/ProvidersContext.js';
import {
  projectState,
  projectsState,
  openedProjectSnapshotsState,
  projectUnsavedChangesState,
} from '../state/savedGraphs.js';
import { projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { executorSessionRevisionState, loadedRecordingState, getLoadedRecordingForTab } from '../state/execution.js';
import { previousDataPerNodeToKeepState } from '../state/settings.js';
import {
  getProjectRemoteObservations,
  remoteObservationsState,
  remoteObservationNoticesState,
} from '../state/remoteObservation.js';
import { createRemoteExecutionObservationRouter } from './remoteExecutionObservation.js';
import { updateOpenProjectExecutionSnapshot } from './projectExecutionSnapshotRouting.js';
import { projectRemoteExecutionEvent } from './remoteExecutionProjection.js';
import { handleError } from '../utils/errorHandling.js';
import { settleProjectExecutionObservation } from './projectExecutionObservationSettlement.js';
import { projectBindingRegistryState } from '../state/projectBindings.js';
import { executionObservationCoordinatorState } from '../state/executionObservation.js';

export function useRemoteExecutionObservations(registry: ExecutorSessionRegistry) {
  const store = useStore();
  const refStore = useDataRefs();
  const router = useMemo(() => {
    const receivers = () => {
      store.get(projectsState);
      return new Map(
        [...store.get(projectBindingRegistryState).capture()].map(([id, binding]) => [id as ProjectId, binding]),
      );
    };
    const notice = (id: ProjectId, message: string | undefined) => {
      if (message && !registry.getRemoteDebuggerRuntime(id)) return;
      const previous = store.get(remoteObservationNoticesState);
      if (previous[id] === message) return;
      const next: typeof previous = { ...previous, [id]: message };
      if (message === undefined) delete next[id];
      store.set(remoteObservationNoticesState, next);
    };
    return createRemoteExecutionObservationRouter({
      coordinator: store.get(executionObservationCoordinatorState),
      eligible(id, source) {
        return registry.getRemoteDebuggerRuntime(id) === source;
      },
      receivers,
      conflict(id, source) {
        const info = store.get(projectsState).openedProjects[id];
        if (getLoadedRecordingForTab(store.get(loadedRecordingState), id, info?.fsPath))
          return 'Recording playback owns this tab. Observe the next remote run after unloading it.';
        const runtime = registry.getRemoteDebuggerRuntime(id) ?? registry.getRuntime(id);
        if (runtime !== source && runtime.getRuntimeState().target?.type === 'external-debugger')
          return 'An independent Remote Debugger owns this tab.';
        if (runtime === source) return undefined;
        const ownRun = store.get(projectExecutionSnapshotsState)[id]?.graphRunning;
        if (ownRun || runtime.getActiveGraphRunRequestId())
          return 'A local execution owns this tab. Observe the next remote run after it finishes.';
        return undefined;
      },
      publish(id, observation) {
        store.set(remoteObservationsState, (previous) => ({
          ...previous,
          [id]: [
            ...getProjectRemoteObservations(previous, id).filter((item) => item.id !== observation.id),
            observation,
          ],
        }));
      },
      remove(id, observationId) {
        const previous = store.get(remoteObservationsState);
        const observations = getProjectRemoteObservations(previous, id);
        if (!observations.some((item) => item.id === observationId)) return;
        const remaining = observations.filter((item) => item.id !== observationId);
        const next = { ...previous };
        if (remaining.length) next[id] = remaining;
        else delete next[id];
        store.set(remoteObservationsState, next);
        if (!remaining.length) notice(id, undefined);
      },
      notice,
      project(id, message, data, activityData, bindingToken) {
        try {
          updateOpenProjectExecutionSnapshot(
            store,
            id,
            (snapshot) => {
              const project =
                store.get(projectState).metadata.id === id
                  ? store.get(projectState)
                  : store.get(openedProjectSnapshotsState)[id]?.project;
              return projectRemoteExecutionEvent({
                project,
                dirty: !!store.get(projectUnsavedChangesState)[id],
                notice: (message) => notice(id, message),
                clearFrozenOnGraphStart: true,
                message,
                data,
                activityData,
                activityOnly: message === 'userInput',
                projectId: id,
                snapshot,
                refStore,
                previousDataPerNodeToKeep: store.get(previousDataPerNodeToKeepState),
              });
            },
            bindingToken,
          );
        } catch (error) {
          handleError(error, 'Failed to display remote dependency data', { toastError: false });
        }
      },
      settle(id, rootRunId, status) {
        try {
          updateOpenProjectExecutionSnapshot(store, id, (snapshot) =>
            settleProjectExecutionObservation(snapshot, rootRunId, status),
          );
        } catch (error) {
          handleError(error, 'Failed to finish remote dependency display', { toastError: false });
        }
      },
    });
  }, [store, refStore, registry]);
  useEffect(() => {
    const reconcile = () => router.reconcileOwnership();
    const unsubscribeOwners = [
      projectsState,
      projectExecutionSnapshotsState,
      loadedRecordingState,
      executorSessionRevisionState,
    ].map((state) => store.sub(state, reconcile));
    return () => {
      for (const unsubscribe of unsubscribeOwners) unsubscribe();
    };
  }, [router, store]);
  useEffect(() => () => router.dispose(), [router]);
  return router;
}

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
import { remoteObservationsState, remoteObservationNoticesState } from '../state/remoteObservation.js';
import { createRemoteExecutionObservationRouter } from './remoteExecutionObservation.js';
import { updateOpenProjectExecutionSnapshot } from './projectExecutionSnapshotRouting.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
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
      const next = { ...previous };
      if (message === undefined) delete next[id];
      else next[id] = message;
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
          [id]: [...(previous[id] ?? []).filter((item) => item.id !== observation.id), observation],
        }));
      },
      remove(id, observationId) {
        const previous = store.get(remoteObservationsState);
        if (!previous[id]?.some((item) => item.id === observationId)) return;
        const remaining = previous[id]!.filter((item) => item.id !== observationId);
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
              const event = data as {
                execution?: { graphId: string };
                node?: { id: string };
                graph?: { nodes: unknown[]; connections: unknown[] };
              };
              const graph = project?.graphs[event.execution?.graphId as keyof typeof project.graphs];
              if (!graph || (event.node && !graph.nodes.some((node) => node.id === event.node!.id))) {
                notice(
                  id,
                  'The runtime graph differs from this editor. Missing graph/node data is not painted; save or open the matching project version.',
                );
                return snapshot;
              }
              if (
                message === 'graphStart' &&
                (store.get(projectUnsavedChangesState)[id] ||
                  JSON.stringify([graph.nodes, graph.connections]) !==
                    JSON.stringify([event.graph?.nodes, event.graph?.connections]))
              )
                notice(
                  id,
                  'The runtime uses a saved graph that may differ from the current editor. Unsaved definitions were not changed.',
                );
              const result = applyProcessEventToProjectExecutionSnapshot({
                message,
                data,
                activityData,
                activityOnly: message === 'userInput',
                projectId: id,
                snapshot,
                refStore,
                previousDataPerNodeToKeep: store.get(previousDataPerNodeToKeepState),
              });
              // Do not acquire graphRunning ownership. Preserve the existing flag
              // (including an explicit source's own run on A → B → A return calls).
              return message === 'graphStart' ? { ...result.snapshot, frozenNodeOutputs: {} } : result.snapshot;
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

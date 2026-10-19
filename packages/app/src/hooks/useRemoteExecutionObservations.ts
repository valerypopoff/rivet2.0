import { useEffect, useMemo } from 'react';
import { useStore } from 'jotai';
import { produce } from 'immer';
import type { ProjectId, RootRunId } from '@valerypopoff/rivet2-core';
import type { ExecutorSessionRegistry } from '../providers/ExecutorSessionContext.js';
import { useDataRefs } from '../providers/ProvidersContext.js';
import {
  projectState,
  projectsState,
  openedProjectSnapshotsState,
  projectUnsavedChangesState,
} from '../state/savedGraphs.js';
import { graphRunningState, projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { executorSessionRevisionState, loadedRecordingState, getLoadedRecordingForTab } from '../state/execution.js';
import { previousDataPerNodeToKeepState } from '../state/settings.js';
import { remoteObservationsState, remoteObservationNoticesState } from '../state/remoteObservation.js';
import { createRemoteExecutionObservationRouter } from './remoteExecutionObservation.js';
import { updateOpenProjectExecutionSnapshot } from './projectExecutionSnapshotRouting.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
import {
  interruptRunningProcesses,
  reconcileRunningProcessesAfterSuccessfulDone,
  removeRunningGraphEntry,
} from './graphExecutionEventHelpers.js';
import { handleError } from '../utils/errorHandling.js';
import { settleObservedRunActivityRoot } from '../features/runActivity/runActivityJournal.js';

export function useRemoteExecutionObservations(registry: ExecutorSessionRegistry) {
  const store = useStore();
  const refStore = useDataRefs();
  const router = useMemo(() => {
    let serial = 0;
    const lifetimes = new Map<ProjectId, { token: number; path: string | null | undefined }>();
    const receivers = () => {
      const opened = store.get(projectsState).openedProjects;
      for (const id of lifetimes.keys()) if (!opened[id]) lifetimes.delete(id);
      for (const [id, info] of Object.entries(opened))
        if (lifetimes.get(id as ProjectId)?.path !== info.fsPath || !lifetimes.has(id as ProjectId))
          lifetimes.set(id as ProjectId, { token: ++serial, path: info.fsPath });
      return new Map(lifetimes);
    };
    const notice = (id: ProjectId, message: string | undefined) => {
      const previous = store.get(remoteObservationNoticesState);
      if (previous[id] === message) return;
      const next = { ...previous };
      if (message === undefined) delete next[id];
      else next[id] = message;
      store.set(remoteObservationNoticesState, next);
    };
    return createRemoteExecutionObservationRouter({
      receivers,
      conflict(id, source) {
        const info = store.get(projectsState).openedProjects[id];
        if (getLoadedRecordingForTab(store.get(loadedRecordingState), id, info?.fsPath))
          return 'Recording playback owns this tab. Observe the next remote run after unloading it.';
        const runtime = registry.getRemoteDebuggerRuntime(id) ?? registry.getRuntime(id);
        if (runtime !== source && runtime.getRuntimeState().target?.type === 'external-debugger')
          return 'An independent Remote Debugger owns this tab.';
        if (runtime === source) return undefined;
        const ownRun =
          store.get(projectState).metadata.id === id
            ? store.get(graphRunningState)
            : store.get(projectExecutionSnapshotsState)[id]?.graphRunning;
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
      project(id, message, data, activityData) {
        try {
          updateOpenProjectExecutionSnapshot(store, id, (snapshot) => {
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
          });
        } catch (error) {
          handleError(error, 'Failed to display remote dependency data', { toastError: false });
        }
      },
      settle(id, rootRunId, status) {
        try {
          updateOpenProjectExecutionSnapshot(store, id, (snapshot) =>
            produce(snapshot, (draft) => {
              draft.runActivityJournal = settleObservedRunActivityRoot(
                snapshot.runActivityJournal,
                rootRunId as RootRunId,
                status,
              );
              draft.lastRunDataByNode =
                status === 'completed'
                  ? reconcileRunningProcessesAfterSuccessfulDone(snapshot.lastRunDataByNode, {
                      rootRunId: rootRunId as RootRunId,
                    })
                  : interruptRunningProcesses(snapshot.lastRunDataByNode, rootRunId as RootRunId);
              for (const runs of Object.values(draft.graphRunHistoryByView))
                for (const run of runs) {
                  if (run.rootRunId !== rootRunId || run.status !== 'running') continue;
                  run.status = status === 'completed' ? 'ok' : status;
                  run.finishedAt = Date.now();
                  draft.runningGraphs = removeRunningGraphEntry(draft.runningGraphs, run.graphId);
                }
            }),
          );
        } catch (error) {
          handleError(error, 'Failed to finish remote dependency display', { toastError: false });
        }
      },
    });
  }, [store, refStore, registry]);
  useEffect(() => {
    let disposed = false;
    let queued = false;
    const reconcile = () => {
      if (queued) return;
      queued = true;
      // Tab activation restores several atoms synchronously. Check ownership
      // after that boundary, not halfway through another tab's old run flags.
      queueMicrotask(() => {
        queued = false;
        if (!disposed) router.reconcileOwnership();
      });
    };
    const unsubscribeProjects = store.sub(projectsState, () => {
      router.sweep();
      reconcile();
    });
    const unsubscribeOwners = [graphRunningState, loadedRecordingState, executorSessionRevisionState].map((state) =>
      store.sub(state, reconcile),
    );
    return () => {
      disposed = true;
      unsubscribeProjects();
      for (const unsubscribe of unsubscribeOwners) unsubscribe();
    };
  }, [router, store]);
  useEffect(() => () => router.dispose(), [router]);
  return router;
}

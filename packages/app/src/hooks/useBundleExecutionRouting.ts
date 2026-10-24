import { useEffect, useRef } from 'react';
import { useStore } from 'jotai';
import type { GraphExecutionMetadata, ProcessEventMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import { useStableCallback } from './useStableCallback.js';
import { useDataRefs } from '../providers/ProvidersContext.js';
import { projectsState, projectState } from '../state/savedGraphs.js';
import { graphRunningState, projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { getLoadedRecordingForTab, loadedRecordingState } from '../state/execution.js';
import { isProjectObservingRemote, remoteObservationsState } from '../state/remoteObservation.js';
import { updateOpenProjectExecutionSnapshot } from './projectExecutionSnapshotRouting.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
import { handleError } from '../utils/errorHandling.js';
import { previousDataPerNodeToKeepState } from '../state/settings.js';
import { getRemoteDebuggerBundleKey } from './remoteDebuggerBundle.js';

type BundleDisplayRun = {
  entryId: ProjectId;
  bundleKey: string;
  receivers: Map<ProjectId, string | null | undefined>;
  owners: Map<string, ProjectId>;
  blocked: Set<ProjectId>;
};

/** Display projection only. Run ownership, cancellation and recording stay with the entry tab. */
export function useBundleExecutionRouting() {
  const store = useStore();
  const refStore = useDataRefs();
  const runs = useRef(new Map<string, BundleDisplayRun>());
  const hasCurrentBinding = useStableCallback((run: BundleDisplayRun, id: ProjectId) => {
    const info = store.get(projectsState).openedProjects[id];
    return (
      run.receivers.has(id) &&
      Boolean(info) &&
      info?.fsPath === run.receivers.get(id) &&
      getRemoteDebuggerBundleKey(info) === run.bundleKey
    );
  });
  const hasConflict = useStableCallback((id: ProjectId) => {
    const active = store.get(projectState).metadata.id === id;
    const info = store.get(projectsState).openedProjects[id];
    return Boolean(
      getLoadedRecordingForTab(store.get(loadedRecordingState), id, info?.fsPath) ||
        isProjectObservingRemote(store.get(remoteObservationsState)[id] ?? [], id) ||
        (active ? store.get(graphRunningState) : store.get(projectExecutionSnapshotsState)[id]?.graphRunning),
    );
  });
  useEffect(() => {
    // Ownership/bindings can come and go while a child waits without emitting events.
    // Record that interruption synchronously instead of joining again afterward.
    const reconcile = () => {
      for (const run of runs.current.values()) {
        for (const id of run.receivers.keys())
          if (!hasCurrentBinding(run, id) || (id !== run.entryId && hasConflict(id))) run.blocked.add(id);
      }
    };
    const unsubscribe = [
      store.sub(graphRunningState, reconcile),
      store.sub(projectExecutionSnapshotsState, reconcile),
      store.sub(loadedRecordingState, reconcile),
      store.sub(remoteObservationsState, reconcile),
      store.sub(projectsState, reconcile),
    ];
    return () => unsubscribe.forEach((stop) => stop());
  }, [store, hasConflict, hasCurrentBinding]);
  return useStableCallback(
    <K extends keyof ProcessEventMessageMap>(entryId: ProjectId, message: K, data: ProcessEventMessageMap[K]) => {
      const event = data as { execution?: GraphExecutionMetadata; replayRecordedAt?: number };
      if (Number.isFinite(event.replayRecordedAt)) return;
      const execution = event.execution;
      if (!execution?.projectId) return;
      // Browser done/error events have no execution metadata. The root graph's
      // identified terminal event retires its display bookkeeping instead.
      if (
        execution.projectId === entryId &&
        !execution.parentGraphRunId &&
        ['graphFinish', 'graphError', 'done', 'error'].includes(message)
      ) {
        runs.current.delete(execution.rootRunId);
        return;
      }
      let run = runs.current.get(execution.rootRunId);
      if (!run) {
        // Only the entry's root start captures receivers. A child start can be
        // late (including error unwinding), and must never resurrect a closed run.
        if (
          (message !== 'start' && message !== 'graphStart') ||
          execution.projectId !== entryId ||
          execution.parentGraphRunId
        )
          return;
        const opened = store.get(projectsState).openedProjects;
        const bundleKey = getRemoteDebuggerBundleKey(opened[entryId]);
        if (!bundleKey) return;
        run = {
          entryId,
          bundleKey,
          receivers: new Map(
            Object.entries(opened)
              .filter(([, info]) => getRemoteDebuggerBundleKey(info) === bundleKey)
              .map(([id, info]) => [id as ProjectId, info.fsPath]),
          ),
          owners: new Map(),
          blocked: new Set(),
        };
        // Protect an independent display even if its owner finishes before this
        // root reaches the dependency for the first time.
        for (const id of run.receivers.keys()) if (id !== entryId && hasConflict(id)) run.blocked.add(id);
        // Retain every live root's fences until its identified terminal event.
        // Evicting an active root under pressure would permit partial re-admission.
        runs.current.set(execution.rootRunId, run);
      }
      if (run.entryId !== entryId || run.blocked.has(entryId)) return;
      if (!hasCurrentBinding(run, entryId)) {
        run.blocked.add(entryId);
        return;
      }
      if (!hasCurrentBinding(run, execution.projectId)) {
        run.blocked.add(execution.projectId);
        return;
      }
      const { owners, blocked } = run;
      const parentOwner = execution.parentGraphRunId ? owners.get(execution.parentGraphRunId) : undefined;
      owners.set(execution.graphRunId, execution.projectId);
      // The entry's own ordinary events already have their normal dispatcher.
      if (execution.projectId === entryId && !execution.projectScope) return;
      if (
        message === 'userInput' ||
        message === 'start' ||
        message === 'done' ||
        message === 'error' ||
        message === 'abort'
      )
        return;
      const projected = {
        ...(data as object),
        execution: {
          ...execution,
          projectScope: undefined,
          ...(parentOwner !== execution.projectId ? { parentGraphRunId: undefined, executor: undefined } : {}),
        },
      } as ProcessEventMessageMap[K];
      const id = execution.projectId;
      // Passive local data cannot replace a live run, recording or remote observer.
      if (id !== entryId && hasConflict(id)) blocked.add(id);
      // Do not join midway through a run after another owner releases this tab.
      if (blocked.has(id)) return;
      try {
        updateOpenProjectExecutionSnapshot(store, id, (snapshot) => {
          const result = applyProcessEventToProjectExecutionSnapshot({
            message,
            data: projected,
            projectId: id,
            refStore,
            snapshot,
            previousDataPerNodeToKeep: store.get(previousDataPerNodeToKeepState),
          });
          return result.changed ? result.snapshot : snapshot;
        });
      } catch (error) {
        // A display observer must not fail the root processor or its recording.
        handleError(error, 'Failed to display bundle execution data', { toastError: false });
      }
    },
  );
}

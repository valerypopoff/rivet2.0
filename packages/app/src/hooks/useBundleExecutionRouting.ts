import { useRef } from 'react';
import { useStore } from 'jotai';
import type { GraphExecutionMetadata, ProcessEventMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import { useStableCallback } from './useStableCallback.js';
import { useDataRefs } from '../providers/ProvidersContext.js';
import { projectsState, projectState } from '../state/savedGraphs.js';
import { projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { useProjectExecutionSnapshots } from './useProjectExecutionSnapshots.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
import { handleError } from '../utils/errorHandling.js';

/** Display projection only. Run ownership, cancellation and recording stay with the entry tab. */
export function useBundleExecutionRouting() {
  const store = useStore();
  const refStore = useDataRefs();
  const { captureCurrentProjectExecutionSnapshot, restoreProjectExecutionSnapshot } = useProjectExecutionSnapshots();
  const runs = useRef(new Map<string, Map<string, ProjectId>>());
  return useStableCallback(
    <K extends keyof ProcessEventMessageMap>(entryId: ProjectId, message: K, data: ProcessEventMessageMap[K]) => {
      const event = data as { execution?: GraphExecutionMetadata; replayRecordedAt?: number };
      if (Number.isFinite(event.replayRecordedAt)) return;
      const execution = event.execution;
      if (!execution?.projectId) return;
      const opened = store.get(projectsState).openedProjects;
      const bundle = opened[entryId]?.bundleManifestPath;
      if (!bundle || opened[execution.projectId]?.bundleManifestPath !== bundle) return;
      let owners = runs.current.get(execution.rootRunId);
      if (!owners) {
        if (runs.current.size >= 32) runs.current.delete(runs.current.keys().next().value!);
        owners = new Map();
        runs.current.set(execution.rootRunId, owners);
      }
      const parentOwner = execution.parentGraphRunId ? owners.get(execution.parentGraphRunId) : undefined;
      owners.set(execution.graphRunId, execution.projectId);
      if (message === 'done' || message === 'error') runs.current.delete(execution.rootRunId);
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
      const active = store.get(projectState).metadata.id === id;
      const snapshot = active
        ? captureCurrentProjectExecutionSnapshot()
        : store.get(projectExecutionSnapshotsState)[id];
      try {
        const result = applyProcessEventToProjectExecutionSnapshot({
          message,
          data: projected,
          projectId: id,
          refStore,
          snapshot,
        });
        if (!result.changed) return;
        store.set(projectExecutionSnapshotsState, (previous) => ({ ...previous, [id]: result.snapshot }));
        if (active) restoreProjectExecutionSnapshot(result.snapshot);
      } catch (error) {
        // A display observer must not fail the root processor or its recording.
        handleError(error, 'Failed to display bundle execution data', { toastError: false });
      }
    },
  );
}

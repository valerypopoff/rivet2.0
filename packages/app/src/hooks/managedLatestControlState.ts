import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { createStore } from 'jotai';
import type { ExecutorSessionRegistry } from '../providers/ExecutorSessionContext.js';
import { executionObservationCoordinatorState } from '../state/executionObservation.js';
import { projectBindingRegistryState } from '../state/projectBindings.js';
import { getLoadedRecordingForTab, loadedRecordingState } from '../state/execution.js';
import { projectsState } from '../state/savedGraphs.js';
import { projectExecutionSnapshotsState } from '../state/dataFlow.js';
import type { ExecutorSessionRuntime } from './executorSession.js';
import { getLatestRunControlPolicy } from './latestDebuggerRuns.js';

export function hasManagedLatestReceiverConflict(
  store: ReturnType<typeof createStore>,
  registry: ExecutorSessionRegistry,
  runtime: ExecutorSessionRuntime,
  projectId: ProjectId,
  previousDisplayRoot?: string,
) {
  const info = store.get(projectsState).openedProjects[projectId];
  const snapshot = store.get(projectExecutionSnapshotsState)[projectId];
  const displayedRoot = snapshot?.runActivityJournal?.rootOrder.at(-1);
  return (
    registry.getRemoteDebuggerRuntime(projectId) !== runtime ||
    !!getLoadedRecordingForTab(store.get(loadedRecordingState), projectId, info?.fsPath) ||
    !!(
      snapshot?.graphRunning &&
      displayedRoot &&
      displayedRoot !== previousDisplayRoot &&
      !runtime.getLatestDebuggerState()?.runs.some((item) => item.scope.rootRunId === displayedRoot)
    )
  );
}

/** Lifecycle comes from the root catalogue; authority comes from original admission.
 * Neither depends on whether a retained canvas still contains its start event. */
export function getManagedLatestControlState(
  store: ReturnType<typeof createStore>,
  registry: ExecutorSessionRegistry,
  runtime: ExecutorSessionRuntime,
  projectId: ProjectId,
  targetKey?: string,
) {
  const session = runtime.getRuntimeState();
  if (session.connection.kind !== 'managed-latest') return undefined;
  const state = runtime.getLatestDebuggerState();
  const run = state?.runs.find((item) => item.key === (targetKey ?? state.selected));
  // Reading projects reconciles the existing binding registry before lookup.
  store.get(projectsState);
  const admission = run && store.get(executionObservationCoordinatorState).get(runtime, run.key);
  const ownsControls =
    !!run &&
    !!admission &&
    admission.sourceProjectId === projectId &&
    admission.receivers.has(projectId) &&
    !admission.blocked.has(projectId) &&
    admission.receivers.get(projectId)?.token === store.get(projectBindingRegistryState).get(projectId)?.token &&
    !hasManagedLatestReceiverConflict(store, registry, runtime, projectId);
  const policy = run && getLatestRunControlPolicy(run);
  const graphRunning = ownsControls && !!policy?.running;
  // Captured prompts may belong to a different root than the current picker.
  // Transport readiness is shared, but action validity belongs to this target.
  const ready = session.connection.protocol === 2 && runtime.isReady();
  return {
    readOnly: !ownsControls,
    graphRunning,
    graphPaused: graphRunning && !!policy?.paused,
    canSendAbort: ownsControls && ready && !!policy?.canAbort,
    canSendPause: ownsControls && ready && !!policy?.canPause,
    canSendResume: ownsControls && ready && !!policy?.canResume,
  };
}

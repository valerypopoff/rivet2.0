import type { ProcessEventMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
import { type createStore } from 'jotai';
import { projectState, projectsState } from '../state/savedGraphs.js';
import { projectBindingRegistryState } from '../state/projectBindings.js';
import { emptyExecutionSnapshotState } from '../state/projectExecutionStore.js';
import { projectExecutionSnapshotsState, type ProjectExecutionSnapshot } from '../state/dataFlow.js';

/** One synchronous display boundary: reference effects run once, and closed tabs cannot be recreated. */
export function updateOpenProjectExecutionSnapshot(
  store: ReturnType<typeof createStore>,
  projectId: ProjectId,
  update: (snapshot: ProjectExecutionSnapshot) => ProjectExecutionSnapshot,
  bindingToken?: number,
  allowStandaloneActive = false,
): void {
  if (
    !store.get(projectsState).openedProjects[projectId] &&
    !(allowStandaloneActive && store.get(projectState).metadata.id === projectId)
  )
    return;
  if (bindingToken !== undefined && !store.get(projectBindingRegistryState).isCurrent(projectId, bindingToken)) return;
  const before = store.get(projectExecutionSnapshotsState)[projectId] ?? store.get(emptyExecutionSnapshotState);
  const after = update(before);
  if (before === after) return;
  store.set(projectExecutionSnapshotsState, { ...store.get(projectExecutionSnapshotsState), [projectId]: after });
}

/** Evaluation trials journal to their captured owner, never whichever tab is selected later. */
export function captureProjectExecutionActivity(
  store: ReturnType<typeof createStore>,
  projectId: ProjectId,
  refStore: DataRefStore,
) {
  store.get(projectsState);
  const registry = store.get(projectBindingRegistryState);
  const bindingToken = registry.get(projectId)?.token;
  const workspaceToken = registry.getWorkspaceToken();
  const isCurrent = () => {
    store.get(projectsState);
    return (
      registry.getWorkspaceToken() === workspaceToken &&
      (bindingToken === undefined
        ? registry.get(projectId) === undefined && store.get(projectState).metadata.id === projectId
        : registry.isCurrent(projectId, bindingToken))
    );
  };
  return {
    isCurrent,
    event<K extends keyof ProcessEventMessageMap>(message: K, data: ProcessEventMessageMap[K]): void {
      if (!isCurrent()) return;
      updateOpenProjectExecutionSnapshot(
        store,
        projectId,
        (snapshot) =>
          applyProcessEventToProjectExecutionSnapshot({
            snapshot,
            projectId,
            refStore,
            message,
            data,
            activityOnly: true,
          }).snapshot,
        bindingToken,
        true,
      );
    },
  };
}

/** Interactive adapters select a view; data and refs still commit at the same boundary. */
export function updateCurrentProjectExecutionSnapshot(
  store: ReturnType<typeof createStore>,
  update: (snapshot: ProjectExecutionSnapshot) => ProjectExecutionSnapshot,
): void {
  const id = store.get(projectState).metadata.id;
  store.get(projectsState);
  updateOpenProjectExecutionSnapshot(store, id, update, store.get(projectBindingRegistryState).get(id)?.token, true);
}

/** Selection policy belongs here, not in Browser/Node transport callbacks. */
export function routeProjectExecutionDisplay<K extends keyof ProcessEventMessageMap>(options: {
  store: ReturnType<typeof createStore>;
  projectId: ProjectId;
  message: K;
  data: ProcessEventMessageMap[K];
  refStore: DataRefStore;
  previousDataPerNodeToKeep?: number;
  interactive?: () => void;
  mapSnapshot?: (snapshot: ProjectExecutionSnapshot) => ProjectExecutionSnapshot;
  onInactive?: () => void;
  shouldApply?: (snapshot: ProjectExecutionSnapshot) => boolean;
}): void {
  if (options.store.get(projectState).metadata.id === options.projectId) {
    options.interactive?.();
    return;
  }
  options.store.get(projectsState);
  const binding = options.store.get(projectBindingRegistryState).get(options.projectId);
  if (!binding) return;
  // Request progress/accounting may synchronously close or replace its tab.
  // Complete that work first, then fence display/ref effects against its old lifetime.
  options.onInactive?.();
  updateOpenProjectExecutionSnapshot(
    options.store,
    options.projectId,
    (snapshot) => {
      if (options.shouldApply && !options.shouldApply(snapshot)) return snapshot;
      const result = applyProcessEventToProjectExecutionSnapshot({ ...options, snapshot });
      return options.mapSnapshot?.(result.snapshot) ?? result.snapshot;
    },
    binding.token,
  );
}

export function routeExecutorDisconnectDisplay(options: {
  store: ReturnType<typeof createStore>;
  projectId: ProjectId;
  refStore: DataRefStore;
  errorMessage: string;
}): void {
  routeProjectExecutionDisplay({
    ...options,
    message: 'error',
    data: { error: new Error(options.errorMessage) },
    shouldApply: (snapshot) => snapshot.graphRunning,
  });
}

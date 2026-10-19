import type { ProcessEventMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
import { type createStore } from 'jotai';
import { projectState, projectsState } from '../state/savedGraphs.js';
import {
  projectExecutionSnapshotsState,
  createEmptyProjectExecutionSnapshot,
  type ProjectExecutionSnapshot,
} from '../state/dataFlow.js';
import {
  captureProjectExecutionSnapshot,
  restoreProjectExecutionSnapshot,
} from './projectExecutionSnapshotBindings.js';

/** One synchronous display boundary: reference effects run once, and closed tabs cannot be recreated. */
export function updateOpenProjectExecutionSnapshot(
  store: ReturnType<typeof createStore>,
  projectId: ProjectId,
  update: (snapshot: ProjectExecutionSnapshot) => ProjectExecutionSnapshot,
): void {
  if (!store.get(projectsState).openedProjects[projectId]) return;
  const active = store.get(projectState).metadata.id === projectId;
  const before = active
    ? captureProjectExecutionSnapshot(store)
    : store.get(projectExecutionSnapshotsState)[projectId] ?? createEmptyProjectExecutionSnapshot();
  const after = update(before);
  if (before === after) return;
  store.set(projectExecutionSnapshotsState, { ...store.get(projectExecutionSnapshotsState), [projectId]: after });
  if (active) restoreProjectExecutionSnapshot(store, after, before);
}

export type ProjectExecutionSnapshots = Record<ProjectId, ProjectExecutionSnapshot | undefined>;

export function shouldRouteProjectEventToSnapshot(options: {
  activeProjectId: ProjectId | undefined;
  isProjectOpen: boolean;
  projectId: ProjectId;
}): boolean {
  return options.activeProjectId !== options.projectId && options.isProjectOpen;
}

export function applyProcessEventToProjectExecutionSnapshots<K extends keyof ProcessEventMessageMap>(options: {
  data: ProcessEventMessageMap[K];
  mapSnapshot?: (snapshot: ProjectExecutionSnapshot) => ProjectExecutionSnapshot;
  message: K;
  projectId: ProjectId;
  refStore: DataRefStore;
  snapshots: ProjectExecutionSnapshots;
  previousDataPerNodeToKeep?: number;
}): ProjectExecutionSnapshots {
  const result = applyProcessEventToProjectExecutionSnapshot({
    data: options.data,
    message: options.message,
    projectId: options.projectId,
    refStore: options.refStore,
    snapshot: options.snapshots[options.projectId],
    previousDataPerNodeToKeep: options.previousDataPerNodeToKeep,
  });
  const nextSnapshot = options.mapSnapshot?.(result.snapshot) ?? result.snapshot;

  if (!result.changed && nextSnapshot === result.snapshot) {
    return options.snapshots;
  }

  return {
    ...options.snapshots,
    [options.projectId]: nextSnapshot,
  };
}

export function applyExecutorDisconnectToProjectExecutionSnapshots(options: {
  errorMessage: string;
  projectId: ProjectId;
  refStore: DataRefStore;
  snapshots: ProjectExecutionSnapshots;
}): ProjectExecutionSnapshots {
  const snapshot = options.snapshots[options.projectId];
  if (!snapshot?.graphRunning) {
    return options.snapshots;
  }

  return applyProcessEventToProjectExecutionSnapshots({
    data: { error: new Error(options.errorMessage) } as ProcessEventMessageMap['error'],
    message: 'error',
    projectId: options.projectId,
    refStore: options.refStore,
    snapshots: options.snapshots,
  });
}

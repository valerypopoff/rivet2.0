import type { ProcessEventMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import type { ProjectExecutionSnapshot } from '../state/dataFlow.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';

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
}): ProjectExecutionSnapshots {
  const result = applyProcessEventToProjectExecutionSnapshot({
    data: options.data,
    message: options.message,
    projectId: options.projectId,
    refStore: options.refStore,
    snapshot: options.snapshots[options.projectId],
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

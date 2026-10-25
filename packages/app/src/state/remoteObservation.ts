import { atom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { RemoteObservation } from '../hooks/remoteExecutionObservation.js';
import { projectState } from './savedGraphs.js';

/** Transient display provenance only; never persisted with project executor preferences. */
export const remoteObservationsState = atom<Record<ProjectId, RemoteObservation[]>>({});
export const remoteObservationNoticesState = atom<Record<ProjectId, string | undefined>>({});
export function getProjectRemoteObservations(
  observations: Record<ProjectId, RemoteObservation[]>,
  id: ProjectId,
): RemoteObservation[] {
  return Object.hasOwn(observations, id) ? observations[id] ?? [] : [];
}
export function isProjectObservingRemote(observations: RemoteObservation[], projectId: ProjectId): boolean {
  return observations.some((item) => item.sourceProjectId !== projectId && item.status !== 'blocked');
}
export const currentRemoteObservationsState = atom((get) => {
  const id = get(projectState).metadata.id;
  return getProjectRemoteObservations(get(remoteObservationsState), id).filter((item) => item.sourceProjectId !== id);
});
export const remoteObservationReadOnlyState = atom((get) =>
  isProjectObservingRemote(get(currentRemoteObservationsState), get(projectState).metadata.id),
);

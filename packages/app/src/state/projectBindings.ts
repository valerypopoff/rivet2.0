import { atom } from 'jotai';
import { createProjectBindingRegistry } from '../domain/execution/projectBindingRegistry.js';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { executionSnapshotsState } from './projectExecutionSnapshot.js';
import { retireProjectExecutionDisplay } from '../hooks/projectExecutionObservationSettlement.js';

// A read-created object is cached per Jotai store, unlike atom(new Registry()).
export const projectBindingRegistryState = atom(() => createProjectBindingRegistry());
export const renewProjectBindingState = atom(null, (get, set, id: ProjectId) => {
  get(projectBindingRegistryState).renew(id);
  const snapshots = get(executionSnapshotsState);
  if (snapshots[id])
    set(executionSnapshotsState, { ...snapshots, [id]: retireProjectExecutionDisplay(snapshots[id]!) });
});

/** Final ingress release fences callbacks without deleting retained display data. */
export const retireWorkspaceExecutionState = atom(null, (get, set) => {
  get(projectBindingRegistryState).invalidateWorkspace();
  const snapshots = get(executionSnapshotsState);
  set(
    executionSnapshotsState,
    Object.fromEntries(
      Object.entries(snapshots).map(([id, snapshot]) => [id, snapshot && retireProjectExecutionDisplay(snapshot)]),
    ),
  );
});

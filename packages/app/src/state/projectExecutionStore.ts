import { atom } from 'jotai';
import { projectState } from './savedGraphs.js';
import type { ProjectExecutionSnapshot } from './dataFlow.js';
import { createEmptyProjectExecutionSnapshot, executionSnapshotsState } from './projectExecutionSnapshot.js';
export { executionSnapshotsState } from './projectExecutionSnapshot.js';

/** Sole execution-state authority. Active atoms below are lenses, not second copies. */
export const emptyExecutionSnapshotState = atom(() => createEmptyProjectExecutionSnapshot());
export const activeExecutionSnapshotState = atom(
  (get) => get(executionSnapshotsState)[get(projectState).metadata.id] ?? get(emptyExecutionSnapshotState),
  (get, set, snapshot: ProjectExecutionSnapshot) => {
    const id = get(projectState).metadata.id;
    if (get(executionSnapshotsState)[id] !== snapshot)
      set(executionSnapshotsState, { ...get(executionSnapshotsState), [id]: snapshot });
  },
);

export function executionSnapshotField<
  K extends keyof ProjectExecutionSnapshot,
  Value extends ProjectExecutionSnapshot[K] = ProjectExecutionSnapshot[K],
>(key: K, normalize: (value: ProjectExecutionSnapshot[K]) => Value = (value) => value as Value) {
  return atom(
    (get) => normalize(get(activeExecutionSnapshotState)[key] ?? get(emptyExecutionSnapshotState)[key]),
    (get, set, update: Value | ((previous: Value) => Value)) => {
      const before = get(activeExecutionSnapshotState);
      const previous = normalize(before[key] ?? get(emptyExecutionSnapshotState)[key]);
      const value = typeof update === 'function' ? (update as (previous: Value) => Value)(previous) : update;
      if (!Object.is(previous, value)) set(activeExecutionSnapshotState, { ...before, [key]: value });
    },
  );
}

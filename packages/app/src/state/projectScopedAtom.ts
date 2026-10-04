import { atom } from 'jotai';
import { projectState } from './savedGraphs.js';

/** Keep graph-keyed transient APIs compatible while isolating cloned projects. */
export function projectScopedAtom<T>(initial: T) {
  const byProject = atom<Record<string, T>>({});
  return atom(
    (get) => get(byProject)[get(projectState).metadata.id] ?? initial,
    (get, set, update: T | ((previous: T) => T)) => {
      const id = get(projectState).metadata.id;
      const previous = get(byProject)[id] ?? initial;
      const next = typeof update === 'function' ? (update as (previous: T) => T)(previous) : update;
      set(byProject, (entries) => ({ ...entries, [id]: next }));
    },
  );
}

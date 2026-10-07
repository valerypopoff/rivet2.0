import { useEffect } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { graphState } from '../state/graph.js';
import {
  projectState,
  projectsState,
  projectUnsavedChangesState,
  savedProjectContentDigestsState,
} from '../state/savedGraphs.js';
import { markProjectDirtyFlag, resolveProjectContentDirtyState } from '../utils/projectUnsavedChanges.js';

/** The shared observer for live graph/project edits. Recovery needs
 * a verified saved baseline; it must not certify recovered edits as clean. */
export function useSyncProjectDirtyState(enabled: boolean) {
  const store = useStore();
  const project = useAtomValue(projectState);
  const graph = useAtomValue(graphState);
  const digests = useAtomValue(savedProjectContentDigestsState);
  const flags = useAtomValue(projectUnsavedChangesState);
  useEffect(() => {
    const project = store.get(projectState);
    if (!enabled || !store.get(projectsState).openedProjects[project.metadata.id]) return;
    const dirty = resolveProjectContentDirtyState(store.get(savedProjectContentDigestsState), {
      project,
      graph: store.get(graphState),
    });
    // Only load/save can certify clean content. This also covers older scratch
    // tabs, whose unsaved graph may have survived without its ephemeral flags.
    store.set(projectUnsavedChangesState, (flags) =>
      markProjectDirtyFlag(flags, project.metadata.id, !dirty.hasSavedDigest || dirty.isDirty),
    );
  }, [enabled, store, project, graph, digests, flags]);
}

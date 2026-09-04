import { useAtomValue, useSetAtom } from 'jotai';
import type { GraphId, ProjectId } from '@valerypopoff/rivet2-core';

import { openedProjectSnapshotsState, projectState, projectsState } from '../../state/savedGraphs.js';
import { flushHybridStorageGroup } from '../../state/storage.js';
import { useStableCallback } from '../useStableCallback.js';
import { normalizeProjectSnapshot } from './projectSnapshot.js';
import { useWorkspaceHostCleanBaseline } from './useWorkspaceHostCleanBaseline.js';
import type { RivetProjectSnapshotInput } from './types.js';

/**
 * Replaces one existing tab's saved snapshot without activating an inactive
 * tab. Hosted wrappers use this for an explicit remote-content reload.
 */
export function useWorkspaceHostReplaceProjectSnapshot(
  replaceCurrent: (snapshot: RivetProjectSnapshotInput) => Promise<boolean>,
) {
  const projects = useAtomValue(projectsState);
  const currentProject = useAtomValue(projectState);
  const setProjects = useSetAtom(projectsState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const { markProjectClean } = useWorkspaceHostCleanBaseline();

  return useStableCallback(async (projectId: ProjectId, snapshot: RivetProjectSnapshotInput): Promise<boolean> => {
    const normalized = normalizeProjectSnapshot(snapshot);
    if (normalized.project.metadata.id !== projectId || !projects.openedProjects[projectId]) {
      return false;
    }

    if (currentProject.metadata.id === projectId) {
      return replaceCurrent(snapshot);
    }

    const existingOpenedProject = projects.openedProjects[projectId];
    const requestedGraph = snapshot.openedGraph ?? snapshot.graphToLoad?.metadata?.id;
    const fallbackGraph = (
      normalized.project.metadata.mainGraphId && normalized.project.graphs[normalized.project.metadata.mainGraphId]
        ? normalized.project.metadata.mainGraphId
        : Object.keys(normalized.project.graphs)[0] as GraphId | undefined
    );
    const nextOpenedGraph = (
      requestedGraph && normalized.project.graphs[requestedGraph]
        ? requestedGraph
        : existingOpenedProject.openedGraph && normalized.project.graphs[existingOpenedProject.openedGraph]
          ? existingOpenedProject.openedGraph
          : fallbackGraph
    );
    setOpenedProjectSnapshots((previousSnapshots) => ({
      ...previousSnapshots,
      [projectId]: {
        project: normalized.project,
        data: normalized.data,
      },
    }));
    setProjects((previousProjects) => {
      const current = previousProjects.openedProjects[projectId];
      if (!current) return previousProjects;
      return {
        ...previousProjects,
        openedProjects: {
          ...previousProjects.openedProjects,
          [projectId]: {
            ...current,
            title: normalized.project.metadata.title,
            fsPath: snapshot.path ?? current.fsPath,
            openedGraph: nextOpenedGraph,
          },
        },
      };
    });
    await markProjectClean(projectId, { project: normalized.project, data: normalized.data });

    try {
      await flushHybridStorageGroup('project');
    } catch (error) {
      // The replacement is already valid in memory. Keep the refreshed tab
      // usable and let normal storage diagnostics surface a later failure.
      console.error('Failed to persist refreshed inactive project snapshot:', error);
    }
    return true;
  });
}

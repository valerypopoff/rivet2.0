import { useAtomValue, useSetAtom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { graphState } from '../../state/graph.js';
import {
  openedProjectSnapshotsState,
  projectDataUnsavedChangesState,
  projectState,
  projectUnsavedChangesState,
  projectsState,
  savedProjectContentDigestsState,
} from '../../state/savedGraphs.js';
import {
  buildCurrentProjectContentSnapshot,
  markProjectClean as markProjectContentClean,
  markProjectDirtyFlag,
  type ProjectContentForDigest,
} from '../../utils/projectUnsavedChanges.js';
import { useStableCallback } from '../useStableCallback.js';
import { normalizeProjectSnapshot } from './projectSnapshot.js';
import type { RivetProjectCleanBaselineSnapshotInput } from './types.js';

export function useWorkspaceHostCleanBaseline() {
  const projects = useAtomValue(projectsState);
  const currentProject = useAtomValue(projectState);
  const currentGraph = useAtomValue(graphState);
  const openedProjectSnapshots = useAtomValue(openedProjectSnapshotsState);
  const setSavedProjectContentDigests = useSetAtom(savedProjectContentDigestsState);
  const setProjectUnsavedChanges = useSetAtom(projectUnsavedChangesState);
  const setProjectDataUnsavedChanges = useSetAtom(projectDataUnsavedChangesState);

  const getProjectCleanBaseline = useStableCallback(
    (projectId: ProjectId, snapshot?: RivetProjectCleanBaselineSnapshotInput): ProjectContentForDigest | undefined => {
      if (snapshot?.project) {
        const normalized = normalizeProjectSnapshot({
          project: snapshot.project,
          data: snapshot.data,
        });
        const snapshotProjectId = normalized.project.metadata.id as ProjectId | undefined;

        return snapshotProjectId === projectId
          ? {
              project: normalized.project,
            }
          : undefined;
      }

      if (currentProject.metadata.id === projectId) {
        return buildCurrentProjectContentSnapshot({
          project: currentProject,
          graph: currentGraph,
        });
      }

      const inactiveSnapshot = openedProjectSnapshots[projectId];
      return inactiveSnapshot
        ? {
            project: inactiveSnapshot.project,
          }
        : undefined;
    },
  );

  const markProjectClean = useStableCallback(
    async (projectId: ProjectId, snapshot?: RivetProjectCleanBaselineSnapshotInput) => {
      if (!projects.openedProjects[projectId] && currentProject.metadata.id !== projectId) {
        return false;
      }

      const cleanBaseline = getProjectCleanBaseline(projectId, snapshot);
      if (!cleanBaseline) {
        return false;
      }

      setSavedProjectContentDigests((previousDigests) => markProjectContentClean(previousDigests, cleanBaseline));
      setProjectUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, projectId, false));
      setProjectDataUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, projectId, false));

      return true;
    },
  );

  const markCurrentProjectClean = useStableCallback(async (snapshot?: RivetProjectCleanBaselineSnapshotInput) => {
    const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
    if (!currentProjectId) {
      return false;
    }

    return markProjectClean(currentProjectId, snapshot);
  });

  return {
    markCurrentProjectClean,
    markProjectClean,
  };
}

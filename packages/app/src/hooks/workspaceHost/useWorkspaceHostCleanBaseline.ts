import { useSetAtom, useStore } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { graphState } from '../../state/graph.js';
import { isEqual } from 'lodash-es';
import {
  openedProjectSnapshotsState,
  projectDataUnsavedChangesState,
  projectDataState,
  projectState,
  projectUnsavedChangesState,
  projectsState,
  savedProjectContentDigestsState,
} from '../../state/savedGraphs.js';
import {
  buildCurrentProjectContentSnapshot,
  markProjectClean as markProjectContentClean,
  markProjectDirtyFlag,
  getProjectContentDigest,
  type ProjectContentForDigest,
} from '../../utils/projectUnsavedChanges.js';
import { useStableCallback } from '../useStableCallback.js';
import { normalizeProjectSnapshot } from './projectSnapshot.js';
import type { RivetProjectCleanBaselineSnapshotInput } from './types.js';

export function useWorkspaceHostCleanBaseline() {
  const store = useStore();
  const setSavedProjectContentDigests = useSetAtom(savedProjectContentDigestsState);
  const setProjectUnsavedChanges = useSetAtom(projectUnsavedChangesState);
  const setProjectDataUnsavedChanges = useSetAtom(projectDataUnsavedChangesState);

  const getProjectCleanBaseline = useStableCallback(
    (projectId: ProjectId, snapshot?: RivetProjectCleanBaselineSnapshotInput): ProjectContentForDigest | undefined => {
      if (snapshot?.project) {
        const normalized = normalizeProjectSnapshot(snapshot);
        const snapshotProjectId = normalized.project.metadata.id as ProjectId | undefined;

        return snapshotProjectId === projectId
          ? {
              project: normalized.project,
            }
          : undefined;
      }

      const currentProject = store.get(projectState);
      if (currentProject.metadata.id === projectId) {
        return buildCurrentProjectContentSnapshot({
          project: currentProject,
          graph: store.get(graphState),
        });
      }

      const inactiveSnapshot = store.get(openedProjectSnapshotsState)[projectId];
      return inactiveSnapshot
        ? {
            project: inactiveSnapshot.project,
          }
        : undefined;
    },
  );

  const markProjectClean = useStableCallback(
    async (projectId: ProjectId, snapshot?: RivetProjectCleanBaselineSnapshotInput) => {
      if (!store.get(projectsState).openedProjects[projectId]) {
        return false;
      }

      const cleanBaseline = getProjectCleanBaseline(projectId, snapshot);
      if (!cleanBaseline) {
        return false;
      }

      setSavedProjectContentDigests((previousDigests) => markProjectContentClean(previousDigests, cleanBaseline));
      const liveContent = getProjectCleanBaseline(projectId);
      const liveData =
        store.get(projectState).metadata.id === projectId
          ? store.get(projectDataState)
          : store.get(openedProjectSnapshotsState)[projectId]?.data;
      const newerContent =
        liveContent != null && getProjectContentDigest(liveContent) !== getProjectContentDigest(cleanBaseline);
      const newerData = snapshot != null && !isEqual(liveData ?? {}, normalizeProjectSnapshot(snapshot).data ?? {});
      setProjectUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, projectId, newerContent));
      setProjectDataUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, projectId, newerData));

      return true;
    },
  );

  const markCurrentProjectClean = useStableCallback(async (snapshot?: RivetProjectCleanBaselineSnapshotInput) => {
    const currentProjectId = store.get(projectState).metadata.id as ProjectId | undefined;
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

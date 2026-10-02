import { useSetAtom, useStore } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { graphState } from '../../state/graph.js';
import {
  loadedProjectState,
  openedProjectSnapshotsState,
  projectState,
  projectUnsavedChangesState,
  projectsState,
  savedProjectContentDigestsState,
} from '../../state/savedGraphs.js';
import {
  moveOpenedProjectPaths,
  normalizeProjectPathMoves,
  updateOpenedProjectMetadata,
} from '../../utils/openedProjects.js';
import { applyProjectMetadataPatch, hasProjectMetadataPatchChanges } from '../../utils/projectMetadataUpdates.js';
import {
  buildCurrentProjectContentSnapshot,
  hasProjectContentChangedFromCleanDigest,
  markProjectDirtyFlag,
  patchSavedProjectMetadata,
} from '../../utils/projectUnsavedChanges.js';
import { useStableCallback } from '../useStableCallback.js';
import type { MoveProjectPathsInput, RivetProjectMetadataPatch, RivetProjectMetadataUpdateOptions } from './types.js';

export function useWorkspaceHostProjectMetadata() {
  const store = useStore();
  const setProjects = useSetAtom(projectsState);
  const setLoadedProject = useSetAtom(loadedProjectState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const setCurrentProject = useSetAtom(projectState);
  const setSavedProjectContentDigests = useSetAtom(savedProjectContentDigestsState);
  const setProjectUnsavedChanges = useSetAtom(projectUnsavedChangesState);

  const moveProjectPaths = useStableCallback((moves: MoveProjectPathsInput) => {
    const loadedProject = store.get(loadedProjectState);
    const normalizedMoves = normalizeProjectPathMoves(moves);
    setProjects((previousProjects) => moveOpenedProjectPaths(previousProjects, normalizedMoves));

    const nextLoadedProjectPath = loadedProject.path
      ? normalizedMoves.find((move) => move.from === loadedProject.path)?.to
      : undefined;

    if (nextLoadedProjectPath) {
      setLoadedProject({
        ...loadedProject,
        path: nextLoadedProjectPath,
      });
    }
  });

  const updateProjectMetadata = useStableCallback(
    async (
      projectId: ProjectId,
      metadataPatch: RivetProjectMetadataPatch,
      options: RivetProjectMetadataUpdateOptions = {},
    ) => {
      const currentProject = store.get(projectState);
      const currentGraph = store.get(graphState);
      const projects = store.get(projectsState);
      const openedProjectSnapshots = store.get(openedProjectSnapshotsState);
      const savedProjectContentDigests = store.get(savedProjectContentDigestsState);
      const isCurrentProject = currentProject.metadata.id === projectId;
      const openedProject = projects.openedProjects[projectId];
      if (!openedProject && !isCurrentProject) {
        return false;
      }

      const hasPathUpdate = options.path !== undefined;
      const nextPath = options.path ?? null;
      const inactiveSnapshot = openedProjectSnapshots[projectId];
      const projectBeforePatch = isCurrentProject ? currentProject : inactiveSnapshot?.project;
      const hasMetadataChanges = projectBeforePatch
        ? hasProjectMetadataPatchChanges(projectBeforePatch.metadata, metadataPatch)
        : typeof metadataPatch?.title === 'string' && metadataPatch.title !== openedProject?.title;
      const patchedProject = projectBeforePatch
        ? applyProjectMetadataPatch(projectBeforePatch, metadataPatch)
        : undefined;

      setProjects((previousProjects) =>
        updateOpenedProjectMetadata(
          previousProjects,
          projectId,
          metadataPatch,
          hasPathUpdate ? { fsPath: nextPath } : {},
        ),
      );

      if (hasPathUpdate && isCurrentProject) {
        setLoadedProject((previousLoadedProject) =>
          previousLoadedProject.path === nextPath
            ? previousLoadedProject
            : {
                ...previousLoadedProject,
                path: nextPath,
              },
        );
      }

      if (patchedProject && patchedProject !== projectBeforePatch) {
        if (isCurrentProject) {
          setCurrentProject(patchedProject);
        } else {
          setOpenedProjectSnapshots((previousSnapshots) => {
            const previousSnapshot = previousSnapshots[projectId];
            return previousSnapshot
              ? {
                  ...previousSnapshots,
                  [projectId]: {
                    ...previousSnapshot,
                    project: patchedProject,
                  },
                }
              : previousSnapshots;
          });
        }
      }

      if (!hasMetadataChanges) {
        return true;
      }

      if (options.persistedExternally) {
        if (savedProjectContentDigests[projectId] != null && patchedProject) {
          const nextDigests = patchSavedProjectMetadata(savedProjectContentDigests, projectId, metadataPatch);
          const patchedContent = isCurrentProject
            ? buildCurrentProjectContentSnapshot({ project: patchedProject, graph: currentGraph })
            : { project: patchedProject };
          setSavedProjectContentDigests(nextDigests);
          setProjectUnsavedChanges((flags) =>
            markProjectDirtyFlag(
              flags,
              projectId,
              hasProjectContentChangedFromCleanDigest(nextDigests, patchedContent),
            ),
          );
        } else if (patchedProject) {
          // Persisting a title does not certify a recovered graph as saved.
          setProjectUnsavedChanges((flags) => markProjectDirtyFlag(flags, projectId, true));
        }
      } else {
        setProjectUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, projectId, true));
      }

      return true;
    },
  );

  return {
    moveProjectPaths,
    updateProjectMetadata,
  };
}

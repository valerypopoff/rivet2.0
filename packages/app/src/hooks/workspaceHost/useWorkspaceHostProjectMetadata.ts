import { useAtom, useAtomValue, useSetAtom } from 'jotai';
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
import {
  applyProjectMetadataPatch,
  hasProjectMetadataPatchChanges,
} from '../../utils/projectMetadataUpdates.js';
import {
  buildCurrentProjectContentSnapshot,
  hasProjectContentChangedFromCleanDigest,
  markProjectClean as markProjectContentClean,
  markProjectDirtyFlag,
} from '../../utils/projectUnsavedChanges.js';
import { useStableCallback } from '../useStableCallback.js';
import type {
  MoveProjectPathsInput,
  RivetProjectMetadataPatch,
  RivetProjectMetadataUpdateOptions,
} from './types.js';

export function useWorkspaceHostProjectMetadata() {
  const [projects, setProjects] = useAtom(projectsState);
  const [loadedProject, setLoadedProject] = useAtom(loadedProjectState);
  const [openedProjectSnapshots, setOpenedProjectSnapshots] = useAtom(openedProjectSnapshotsState);
  const currentProject = useAtomValue(projectState);
  const setCurrentProject = useSetAtom(projectState);
  const currentGraph = useAtomValue(graphState);
  const savedProjectContentDigests = useAtomValue(savedProjectContentDigestsState);
  const projectUnsavedChanges = useAtomValue(projectUnsavedChangesState);
  const setSavedProjectContentDigests = useSetAtom(savedProjectContentDigestsState);
  const setProjectUnsavedChanges = useSetAtom(projectUnsavedChangesState);

  const moveProjectPaths = useStableCallback((moves: MoveProjectPathsInput) => {
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
      const contentBeforePatch = projectBeforePatch
        ? isCurrentProject
          ? buildCurrentProjectContentSnapshot({
              project: projectBeforePatch,
              graph: currentGraph,
            })
          : {
              project: projectBeforePatch,
            }
        : undefined;
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

      const wasProjectDirty =
        projectUnsavedChanges[projectId] === true ||
        hasProjectContentChangedFromCleanDigest(savedProjectContentDigests, contentBeforePatch);

      if (options.persistedExternally) {
        if (!wasProjectDirty && patchedProject) {
          const cleanBaseline = isCurrentProject
            ? buildCurrentProjectContentSnapshot({
                project: patchedProject,
                graph: currentGraph,
              })
            : {
                project: patchedProject,
              };

          setSavedProjectContentDigests((previousDigests) => markProjectContentClean(previousDigests, cleanBaseline));
          setProjectUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, projectId, false));
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

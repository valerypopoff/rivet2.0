import { useMemo } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { GraphId, NodeGraph, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { TrivetState } from '../state/trivet.js';
import { isPathBasedIOProvider } from '../io/IOProvider.js';
import { useIOProvider } from '../providers/ProvidersContext.js';
import { useRivetAppHostCallbacks } from '../providers/HostCallbacksContext.js';
import { graphState } from '../state/graph.js';
import {
  loadedProjectState,
  openedProjectSnapshotsState,
  openedProjectsSortedIdsState,
  projectDataUnsavedChangesState,
  projectUnsavedChangesState,
  projectsState,
  projectState,
  releaseProjectContextState,
  savedProjectContentDigestsState,
} from '../state/savedGraphs.js';
import {
  projectCompareReferenceState,
  viewingProjectComparisonNodeState,
  type ProjectCompareSideLabels,
} from '../state/projectComparison.js';
import {
  projectTabUiState,
  removeProjectTabUiState,
  updateProjectTabUiState,
  type ProjectTabUiState,
} from '../state/projectTabUi.js';
import { handleError } from '../utils/errorHandling.js';
import {
  addOpenedProject,
  moveOpenedProjectPaths,
  normalizeProjectPathMoves,
  removeOpenedProject,
  updateOpenedProjectMetadata,
  type ProjectPathMovesInput,
} from '../utils/openedProjects.js';
import { useCurrentProjectEditorSnapshot } from './useCurrentProjectEditorSnapshot.js';
import { useLoadProject } from './useLoadProject.js';
import { useProjectExecutionSnapshots } from './useProjectExecutionSnapshots.js';
import { useStableCallback } from './useStableCallback.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';
import {
  buildCurrentProjectContentSnapshot,
  hasProjectContentChangedFromCleanDigest,
  markProjectClean as markProjectContentClean,
  markProjectDirtyFlag,
  removeProjectUnsavedState,
  type ProjectContentForDigest,
} from '../utils/projectUnsavedChanges.js';
import {
  applyProjectMetadataPatch,
  hasProjectMetadataPatchChanges,
  type ProjectMetadataPatch,
} from '../utils/projectMetadataUpdates.js';

export type RivetProjectSnapshotInput = {
  project: Project | Omit<Project, 'data'>;
  data?: Project['data'];
  path?: string | null;
  openedGraph?: GraphId;
  graphToLoad?: NodeGraph;
  testSuites?: TrivetState['testSuites'];
};

export type MoveProjectPathsInput = ProjectPathMovesInput;

export type RivetProjectCleanBaselineSnapshotInput = {
  project: Project | Omit<Project, 'data'>;
  // Accepted for parity with save/open snapshots. Static data is not included
  // in the content digest, but mark-clean calls clear its dirty flag.
  data?: Project['data'];
};

export type RivetProjectCompareOptions = {
  labels?: ProjectCompareSideLabels;
};

export type RivetProjectTabUiState = ProjectTabUiState;

export type RivetProjectOpenOptions = {
  tabUi?: RivetProjectTabUiState;
};

export type RivetProjectReplaceOptions = {
  tabUi?: RivetProjectTabUiState;
};

export type RivetProjectMetadataUpdateOptions = {
  path?: string | null;
  persistedExternally?: boolean;
  changeSource?: 'external-wrapper-rename';
};

export type RivetProjectMetadataPatch = ProjectMetadataPatch;

export type RivetWorkspaceHost = {
  openProjectSnapshot(snapshot: RivetProjectSnapshotInput, options?: RivetProjectOpenOptions): Promise<boolean>;
  openProjectPath(path: string): Promise<boolean>;
  closeProject(projectId?: ProjectId): Promise<boolean>;
  moveProjectPaths(moves: MoveProjectPathsInput): void;
  setProjectTabUiState(projectId: ProjectId, state?: RivetProjectTabUiState): Promise<boolean>;
  updateProjectMetadata(
    projectId: ProjectId,
    metadataPatch: RivetProjectMetadataPatch,
    options?: RivetProjectMetadataUpdateOptions,
  ): Promise<boolean>;
  replaceCurrent(snapshot: RivetProjectSnapshotInput, options?: RivetProjectReplaceOptions): Promise<boolean>;
  markCurrentProjectClean(snapshot?: RivetProjectCleanBaselineSnapshotInput): Promise<boolean>;
  markProjectClean(projectId: ProjectId, snapshot?: RivetProjectCleanBaselineSnapshotInput): Promise<boolean>;
  startProjectCompare(
    referenceProject: Project,
    referencePath?: string | null,
    options?: RivetProjectCompareOptions,
  ): Promise<boolean>;
  stopProjectCompare(projectId?: ProjectId): Promise<boolean>;
};

function clearCodeEditorModelCacheForClosedProject(projectId: ProjectId): void {
  window.setTimeout(() => {
    void import('../utils/monaco/codeEditorModelCache.js')
      .then(({ clearCodeEditorModelCacheForProject }) => {
        clearCodeEditorModelCacheForProject(projectId);
      })
      .catch((error) => {
        handleError(error, 'Failed to clear code editor model cache', {
          metadata: {
            projectId,
          },
        });
      });
  }, 0);
}

type NormalizedProjectSnapshot = {
  project: Omit<Project, 'data'>;
  data?: Project['data'];
};

export function normalizeProjectSnapshot(snapshot: RivetProjectSnapshotInput): NormalizedProjectSnapshot {
  const { data: attachedData, ...project } = snapshot.project as Project;

  return {
    project,
    data: snapshot.data ?? attachedData,
  };
}

export function useRivetWorkspaceHost(): RivetWorkspaceHost {
  const ioProvider = useIOProvider();
  const callbacks = useRivetAppHostCallbacks();
  const workspaceTransitions = useWorkspaceTransitions();
  const loadProject = useLoadProject();
  const [projects, setProjects] = useAtom(projectsState);
  const [projectTabUiStates, setProjectTabUiStates] = useAtom(projectTabUiState);
  const currentProject = useAtomValue(projectState);
  const currentGraph = useAtomValue(graphState);
  const loadedProject = useAtomValue(loadedProjectState);
  const openedProjectSnapshots = useAtomValue(openedProjectSnapshotsState);
  const openedProjectIds = useAtomValue(openedProjectsSortedIdsState);
  const setLoadedProject = useSetAtom(loadedProjectState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const setCurrentProject = useSetAtom(projectState);
  const savedProjectContentDigests = useAtomValue(savedProjectContentDigestsState);
  const setSavedProjectContentDigests = useSetAtom(savedProjectContentDigestsState);
  const projectUnsavedChanges = useAtomValue(projectUnsavedChangesState);
  const setProjectUnsavedChanges = useSetAtom(projectUnsavedChangesState);
  const setProjectDataUnsavedChanges = useSetAtom(projectDataUnsavedChangesState);
  const projectCompareReference = useAtomValue(projectCompareReferenceState);
  const setProjectCompareReference = useSetAtom(projectCompareReferenceState);
  const setViewingProjectComparisonNode = useSetAtom(viewingProjectComparisonNodeState);
  const { persistCurrentProjectEditorSnapshot } = useCurrentProjectEditorSnapshot();
  const { captureCurrentProjectExecutionSnapshot, removeProjectExecutionSnapshot, restoreProjectExecutionSnapshot } =
    useProjectExecutionSnapshots();

  const openProjectSnapshot = useStableCallback(
    async (
      snapshot: RivetProjectSnapshotInput,
      options: RivetProjectOpenOptions & { replaceCurrent?: boolean } = {},
    ) => {
      const normalized = normalizeProjectSnapshot(snapshot);
      const projectId = normalized.project.metadata.id as ProjectId;
      const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
      const shouldPreseedTabUiState = options.tabUi !== undefined;
      const previousTabUiState = projectTabUiStates[projectId];

      if (shouldPreseedTabUiState) {
        setProjectTabUiStates((states) => updateProjectTabUiState(states, projectId, options.tabUi));
      }

      const restorePreseededTabUiState = () => {
        if (shouldPreseedTabUiState) {
          setProjectTabUiStates((states) => updateProjectTabUiState(states, projectId, previousTabUiState));
        }
      };

      try {
        const loaded = await workspaceTransitions.loadProject({
          project: normalized.project,
          data: normalized.data,
          fsPath: snapshot.path,
          openedGraph: snapshot.openedGraph,
          graphToLoad: snapshot.graphToLoad,
          testSuites: snapshot.testSuites,
          executorMode: projects.openedProjects[projectId]?.executorMode,
          markClean: true,
        });

        if (!loaded) {
          restorePreseededTabUiState();
          return false;
        }

        setProjects((previousProjects) => {
          const replacedProjectIndex =
            currentProjectId && currentProjectId !== projectId
              ? previousProjects.openedProjectsSortedIds.indexOf(currentProjectId)
              : -1;
          const withoutReplacedProject =
            options.replaceCurrent && currentProjectId && currentProjectId !== projectId
              ? removeOpenedProject(previousProjects, currentProjectId)
              : previousProjects;

          const withOpenedProject = addOpenedProject(
            withoutReplacedProject,
            {
              ...normalized.project,
              data: normalized.data,
            },
            {
              fsPath: snapshot.path,
              openedGraph: snapshot.openedGraph ?? snapshot.graphToLoad?.metadata?.id,
            },
          );

          if (!options.replaceCurrent || replacedProjectIndex < 0) {
            return withOpenedProject;
          }

          const reorderedProjectIds = withOpenedProject.openedProjectsSortedIds.filter((id) => id !== projectId);
          reorderedProjectIds.splice(Math.min(replacedProjectIndex, reorderedProjectIds.length), 0, projectId);

          return {
            ...withOpenedProject,
            openedProjectsSortedIds: reorderedProjectIds,
          };
        });

        if (options.replaceCurrent && currentProjectId && currentProjectId !== projectId) {
          setProjectCompareReference((reference) =>
            reference?.projectId === currentProjectId ? undefined : reference,
          );
          setViewingProjectComparisonNode(undefined);
          setOpenedProjectSnapshots((snapshots) => {
            const nextSnapshots = { ...snapshots };
            delete nextSnapshots[currentProjectId];
            return nextSnapshots;
          });
          setSavedProjectContentDigests((digests) => removeProjectUnsavedState(digests, currentProjectId));
          setProjectUnsavedChanges((flags) => removeProjectUnsavedState(flags, currentProjectId));
          setProjectDataUnsavedChanges((flags) => removeProjectUnsavedState(flags, currentProjectId));
          setProjectTabUiStates((states) => removeProjectTabUiState(states, currentProjectId));
          removeProjectExecutionSnapshot(currentProjectId);
          releaseProjectContextState(currentProjectId);
          clearCodeEditorModelCacheForClosedProject(currentProjectId);
        }

        return true;
      } catch (error) {
        restorePreseededTabUiState();
        callbacks.onOpenError?.({
          error,
          operation: 'openProjectSnapshot',
          path: snapshot.path,
          projectId,
          openedGraph: snapshot.openedGraph,
        });
        handleError(error, 'Failed to open project snapshot', {
          metadata: {
            openedGraph: snapshot.openedGraph,
            projectId,
            projectPath: snapshot.path,
          },
        });
        return false;
      }
    },
  );

  const openProjectPath = useStableCallback(async (path: string) => {
    try {
      const alreadyOpenedProject = Object.values(projects.openedProjects).find((project) => project.fsPath === path);

      if (alreadyOpenedProject) {
        return await loadProject(alreadyOpenedProject);
      }

      if (!isPathBasedIOProvider(ioProvider)) {
        throw new Error('The active IO provider does not support opening projects by path.');
      }

      const { project, testData } = await ioProvider.loadProjectDataNoPrompt(path);
      const { data, ...projectWithoutData } = project;

      return await openProjectSnapshot({
        project: projectWithoutData,
        data,
        path,
        testSuites: testData.testSuites,
      });
    } catch (error) {
      callbacks.onOpenError?.({
        error,
        operation: 'openProjectPath',
        path,
      });
      handleError(error, 'Failed to open project path', {
        metadata: {
          projectPath: path,
        },
      });
      return false;
    }
  });

  const closeProject = useStableCallback(async (projectId = currentProject.metadata.id as ProjectId) => {
    const indexOfProject = openedProjectIds.indexOf(projectId);
    if (indexOfProject === -1) {
      return false;
    }

    const closingCurrentProject = currentProject.metadata.id === projectId;
    if (closingCurrentProject) {
      persistCurrentProjectEditorSnapshot();
    }
    const closingCurrentProjectExecutionSnapshot = closingCurrentProject
      ? captureCurrentProjectExecutionSnapshot()
      : undefined;

    const sortedOpenedProjects = openedProjectIds
      .map((id) => ({
        id,
        project: projects.openedProjects[id],
      }))
      .filter((item) => item.project != null);
    const closestProject = sortedOpenedProjects[indexOfProject + 1] || sortedOpenedProjects[indexOfProject - 1];

    if (closingCurrentProject && closestProject?.project) {
      const loaded = await loadProject(closestProject.project);
      if (!loaded) {
        return false;
      }
    } else if (closingCurrentProject) {
      restoreProjectExecutionSnapshot(undefined);
    }

    removeProjectExecutionSnapshot(projectId, {
      currentSnapshot: closingCurrentProjectExecutionSnapshot,
    });
    setProjects((previousProjects) => removeOpenedProject(previousProjects, projectId));
    setProjectCompareReference((reference) => (reference?.projectId === projectId ? undefined : reference));
    setViewingProjectComparisonNode(undefined);
    setOpenedProjectSnapshots((snapshots) => {
      const nextSnapshots = { ...snapshots };
      delete nextSnapshots[projectId];
      return nextSnapshots;
    });
    setSavedProjectContentDigests((digests) => removeProjectUnsavedState(digests, projectId));
    setProjectUnsavedChanges((flags) => removeProjectUnsavedState(flags, projectId));
    setProjectDataUnsavedChanges((flags) => removeProjectUnsavedState(flags, projectId));
    setProjectTabUiStates((states) => removeProjectTabUiState(states, projectId));
    releaseProjectContextState(projectId);
    clearCodeEditorModelCacheForClosedProject(projectId);

    return true;
  });

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

  const setProjectTabUiState = useStableCallback(async (projectId: ProjectId, state?: RivetProjectTabUiState) => {
    if (!projects.openedProjects[projectId]) {
      return false;
    }

    setProjectTabUiStates((states) => updateProjectTabUiState(states, projectId, state));
    return true;
  });

  const replaceCurrent = useStableCallback(
    async (snapshot: RivetProjectSnapshotInput, options?: RivetProjectReplaceOptions) => {
      return await openProjectSnapshot(snapshot, { replaceCurrent: true, tabUi: options?.tabUi });
    },
  );

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
            if (!previousSnapshot) {
              return previousSnapshots;
            }

            return {
              ...previousSnapshots,
              [projectId]: {
                ...previousSnapshot,
                project: patchedProject,
              },
            };
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

          setSavedProjectContentDigests((previousDigests) =>
            markProjectContentClean(previousDigests, cleanBaseline),
          );
          setProjectUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, projectId, false));
        }
      } else {
        setProjectUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, projectId, true));
      }

      return true;
    },
  );

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

  const markOpenProjectClean = useStableCallback(
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

    return await markOpenProjectClean(currentProjectId, snapshot);
  });

  const startProjectCompare = useStableCallback(
    async (referenceProject: Project, referencePath?: string | null, options?: RivetProjectCompareOptions) => {
      const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
      if (!currentProjectId) {
        return false;
      }

      setViewingProjectComparisonNode(undefined);
      setProjectCompareReference({
        projectId: currentProjectId,
        referencePath: referencePath ?? undefined,
        referenceProject,
        labels: options?.labels,
      });

      return true;
    },
  );

  const stopProjectCompare = useStableCallback(async (projectId?: ProjectId) => {
    if (!projectCompareReference || (projectId && projectCompareReference.projectId !== projectId)) {
      return false;
    }

    setViewingProjectComparisonNode(undefined);
    setProjectCompareReference(undefined);

    return true;
  });

  return useMemo(
    () => ({
      openProjectSnapshot,
      openProjectPath,
      closeProject,
      moveProjectPaths,
      setProjectTabUiState,
      updateProjectMetadata,
      replaceCurrent,
      markCurrentProjectClean,
      markProjectClean: markOpenProjectClean,
      startProjectCompare,
      stopProjectCompare,
    }),
    [
      closeProject,
      markCurrentProjectClean,
      markOpenProjectClean,
      moveProjectPaths,
      openProjectPath,
      openProjectSnapshot,
      replaceCurrent,
      setProjectTabUiState,
      startProjectCompare,
      stopProjectCompare,
      updateProjectMetadata,
    ],
  );
}

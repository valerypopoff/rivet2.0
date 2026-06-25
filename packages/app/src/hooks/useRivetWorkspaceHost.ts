import { useMemo } from 'react';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import type { GraphId, NodeGraph, Project, ProjectId } from '@valerypopoff/rivet2-core';
import { nanoid } from 'nanoid/non-secure';
import type { TrivetState } from '../state/trivet.js';
import { isPathBasedIOProvider } from '../io/IOProvider.js';
import { useIOProvider } from '../providers/ProvidersContext.js';
import { useRivetAppHostCallbacks } from '../providers/HostCallbacksContext.js';
import { useExecutorSessionRegistry } from '../providers/ExecutorSessionContext.js';
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
import {
  openingProjectTabsSortedIdsState,
  openingProjectTabsState,
  selectedOpeningProjectTabIdState,
  type OpeningProjectTabId,
} from '../state/openingProjectTabs.js';
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
import { removeOpeningProjectTabId } from '../utils/openingProjectTabs.js';

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

export type RivetOpeningProjectTabInput = {
  title: string;
  path?: string | null;
};

export type RivetOpeningProjectTabOptions = {
  tabUi?: RivetProjectTabUiState;
  replaceCurrent?: boolean;
};

export type RivetOpeningProjectTabHandle = {
  openingTabId: string;
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
  startOpeningProjectTab(
    input: RivetOpeningProjectTabInput,
    options?: RivetOpeningProjectTabOptions,
  ): Promise<RivetOpeningProjectTabHandle | false>;
  finishOpeningProjectTab(
    openingTabId: string,
    snapshot: RivetProjectSnapshotInput,
    options?: RivetProjectOpenOptions,
  ): Promise<boolean>;
  cancelOpeningProjectTab(openingTabId: string): Promise<boolean>;
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
  const store = useStore();
  const [projects, setProjects] = useAtom(projectsState);
  const [projectTabUiStates, setProjectTabUiStates] = useAtom(projectTabUiState);
  const [openingProjectTabs, setOpeningProjectTabs] = useAtom(openingProjectTabsState);
  const setOpeningProjectTabIds = useSetAtom(openingProjectTabsSortedIdsState);
  const setSelectedOpeningProjectTabId = useSetAtom(selectedOpeningProjectTabIdState);
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
  const executorSessionRegistry = useExecutorSessionRegistry();
  const { captureCurrentProjectExecutionSnapshot, removeProjectExecutionSnapshot, restoreProjectExecutionSnapshot } =
    useProjectExecutionSnapshots();

  const openProjectSnapshot = useStableCallback(
    async (
      snapshot: RivetProjectSnapshotInput,
      options: RivetProjectOpenOptions & {
        replaceCurrent?: boolean;
        replaceProjectId?: ProjectId;
        selectedOpeningProjectTabIdToClear?: OpeningProjectTabId | 'all';
      } = {},
    ) => {
      const normalized = normalizeProjectSnapshot(snapshot);
      const projectId = normalized.project.metadata.id as ProjectId;
      const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
      const replaceTargetProjectId = options.replaceProjectId ?? currentProjectId;
      const existingExecutorMode = store.get(projectsState).openedProjects[projectId]?.executorMode;
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
          executorMode: existingExecutorMode,
          markClean: true,
        });

        if (!loaded) {
          restorePreseededTabUiState();
          return false;
        }

        setProjects((previousProjects) => {
          const replacedProjectIndex =
            replaceTargetProjectId && replaceTargetProjectId !== projectId
              ? previousProjects.openedProjectsSortedIds.indexOf(replaceTargetProjectId)
              : -1;
          const withoutReplacedProject =
            options.replaceCurrent && replaceTargetProjectId && replaceTargetProjectId !== projectId
              ? removeOpenedProject(previousProjects, replaceTargetProjectId)
              : previousProjects;
          const nextExecutorMode = previousProjects.openedProjects[projectId]?.executorMode ?? existingExecutorMode;

          const withOpenedProject = addOpenedProject(
            withoutReplacedProject,
            {
              ...normalized.project,
              data: normalized.data,
            },
            {
              fsPath: snapshot.path,
              openedGraph: snapshot.openedGraph ?? snapshot.graphToLoad?.metadata?.id,
              ...(nextExecutorMode ? { executorMode: nextExecutorMode } : {}),
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

        const openingTabSelectionToClear = options.selectedOpeningProjectTabIdToClear ?? 'all';
        if (openingTabSelectionToClear === 'all') {
          setSelectedOpeningProjectTabId(undefined);
        } else {
          setSelectedOpeningProjectTabId((selectedId) =>
            selectedId === openingTabSelectionToClear ? undefined : selectedId,
          );
        }

        if (options.replaceCurrent && replaceTargetProjectId && replaceTargetProjectId !== projectId) {
          setProjectCompareReference((reference) =>
            reference?.projectId === replaceTargetProjectId ? undefined : reference,
          );
          setViewingProjectComparisonNode(undefined);
          setOpenedProjectSnapshots((snapshots) => {
            const nextSnapshots = { ...snapshots };
            delete nextSnapshots[replaceTargetProjectId];
            return nextSnapshots;
          });
          setSavedProjectContentDigests((digests) => removeProjectUnsavedState(digests, replaceTargetProjectId));
          setProjectUnsavedChanges((flags) => removeProjectUnsavedState(flags, replaceTargetProjectId));
          setProjectDataUnsavedChanges((flags) => removeProjectUnsavedState(flags, replaceTargetProjectId));
          setProjectTabUiStates((states) => removeProjectTabUiState(states, replaceTargetProjectId));
          executorSessionRegistry.removeProject(replaceTargetProjectId);
          removeProjectExecutionSnapshot(replaceTargetProjectId);
          releaseProjectContextState(replaceTargetProjectId);
          clearCodeEditorModelCacheForClosedProject(replaceTargetProjectId);
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
    executorSessionRegistry.removeProject(projectId);
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

  const startOpeningProjectTab = useStableCallback(
    async (
      input: RivetOpeningProjectTabInput,
      options: RivetOpeningProjectTabOptions = {},
    ): Promise<RivetOpeningProjectTabHandle | false> => {
      if (!input.title.trim()) {
        return false;
      }

      const openingTabId = `opening-project-${nanoid()}` as OpeningProjectTabId;
      const replaceTargetProjectId =
        options.replaceCurrent && projects.openedProjects[currentProject.metadata.id as ProjectId]
          ? (currentProject.metadata.id as ProjectId)
          : undefined;
      const replacedOpeningTabIds = replaceTargetProjectId
        ? Object.values(openingProjectTabs).flatMap((tab) =>
            tab?.replaceTargetProjectId === replaceTargetProjectId ? [tab.openingTabId] : [],
          )
        : [];

      setOpeningProjectTabs((tabs) => {
        const nextTabs = { ...tabs };
        for (const replacedOpeningTabId of replacedOpeningTabIds) {
          delete nextTabs[replacedOpeningTabId];
        }

        nextTabs[openingTabId] = {
          openingTabId,
          path: input.path ?? null,
          replaceTargetProjectId,
          tabUi: options.tabUi,
          title: input.title,
        };

        return nextTabs;
      });
      setOpeningProjectTabIds((ids) => [...ids.filter((id) => !replacedOpeningTabIds.includes(id)), openingTabId]);
      setSelectedOpeningProjectTabId(openingTabId);

      return { openingTabId };
    },
  );

  const removeOpeningProjectTab = useStableCallback(async (openingTabId: string) => {
    const typedOpeningTabId = openingTabId as OpeningProjectTabId;
    if (!openingProjectTabs[typedOpeningTabId]) {
      return false;
    }

    setOpeningProjectTabs((tabs) => {
      const nextTabs = { ...tabs };
      delete nextTabs[typedOpeningTabId];
      return nextTabs;
    });
    setOpeningProjectTabIds((ids) => removeOpeningProjectTabId(ids, typedOpeningTabId));
    setSelectedOpeningProjectTabId((selectedId) => (selectedId === typedOpeningTabId ? undefined : selectedId));

    return true;
  });

  const finishOpeningProjectTab = useStableCallback(
    async (openingTabId: string, snapshot: RivetProjectSnapshotInput, options: RivetProjectOpenOptions = {}) => {
      const typedOpeningTabId = openingTabId as OpeningProjectTabId;
      const openingTab = openingProjectTabs[typedOpeningTabId];
      if (!openingTab) {
        return false;
      }

      const opened = await openProjectSnapshot(snapshot, {
        replaceCurrent: openingTab.replaceTargetProjectId != null,
        replaceProjectId: openingTab.replaceTargetProjectId,
        selectedOpeningProjectTabIdToClear: typedOpeningTabId,
        tabUi: options.tabUi ?? openingTab.tabUi,
      });

      if (!opened) {
        return false;
      }

      await removeOpeningProjectTab(openingTabId);
      return true;
    },
  );

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

          setSavedProjectContentDigests((previousDigests) => markProjectContentClean(previousDigests, cleanBaseline));
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
      startOpeningProjectTab,
      finishOpeningProjectTab,
      cancelOpeningProjectTab: removeOpeningProjectTab,
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
      finishOpeningProjectTab,
      replaceCurrent,
      removeOpeningProjectTab,
      setProjectTabUiState,
      startOpeningProjectTab,
      startProjectCompare,
      stopProjectCompare,
      updateProjectMetadata,
    ],
  );
}

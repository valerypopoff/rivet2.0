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
import { handleError } from '../utils/errorHandling.js';
import {
  addOpenedProject,
  moveOpenedProjectPaths,
  normalizeProjectPathMoves,
  removeOpenedProject,
  type ProjectPathMovesInput,
} from '../utils/openedProjects.js';
import { useCurrentProjectEditorSnapshot } from './useCurrentProjectEditorSnapshot.js';
import { useLoadProject } from './useLoadProject.js';
import { useProjectExecutionSnapshots } from './useProjectExecutionSnapshots.js';
import { useStableCallback } from './useStableCallback.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';
import {
  buildCurrentProjectContentSnapshot,
  markProjectClean as markProjectContentClean,
  markProjectDirtyFlag,
  removeProjectUnsavedState,
  type ProjectContentForDigest,
} from '../utils/projectUnsavedChanges.js';

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

export type RivetWorkspaceHost = {
  openProjectSnapshot(snapshot: RivetProjectSnapshotInput): Promise<boolean>;
  openProjectPath(path: string): Promise<boolean>;
  closeProject(projectId?: ProjectId): Promise<boolean>;
  moveProjectPaths(moves: MoveProjectPathsInput): void;
  replaceCurrent(snapshot: RivetProjectSnapshotInput): Promise<boolean>;
  markCurrentProjectClean(snapshot?: RivetProjectCleanBaselineSnapshotInput): Promise<boolean>;
  markProjectClean(projectId: ProjectId, snapshot?: RivetProjectCleanBaselineSnapshotInput): Promise<boolean>;
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
  const currentProject = useAtomValue(projectState);
  const currentGraph = useAtomValue(graphState);
  const loadedProject = useAtomValue(loadedProjectState);
  const openedProjectSnapshots = useAtomValue(openedProjectSnapshotsState);
  const openedProjectIds = useAtomValue(openedProjectsSortedIdsState);
  const setLoadedProject = useSetAtom(loadedProjectState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const setSavedProjectContentDigests = useSetAtom(savedProjectContentDigestsState);
  const setProjectUnsavedChanges = useSetAtom(projectUnsavedChangesState);
  const setProjectDataUnsavedChanges = useSetAtom(projectDataUnsavedChangesState);
  const { persistCurrentProjectEditorSnapshot } = useCurrentProjectEditorSnapshot();
  const {
    captureCurrentProjectExecutionSnapshot,
    removeProjectExecutionSnapshot,
    restoreProjectExecutionSnapshot,
  } = useProjectExecutionSnapshots();

  const openProjectSnapshot = useStableCallback(
    async (snapshot: RivetProjectSnapshotInput, options: { replaceCurrent?: boolean } = {}) => {
      const normalized = normalizeProjectSnapshot(snapshot);
      const projectId = normalized.project.metadata.id as ProjectId;
      const currentProjectId = currentProject.metadata.id as ProjectId | undefined;

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
          setOpenedProjectSnapshots((snapshots) => {
            const nextSnapshots = { ...snapshots };
            delete nextSnapshots[currentProjectId];
            return nextSnapshots;
          });
          setSavedProjectContentDigests((digests) => removeProjectUnsavedState(digests, currentProjectId));
          setProjectUnsavedChanges((flags) => removeProjectUnsavedState(flags, currentProjectId));
          setProjectDataUnsavedChanges((flags) => removeProjectUnsavedState(flags, currentProjectId));
          removeProjectExecutionSnapshot(currentProjectId);
          releaseProjectContextState(currentProjectId);
          clearCodeEditorModelCacheForClosedProject(currentProjectId);
        }

        return true;
      } catch (error) {
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
    setOpenedProjectSnapshots((snapshots) => {
      const nextSnapshots = { ...snapshots };
      delete nextSnapshots[projectId];
      return nextSnapshots;
    });
    setSavedProjectContentDigests((digests) => removeProjectUnsavedState(digests, projectId));
    setProjectUnsavedChanges((flags) => removeProjectUnsavedState(flags, projectId));
    setProjectDataUnsavedChanges((flags) => removeProjectUnsavedState(flags, projectId));
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

  const replaceCurrent = useStableCallback(async (snapshot: RivetProjectSnapshotInput) => {
    return await openProjectSnapshot(snapshot, { replaceCurrent: true });
  });

  const getProjectCleanBaseline = useStableCallback(
    (
      projectId: ProjectId,
      snapshot?: RivetProjectCleanBaselineSnapshotInput,
    ): ProjectContentForDigest | undefined => {
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

  return useMemo(
    () => ({
      openProjectSnapshot,
      openProjectPath,
      closeProject,
      moveProjectPaths,
      replaceCurrent,
      markCurrentProjectClean,
      markProjectClean: markOpenProjectClean,
    }),
    [
      closeProject,
      markCurrentProjectClean,
      markOpenProjectClean,
      moveProjectPaths,
      openProjectPath,
      openProjectSnapshot,
      replaceCurrent,
    ],
  );
}

import { useSetAtom, useStore } from 'jotai';
import type { GraphId, ProjectId } from '@valerypopoff/rivet2-core';
import { useRivetAppHostCallbacks } from '../../providers/HostCallbacksContext.js';
import { useIOProvider } from '../../providers/ProvidersContext.js';
import { openedProjectSnapshotsState, projectsState, projectState } from '../../state/savedGraphs.js';
import { openingProjectTabsState, selectedOpeningProjectTabIdState } from '../../state/openingProjectTabs.js';
import { projectTabUiState, updateProjectTabUiState } from '../../state/projectTabUi.js';
import { isPathBasedIOProvider } from '../../io/IOProvider.js';
import { addOpenedProject, removeOpenedProject } from '../../utils/openedProjects.js';
import { handleError } from '../../utils/errorHandling.js';
import { useLoadProject } from '../useLoadProject.js';
import { useStableCallback } from '../useStableCallback.js';
import { useWorkspaceTransitions } from '../useWorkspaceTransitions.js';
import { normalizeProjectSnapshot } from './projectSnapshot.js';
import { useWorkspaceHostProjectCleanup } from './useWorkspaceHostProjectCleanup.js';
import { flushHybridStorageGroup } from '../../state/storage.js';
import { runLatestProjectActivation } from '../../utils/projectActivationCoordinator.js';
import type {
  RivetProjectReplaceOptions,
  RivetProjectSnapshotInput,
  WorkspaceHostOpenProjectSnapshotOptions,
} from './types.js';

export function useWorkspaceHostOpenProject() {
  const ioProvider = useIOProvider();
  const callbacks = useRivetAppHostCallbacks();
  const workspaceTransitions = useWorkspaceTransitions();
  const loadProject = useLoadProject();
  const store = useStore();
  const setProjects = useSetAtom(projectsState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const setProjectTabUiStates = useSetAtom(projectTabUiState);
  const setSelectedOpeningProjectTabId = useSetAtom(selectedOpeningProjectTabIdState);
  const cleanupClosedProject = useWorkspaceHostProjectCleanup();

  const activateProject = useStableCallback(async (projectId: ProjectId, options?: { preferredGraphId?: GraphId }) => {
    const projectInfo = store.get(projectsState).openedProjects[projectId];
    if (!projectInfo) {
      return false;
    }

    const loaded = await loadProject(projectInfo, options);
    if (loaded) {
      setSelectedOpeningProjectTabId(undefined);
    }
    return loaded;
  });

  const commitProjectSnapshot = useStableCallback(
    async (snapshot: RivetProjectSnapshotInput, options: WorkspaceHostOpenProjectSnapshotOptions = {}) => {
      const openingTabId = options.selectedOpeningProjectTabIdToClear;
      if (
        openingTabId &&
        openingTabId !== 'all' &&
        (!store.get(openingProjectTabsState)[openingTabId] ||
          store.get(selectedOpeningProjectTabIdState) !== openingTabId)
      )
        return false;
      const normalized = normalizeProjectSnapshot(snapshot);
      const projectId = normalized.project.metadata.id as ProjectId;
      const currentProjectId = store.get(projectState).metadata.id as ProjectId | undefined;
      const replaceTargetProjectId = options.replaceProjectId ?? currentProjectId;
      const replacedProjectId =
        options.replaceCurrent && replaceTargetProjectId && replaceTargetProjectId !== projectId
          ? replaceTargetProjectId
          : undefined;
      const existingExecutorMode = store.get(projectsState).openedProjects[projectId]?.executorMode;
      const executorMode = existingExecutorMode ?? options.executorMode;
      const shouldPreseedTabUiState = options.tabUi !== undefined;
      const previousTabUiState = store.get(projectTabUiState)[projectId];

      const restorePreseededTabUiState = () => {
        if (shouldPreseedTabUiState) {
          setProjectTabUiStates((states) => updateProjectTabUiState(states, projectId, previousTabUiState));
        }
      };

      if (shouldPreseedTabUiState) {
        setProjectTabUiStates((states) => updateProjectTabUiState(states, projectId, options.tabUi));
      }

      try {
        const onLoaded = () => {
          // A tab must never outlive its initial snapshot. Inactive tabs use this
          // persisted content when they are switched back to after a reload.
          setOpenedProjectSnapshots((previousSnapshots) => ({
            ...previousSnapshots,
            [projectId]: {
              project: normalized.project,
              data: normalized.data,
            },
          }));

          setProjects((previousProjects) => {
            const replacedProjectIndex =
              replacedProjectId != null ? previousProjects.openedProjectsSortedIds.indexOf(replacedProjectId) : -1;
            const withoutReplacedProject = replacedProjectId
              ? removeOpenedProject(previousProjects, replacedProjectId)
              : previousProjects;
            const nextExecutorMode = previousProjects.openedProjects[projectId]?.executorMode ?? executorMode;

            const withOpenedProject = addOpenedProject(
              withoutReplacedProject,
              {
                ...normalized.project,
                data: normalized.data,
              },
              {
                fsPath: snapshot.path,
                openedGraph: snapshot.openedGraph ?? normalized.graphToLoad?.metadata?.id,
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
          setSelectedOpeningProjectTabId((selectedId) =>
            openingTabSelectionToClear === 'all' || selectedId === openingTabSelectionToClear ? undefined : selectedId,
          );

          if (replacedProjectId) {
            cleanupClosedProject(replacedProjectId);
          }
        };
        const loaded = await workspaceTransitions.loadProject({
          project: normalized.project,
          data: normalized.data,
          fsPath: snapshot.path,
          openedGraph: snapshot.openedGraph,
          graphToLoad: normalized.graphToLoad,
          evaluationData: snapshot.evaluationData,
          evaluationDatasets: snapshot.evaluationDatasets,
          executorMode,
          markClean: true,
          onLoaded,
        });

        if (!loaded) {
          restorePreseededTabUiState();
          return false;
        }

        void flushHybridStorageGroup('project').catch((error) => {
          // The project is already open in memory. Keep it usable and let the
          // normal persistence diagnostics report the failed durable write.
          console.error('Failed to persist opened project workspace state:', error);
        });

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

  const openProjectSnapshot = useStableCallback(
    (snapshot: RivetProjectSnapshotInput, options?: WorkspaceHostOpenProjectSnapshotOptions) => {
      const openingTabId = options?.selectedOpeningProjectTabIdToClear;
      if (
        openingTabId &&
        openingTabId !== 'all' &&
        (!store.get(openingProjectTabsState)[openingTabId] ||
          store.get(selectedOpeningProjectTabIdState) !== openingTabId)
      ) {
        return Promise.resolve(false);
      }
      return runLatestProjectActivation(store, () => commitProjectSnapshot(snapshot, options));
    },
  );

  const openProjectPath = useStableCallback((path: string) => {
    const alreadyOpenedProject = Object.values(store.get(projectsState).openedProjects).find(
      (project) => project.fsPath === path,
    );
    if (alreadyOpenedProject) return activateProject(alreadyOpenedProject.projectId);
    return runLatestProjectActivation(store, async (isCurrent, signal) => {
      try {
        if (!isPathBasedIOProvider(ioProvider)) {
          throw new Error('The active IO provider does not support opening projects by path.');
        }

        const loadedProject = await ioProvider.loadProjectDataNoPrompt(path, { signal, deferCommit: true });
        const { project, evaluation } = loadedProject;
        if (!isCurrent()) return false;
        const existing = store.get(projectsState).openedProjects[project.metadata.id];
        if (existing) {
          throw new Error('A project with this ID is already open. Select its existing tab instead.');
        }
        if (loadedProject.commit && !(await loadedProject.commit(isCurrent))) return false;
        if (!isCurrent()) return false;
        const { data, ...projectWithoutData } = project;

        return await commitProjectSnapshot({
          project: projectWithoutData,
          data,
          path,
          evaluationData: evaluation.evaluationData,
          evaluationDatasets: evaluation.evaluationDatasets,
        });
      } catch (error) {
        if (!isCurrent()) return false;
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
  });

  const replaceCurrent = useStableCallback(
    (snapshot: RivetProjectSnapshotInput, options?: RivetProjectReplaceOptions) =>
      openProjectSnapshot(snapshot, { ...options, replaceCurrent: true }),
  );

  return {
    activateProject,
    openProjectSnapshot,
    openProjectPath,
    replaceCurrent,
  };
}

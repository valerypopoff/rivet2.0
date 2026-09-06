import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { useRivetAppHostCallbacks } from '../../providers/HostCallbacksContext.js';
import { useIOProvider } from '../../providers/ProvidersContext.js';
import { openedProjectSnapshotsState, projectsState, projectState } from '../../state/savedGraphs.js';
import { selectedOpeningProjectTabIdState } from '../../state/openingProjectTabs.js';
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
  const [projects, setProjects] = useAtom(projectsState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const [projectTabUiStates, setProjectTabUiStates] = useAtom(projectTabUiState);
  const currentProject = useAtomValue(projectState);
  const setSelectedOpeningProjectTabId = useSetAtom(selectedOpeningProjectTabIdState);
  const cleanupClosedProject = useWorkspaceHostProjectCleanup();

  const openProjectSnapshot = useStableCallback(
    async (snapshot: RivetProjectSnapshotInput, options: WorkspaceHostOpenProjectSnapshotOptions = {}) => {
      const normalized = normalizeProjectSnapshot(snapshot);
      const projectId = normalized.project.metadata.id as ProjectId;
      const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
      const replaceTargetProjectId = options.replaceProjectId ?? currentProjectId;
      const replacedProjectId =
        options.replaceCurrent && replaceTargetProjectId && replaceTargetProjectId !== projectId
          ? replaceTargetProjectId
          : undefined;
      const existingExecutorMode = store.get(projectsState).openedProjects[projectId]?.executorMode;
      const executorMode = existingExecutorMode ?? options.executorMode;
      const shouldPreseedTabUiState = options.tabUi !== undefined;
      const previousTabUiState = projectTabUiStates[projectId];

      const restorePreseededTabUiState = () => {
        if (shouldPreseedTabUiState) {
          setProjectTabUiStates((states) => updateProjectTabUiState(states, projectId, previousTabUiState));
        }
      };

      if (shouldPreseedTabUiState) {
        setProjectTabUiStates((states) => updateProjectTabUiState(states, projectId, options.tabUi));
      }

      try {
        const loaded = await workspaceTransitions.loadProject({
          project: normalized.project,
          data: normalized.data,
          fsPath: snapshot.path,
          openedGraph: snapshot.openedGraph,
          graphToLoad: snapshot.graphToLoad,
          evaluationData: snapshot.evaluationData,
          evaluationDatasets: snapshot.evaluationDatasets,
          executorMode,
          markClean: true,
        });

        if (!loaded) {
          restorePreseededTabUiState();
          return false;
        }

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
        setSelectedOpeningProjectTabId((selectedId) =>
          openingTabSelectionToClear === 'all' || selectedId === openingTabSelectionToClear ? undefined : selectedId,
        );

        if (replacedProjectId) {
          cleanupClosedProject(replacedProjectId);
        }

        try {
          await flushHybridStorageGroup('project');
        } catch (error) {
          // The project is already open in memory. Keep it usable and let the
          // normal persistence diagnostics report the failed durable write.
          console.error('Failed to persist opened project workspace state:', error);
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

      const { project, evaluation } = await ioProvider.loadProjectDataNoPrompt(path);
      const { data, ...projectWithoutData } = project;

      return await openProjectSnapshot({
        project: projectWithoutData,
        data,
        path,
        evaluationData: evaluation.evaluationData,
        evaluationDatasets: evaluation.evaluationDatasets,
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

  const replaceCurrent = useStableCallback(
    (snapshot: RivetProjectSnapshotInput, options?: RivetProjectReplaceOptions) =>
      openProjectSnapshot(snapshot, { ...options, replaceCurrent: true }),
  );

  return {
    openProjectSnapshot,
    openProjectPath,
    replaceCurrent,
  };
}

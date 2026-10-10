import { useSetAtom, useStore } from 'jotai';
import type { GraphId, ProjectId } from '@valerypopoff/rivet2-core';
import { useRivetAppHostCallbacks } from '../../providers/HostCallbacksContext.js';
import { useIOProvider } from '../../providers/ProvidersContext.js';
import { openedProjectSnapshotsState, projectsState, projectState } from '../../state/savedGraphs.js';
import { openingProjectTabsState, selectedOpeningProjectTabIdState } from '../../state/openingProjectTabs.js';
import { projectTabUiState, updateProjectTabUiState } from '../../state/projectTabUi.js';
import { isPathBasedIOProvider, type LoadedProjectData } from '../../io/IOProvider.js';
import { useWorkspaceHostCleanBaseline } from './useWorkspaceHostCleanBaseline.js';
import { evaluationLibraryState, mergeLegacyEvaluationLibrary } from '../../state/evaluations.js';
import { addOpenedProject, removeOpenedProject } from '../../utils/openedProjects.js';
import { handleError } from '../../utils/errorHandling.js';
import { useLoadProject } from '../useLoadProject.js';
import { useStableCallback } from '../useStableCallback.js';
import { useWorkspaceTransitions } from '../useWorkspaceTransitions.js';
import { normalizeProjectSnapshot } from './projectSnapshot.js';
import { useWorkspaceHostProjectCleanup } from './useWorkspaceHostProjectCleanup.js';
import { flushHybridStorageGroup } from '../../state/storage.js';
import { getProjectActivationSignal, runLatestProjectActivation } from '../../utils/projectActivationCoordinator.js';
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
  const { markProjectClean } = useWorkspaceHostCleanBaseline();

  const activateProject = useStableCallback(
    async (
      projectId: ProjectId,
      options?: { preferredGraphId?: GraphId },
      intent?: Parameters<typeof loadProject>[2],
    ) => {
      const projectInfo = store.get(projectsState).openedProjects[projectId];
      if (!projectInfo) {
        return false;
      }

      const loaded = await loadProject(projectInfo, options, intent);
      const current = !intent || intent.isCurrent();
      if (loaded && current) {
        setSelectedOpeningProjectTabId(undefined);
      }
      return loaded && current;
    },
  );

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

  const openLoadedProject = useStableCallback(async (loaded: LoadedProjectData, isCurrent: () => boolean) => {
    if (!isCurrent()) return false;
    const members = loaded.bundleProjects ?? [
      { project: loaded.project, path: loaded.path, evaluation: loaded.evaluation },
    ];
    const existingProjects = store.get(projectsState).openedProjects;
    for (const member of members) {
      const existing = existingProjects[member.project.metadata.id];
      if (existing && existing.fsPath !== member.path)
        throw new Error(
          `A different project with ID ${member.project.metadata.id} is already open. Close its tab first.`,
        );
    }
    const isWorkspaceCurrent = () =>
      isCurrent() &&
      members.every((member) => {
        const id = member.project.metadata.id;
        const current = store.get(projectsState).openedProjects[id];
        const previous = existingProjects[id];
        return previous
          ? current !== undefined &&
              current.fsPath === member.path &&
              current.bundleManifestPath === previous.bundleManifestPath
          : current === undefined;
      });
    const activateExisting = () =>
      activateProject(loaded.project.metadata.id, undefined, {
        isCurrent: isWorkspaceCurrent,
        signal: getProjectActivationSignal(store),
        bundleManifestPath: loaded.bundleManifestPath,
      });
    const skip = new Set(Object.keys(existingProjects) as ProjectId[]);
    // Existing individual members retain their live datasets and edits, but
    // still pass through membership registration after activation.
    if (
      loaded.commit &&
      (loaded.bundleProjects || !existingProjects[loaded.project.metadata.id]) &&
      !(await loaded.commit(isWorkspaceCurrent, skip))
    )
      return false;
    if (!isWorkspaceCurrent()) return false;
    const { data, ...project } = loaded.project;
    const opened = skip.has(loaded.project.metadata.id)
      ? await activateExisting()
      : await commitProjectSnapshot({
          project,
          data,
          path: loaded.path,
          evaluationData: loaded.evaluation.evaluationData,
          evaluationDatasets: loaded.evaluation.evaluationDatasets,
        });
    if (!opened || !isCurrent()) return false;
    // Register inactive snapshots without switching tabs or replacing existing edits.
    for (const member of members) {
      const id = member.project.metadata.id;
      if (!store.get(projectsState).openedProjects[id]) {
        const { data, ...project } = member.project;
        setOpenedProjectSnapshots((previous) => ({ ...previous, [id]: { project, data } }));
        setProjects((previous) => addOpenedProject(previous, member.project, { fsPath: member.path }));
        store.set(evaluationLibraryState, (library) =>
          mergeLegacyEvaluationLibrary(
            library,
            member.evaluation.evaluationData,
            member.evaluation.evaluationDatasets,
            id,
          ),
        );
        void markProjectClean(id, { project, data });
      }
      if (loaded.bundleManifestPath)
        store.set(projectsState, (previous) => ({
          ...previous,
          openedProjects: {
            ...previous.openedProjects,
            [id]: { ...previous.openedProjects[id]!, bundleManifestPath: loaded.bundleManifestPath },
          },
        }));
    }
    void flushHybridStorageGroup('project').catch((error) => console.error('Failed to persist bundle tabs:', error));
    return true;
  });

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
        return await openLoadedProject({ ...loadedProject, path: loadedProject.path ?? path }, isCurrent);
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
    openLoadedProject,
    replaceCurrent,
  };
}

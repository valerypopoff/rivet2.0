import { useStore } from 'jotai';
import { toast } from 'react-toastify';
import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { ProjectExecutorMode } from '../../app/src/utils/projectExecutorMode.js';
import type { LoadedProjectData, ProjectLoadOptions } from '../../app/src/io/IOProvider.js';
import {
  type OpenedProjectInfo,
  type OpenedProjectsInfo,
  loadedProjectState,
  projectsState,
} from '../../app/src/state/savedGraphs';
import { useIOProvider, type RivetProjectSnapshotInput, type RivetWorkspaceHost } from '../../app/src/host';
import { primeOpenedProjectSession } from '../io/openedProjectSessionCache';
import { resolveHostedProjectTitle, withHostedProjectTitle } from './openedProjectMetadata';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';
import { resolveProjectGraphId } from '../../app/src/utils/projectEditorState.js';
import {
  getProjectActivationRevision,
  getProjectActivationSignal,
  supersedeProjectActivation,
} from '../../app/src/utils/projectActivationCoordinator.js';

type OpenWorkflowProjectOptions = {
  executorMode?: ProjectExecutorMode;
  replaceCurrent?: boolean;
  reloadFromDisk?: boolean;
  preferredGraphId?: GraphId;
  expectedProjectId?: ProjectId;
  skipReplaceConfirmation?: boolean;
  previewTab?: boolean;
  openingTabId?: string;
  openedProjectId?: ProjectId;
};

type OpenWorkflowProjectResult = {
  opened: boolean;
  projectId?: ProjectId;
};

type ProjectSnapshot = Pick<RivetProjectSnapshotInput, 'project' | 'data'>;
type ProjectPathLoader = {
  loadProjectDataNoPrompt(path: string, options?: ProjectLoadOptions): Promise<LoadedProjectData>;
};

function canLoadProjectByPath(provider: unknown): provider is ProjectPathLoader {
  return (
    typeof provider === 'object' &&
    provider != null &&
    typeof (provider as Partial<ProjectPathLoader>).loadProjectDataNoPrompt === 'function'
  );
}

function getActiveOpenedProjectIds(projects: OpenedProjectsInfo): ProjectId[] {
  return projects.openedProjectsSortedIds.filter((projectId) => projects.openedProjects[projectId] != null);
}

function getOpenedProjectsByIds(projects: OpenedProjectsInfo, projectIds: ProjectId[]): OpenedProjectInfo[] {
  return projectIds.map((projectId) => projects.openedProjects[projectId]!);
}

function splitProjectSnapshot(project: Project): ProjectSnapshot {
  const { data, ...projectWithoutData } = project;

  return {
    project: projectWithoutData,
    data,
  };
}

function getProjectTabUiOptions(previewTab: boolean | undefined) {
  return previewTab === undefined
    ? undefined
    : {
        tabUi: {
          preview: previewTab,
        },
      };
}

export function useOpenWorkflowProject(workspace: RivetWorkspaceHost) {
  const store = useStore();
  const ioProvider = useIOProvider();

  return async (filePath: string, options?: OpenWorkflowProjectOptions): Promise<OpenWorkflowProjectResult> => {
    const replaceCurrent = options?.replaceCurrent ?? false;
    const reloadFromDisk = options?.reloadFromDisk ?? false;
    const preferredGraphId = options?.preferredGraphId;
    const expectedProjectId = options?.expectedProjectId;
    const skipReplaceConfirmation = options?.skipReplaceConfirmation ?? false;
    const openingTabId = options?.openingTabId;
    const tabUiOptions = getProjectTabUiOptions(options?.previewTab);
    const workspaceOpenOptions = options?.executorMode
      ? { ...tabUiOptions, executorMode: options.executorMode }
      : tabUiOptions;
    const normalizedFilePath = normalizeWorkflowPath(filePath);
    const latestLoadedProject = store.get(loadedProjectState);
    const latestProjects = store.get(projectsState);
    const activeOpenedProjectIds = getActiveOpenedProjectIds(latestProjects);
    const activeOpenedProjects = getOpenedProjectsByIds(latestProjects, activeOpenedProjectIds);
    const isSwitchingProjects =
      replaceCurrent &&
      Boolean(latestLoadedProject.path) &&
      normalizeWorkflowPath(latestLoadedProject.path) !== normalizedFilePath;
    const isLeavingUnsavedScratchProject =
      replaceCurrent && !latestLoadedProject.path && activeOpenedProjectIds.length > 0;
    const cancelOpeningTab = async () => {
      if (!openingTabId) {
        return;
      }

      try {
        await workspace.cancelOpeningProjectTab(openingTabId);
      } catch (error) {
        console.warn('Failed to cancel project opening tab:', error);
      }
    };

    const alreadyOpenByPath = activeOpenedProjects.find(
      (projectInfo) =>
        normalizeWorkflowPath(projectInfo.fsPath ?? '') === normalizedFilePath ||
        (options?.openedProjectId != null && projectInfo.projectId === options.openedProjectId),
    );

    // Register the intent before path IO, not only when its result arrives.
    // A later tab click must win over a delayed new open or explicit reload.
    if ((!alreadyOpenByPath || reloadFromDisk) && !openingTabId) supersedeProjectActivation(store);
    const selectionRevision = getProjectActivationRevision(store);
    const signal = getProjectActivationSignal(store);
    const isCurrent = () => getProjectActivationRevision(store) === selectionRevision && !signal.aborted;
    const loadOptions = { signal, deferCommit: true };
    const commitCurrent = async (loaded: LoadedProjectData, canCommit = isCurrent): Promise<boolean> => {
      try {
        return canCommit() && (!loaded.commit || (await loaded.commit(canCommit))) && canCommit();
      } catch (error) {
        if (!canCommit()) return false;
        throw error;
      }
    };

    if (
      !skipReplaceConfirmation &&
      (!alreadyOpenByPath || reloadFromDisk) &&
      (isSwitchingProjects || isLeavingUnsavedScratchProject)
    ) {
      const shouldContinue = window.confirm(
        'Switch projects? Unsaved edits in the current editor may be lost if you have not saved them yet.',
      );

      if (!shouldContinue) {
        await cancelOpeningTab();
        return { opened: false };
      }
    }

    if (alreadyOpenByPath) {
      if (expectedProjectId && alreadyOpenByPath.projectId !== expectedProjectId) {
        throw new Error('The selected Subgraph project changed identity. Refresh its target and try again.');
      }
      // Tree activation is tab selection, not a fresh load. The workspace owns
      // the live graph, dirty baseline, viewport and inactive-tab snapshot.
      if (!reloadFromDisk) {
        await cancelOpeningTab();
        const activating = workspace.activateProject(alreadyOpenByPath.projectId, { preferredGraphId });
        const activationRevision = getProjectActivationRevision(store);
        const opened = await activating;
        if (!opened) {
          if (getProjectActivationRevision(store) !== activationRevision) return { opened: false };
          throw new Error(`Failed to activate "${alreadyOpenByPath.title}".`);
        }
        if (tabUiOptions) {
          await workspace.setProjectTabUiState(alreadyOpenByPath.projectId, tabUiOptions.tabUi);
        }
        return { opened: true, projectId: alreadyOpenByPath.projectId };
      }

      if (!canLoadProjectByPath(ioProvider)) {
        throw new Error('The active IO provider does not support reloading projects by path.');
      }
      const isReloadCurrent = () => {
        const latest = store.get(projectsState).openedProjects[alreadyOpenByPath.projectId];
        return isCurrent() && latest !== undefined && latest.fsPath === alreadyOpenByPath.fsPath;
      };
      let loadedProject: LoadedProjectData;
      try {
        loadedProject = await ioProvider.loadProjectDataNoPrompt(filePath, loadOptions);
      } catch (error) {
        await cancelOpeningTab();
        if (!isCurrent()) return { opened: false };
        throw error;
      }
      if (!isCurrent()) {
        await cancelOpeningTab();
        return { opened: false };
      }
      const latestInfo = store.get(projectsState).openedProjects[alreadyOpenByPath.projectId];
      if (!latestInfo || latestInfo.fsPath !== alreadyOpenByPath.fsPath) return { opened: false };
      const reloadedProject = withHostedProjectTitle(loadedProject.project, filePath);
      if (reloadedProject.metadata.id !== alreadyOpenByPath.projectId) {
        throw new Error(
          `Reloaded project "${resolveHostedProjectTitle(reloadedProject, filePath)}" has a different project ID. Close the existing tab before reopening it.`,
        );
      }
      const snapshot = splitProjectSnapshot(reloadedProject);
      const evaluation = loadedProject.evaluation;
      if (preferredGraphId && !snapshot.project.graphs[preferredGraphId]) {
        throw new Error('The selected Subgraph graph is no longer in the open project.');
      }
      if (!(await commitCurrent(loadedProject, isReloadCurrent))) return { opened: false };

      const openedGraph = resolveProjectGraphId(snapshot.project, {
        explicitGraphId: preferredGraphId,
        openedGraphId: alreadyOpenByPath.openedGraph,
      });
      await cancelOpeningTab();
      if (!isReloadCurrent()) return { opened: false };
      const projectInput = {
        ...snapshot,
        path: filePath,
        openedGraph,
        graphToLoad: preferredGraphId ? snapshot.project.graphs[preferredGraphId] : undefined,
        evaluationData: evaluation.evaluationData,
        evaluationDatasets: evaluation.evaluationDatasets,
      };
      const activating = replaceCurrent
        ? workspace.replaceCurrent(projectInput, workspaceOpenOptions)
        : workspace.openProjectSnapshot(projectInput, workspaceOpenOptions);
      const activationRevision = getProjectActivationRevision(store);
      const opened = await activating;

      if (!opened) {
        if (getProjectActivationRevision(store) !== activationRevision) return { opened: false };
        throw new Error(`Failed to activate "${alreadyOpenByPath.title}".`);
      }

      primeOpenedProjectSession(alreadyOpenByPath.projectId, {
        fsPath: filePath,
        evaluation,
      });

      return {
        opened: true,
        projectId: alreadyOpenByPath.projectId,
      };
    }

    if (!canLoadProjectByPath(ioProvider)) {
      await cancelOpeningTab();
      throw new Error('The active IO provider does not support opening projects by path.');
    }

    let loadedProjectData: Awaited<ReturnType<typeof ioProvider.loadProjectDataNoPrompt>>;
    try {
      loadedProjectData = await ioProvider.loadProjectDataNoPrompt(filePath, loadOptions);
    } catch (error) {
      await cancelOpeningTab();
      if (!isCurrent()) return { opened: false };
      throw error;
    }

    const { project: loadedProject, evaluation } = loadedProjectData;
    if (!isCurrent()) {
      await cancelOpeningTab();
      return { opened: false };
    }
    const project = withHostedProjectTitle(loadedProject, filePath);
    if (expectedProjectId && project.metadata.id !== expectedProjectId) {
      throw new Error('The selected Subgraph project changed identity. Refresh its target and try again.');
    }
    if (preferredGraphId && !project.graphs[preferredGraphId]) {
      throw new Error('The selected Subgraph graph is no longer in the saved project.');
    }
    const conflictingProject = store.get(projectsState).openedProjects[project.metadata.id];

    if (conflictingProject) {
      await cancelOpeningTab();
      toast.error(
        `"${conflictingProject.title} [${conflictingProject.fsPath?.split('/').pop() ?? 'no path'}]" shares the same ID (${project.metadata.id}) and is already open. Please close that project first.`,
      );
      return { opened: false };
    }

    const snapshot = splitProjectSnapshot(project);
    if (!(await commitCurrent(loadedProjectData))) return { opened: false };
    if (!isCurrent()) return { opened: false };
    const openedGraph = resolveProjectGraphId(project, { explicitGraphId: preferredGraphId });
    const projectId = project.metadata.id as ProjectId;
    const projectInput = {
      ...snapshot,
      path: filePath,
      openedGraph,
      // Subgraph navigation is an explicit graph selection, not a restore
      // fallback. Remembered navigation must not override the requested graph.
      graphToLoad: preferredGraphId ? snapshot.project.graphs[preferredGraphId] : undefined,
      evaluationData: evaluation.evaluationData,
      evaluationDatasets: evaluation.evaluationDatasets,
    } satisfies RivetProjectSnapshotInput;

    let opened = false;
    let activationRevision = selectionRevision;
    try {
      const activating = openingTabId
        ? workspace.finishOpeningProjectTab(openingTabId, projectInput, workspaceOpenOptions)
        : replaceCurrent
          ? workspace.replaceCurrent(projectInput, workspaceOpenOptions)
          : workspace.openProjectSnapshot(projectInput, workspaceOpenOptions);
      activationRevision = getProjectActivationRevision(store);
      opened = await activating;
    } catch (error) {
      await cancelOpeningTab();
      throw error;
    }

    if (!opened) {
      if (openingTabId) {
        await cancelOpeningTab();
        return { opened: false };
      }

      if (getProjectActivationRevision(store) !== activationRevision) return { opened: false };
      throw new Error(`Failed to activate "${resolveHostedProjectTitle(project, filePath)}".`);
    }

    primeOpenedProjectSession(projectId, {
      fsPath: filePath,
      evaluation,
    });

    return {
      opened: true,
      projectId,
    };
  };
}

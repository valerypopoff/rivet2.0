import { useSetAtom, useStore } from 'jotai';
import { toast } from 'react-toastify';
import type { GraphId, NodeGraph, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { TrivetData } from '@valerypopoff/trivet';
import {
  type OpenedProjectInfo,
  type OpenedProjectsInfo,
  type OpenedProjectSnapshot,
  loadedProjectState,
  openedProjectSnapshotsState,
  projectDataState,
  projectState,
  projectsState,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import {
  useIOProvider,
  type RivetProjectSnapshotInput,
  type RivetWorkspaceHost,
} from '../../../rivet/packages/app/src/host';
import {
  getOpenedProjectSession,
  primeOpenedProjectSession,
} from '../io/openedProjectSessionCache';
import { resolveHostedProjectTitle, withHostedProjectTitle } from './openedProjectMetadata';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';

type OpenWorkflowProjectOptions = {
  replaceCurrent?: boolean;
  reloadFromDisk?: boolean;
  preferredGraphId?: GraphId;
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
  loadProjectDataNoPrompt(path: string): Promise<{ project: Project; testData: TrivetData }>;
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

function getSnapshotForOpenedProject(options: {
  currentProject: Omit<Project, 'data'>;
  currentProjectData: Project['data'] | undefined;
  openedProject: OpenedProjectInfo;
  snapshots: Record<ProjectId, OpenedProjectSnapshot>;
}): ProjectSnapshot | null {
  if (options.currentProject.metadata.id === options.openedProject.projectId) {
    return {
      project: options.currentProject,
      data: options.currentProjectData,
    };
  }

  return options.snapshots[options.openedProject.projectId] ?? null;
}

function resolveOpenedGraph(project: Omit<Project, 'data'>, preferredGraphId?: GraphId): GraphId | undefined {
  if (preferredGraphId && project.graphs[preferredGraphId]) {
    return preferredGraphId;
  }

  if (project.metadata.mainGraphId && project.graphs[project.metadata.mainGraphId]) {
    return project.metadata.mainGraphId;
  }

  return (Object.values(project.graphs) as NodeGraph[])
    .sort((a, b) => (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''))[0]?.metadata?.id;
}

function retainOnlyOpenedProject(projects: OpenedProjectsInfo, projectId: ProjectId): OpenedProjectsInfo {
  const projectInfo = projects.openedProjects[projectId];
  if (!projectInfo) {
    return projects;
  }

  return {
    openedProjects: {
      [projectId]: projectInfo,
    } as Record<ProjectId, OpenedProjectInfo>,
    openedProjectsSortedIds: [projectId],
  };
}

function retainOnlySnapshot(
  snapshots: Record<ProjectId, OpenedProjectSnapshot>,
  projectId: ProjectId,
): Record<ProjectId, OpenedProjectSnapshot> {
  const snapshot = snapshots[projectId];
  return snapshot ? ({ [projectId]: snapshot } as Record<ProjectId, OpenedProjectSnapshot>) : {};
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
  const setProjects = useSetAtom(projectsState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);

  return async (filePath: string, options?: OpenWorkflowProjectOptions): Promise<OpenWorkflowProjectResult> => {
    const replaceCurrent = options?.replaceCurrent ?? false;
    const reloadFromDisk = options?.reloadFromDisk ?? false;
    const preferredGraphId = options?.preferredGraphId;
    const skipReplaceConfirmation = options?.skipReplaceConfirmation ?? false;
    const openingTabId = options?.openingTabId;
    const tabUiOptions = getProjectTabUiOptions(options?.previewTab);
    const normalizedFilePath = normalizeWorkflowPath(filePath);
    const latestLoadedProject = store.get(loadedProjectState);
    const latestCurrentProject = store.get(projectState);
    const latestCurrentProjectData = store.get(projectDataState);
    const latestProjects = store.get(projectsState);
    const latestOpenedProjectSnapshots = store.get(openedProjectSnapshotsState);
    const activeOpenedProjectIds = getActiveOpenedProjectIds(latestProjects);
    const activeOpenedProjects = getOpenedProjectsByIds(latestProjects, activeOpenedProjectIds);
    const resetOpenProjectState = activeOpenedProjectIds.length === 0;
    const isSwitchingProjects =
      replaceCurrent &&
      Boolean(latestLoadedProject.path) &&
      normalizeWorkflowPath(latestLoadedProject.path) !== normalizedFilePath;
    const isLeavingUnsavedScratchProject = replaceCurrent && !latestLoadedProject.path && activeOpenedProjectIds.length > 0;
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

    if (!skipReplaceConfirmation && (isSwitchingProjects || isLeavingUnsavedScratchProject)) {
      const shouldContinue = window.confirm(
        'Switch projects? Unsaved edits in the current editor may be lost if you have not saved them yet.',
      );

      if (!shouldContinue) {
        await cancelOpeningTab();
        return { opened: false };
      }
    }

    const alreadyOpenByPath = activeOpenedProjects.find((projectInfo) =>
      normalizeWorkflowPath(projectInfo.fsPath ?? '') === normalizedFilePath ||
      (options?.openedProjectId != null && projectInfo.projectId === options.openedProjectId));

    if (alreadyOpenByPath) {
      let snapshot = reloadFromDisk
        ? null
        : getSnapshotForOpenedProject({
            currentProject: latestCurrentProject,
            currentProjectData: latestCurrentProjectData,
            openedProject: alreadyOpenByPath,
            snapshots: latestOpenedProjectSnapshots,
          });
      let testSuites = reloadFromDisk
        ? undefined
        : getOpenedProjectSession(alreadyOpenByPath.projectId, filePath)?.testSuites;
      let refreshedTestData: TrivetData | null = null;
      const projectPathLoader = canLoadProjectByPath(ioProvider) ? ioProvider : null;

      if (reloadFromDisk && !projectPathLoader) {
        throw new Error('The active IO provider does not support reloading projects by path.');
      }

      if ((reloadFromDisk || !snapshot || !testSuites) && projectPathLoader) {
        const loadedProject = await projectPathLoader.loadProjectDataNoPrompt(filePath);
        const reloadedProject = withHostedProjectTitle(loadedProject.project, filePath);
        if (reloadFromDisk && reloadedProject.metadata.id !== alreadyOpenByPath.projectId) {
          throw new Error(
            `Reloaded project "${resolveHostedProjectTitle(reloadedProject, filePath)}" has a different project ID. Close the existing tab before reopening it.`,
          );
        }

        snapshot = reloadFromDisk ? splitProjectSnapshot(reloadedProject) : snapshot ?? splitProjectSnapshot(reloadedProject);
        testSuites = loadedProject.testData.testSuites;
        refreshedTestData = loadedProject.testData;
      }

      if (!snapshot) {
        throw new Error(`No in-memory snapshot is available for "${alreadyOpenByPath.title}".`);
      }

      const openedGraph = resolveOpenedGraph(snapshot.project, preferredGraphId) ?? alreadyOpenByPath.openedGraph;
      await cancelOpeningTab();
      const opened = replaceCurrent
        ? await workspace.replaceCurrent(
            {
              ...snapshot,
              path: filePath,
              openedGraph,
              testSuites,
            },
            tabUiOptions,
          )
        : await workspace.openProjectSnapshot(
            {
              ...snapshot,
              path: filePath,
              openedGraph,
              testSuites,
            },
            tabUiOptions,
          );

      if (!opened) {
        throw new Error(`Failed to activate "${alreadyOpenByPath.title}".`);
      }

      if (refreshedTestData) {
        primeOpenedProjectSession(alreadyOpenByPath.projectId, {
          fsPath: filePath,
          testData: refreshedTestData,
        });
      }

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
      loadedProjectData = await ioProvider.loadProjectDataNoPrompt(filePath);
    } catch (error) {
      await cancelOpeningTab();
      throw error;
    }

    const { project: loadedProject, testData } = loadedProjectData;
    const project = withHostedProjectTitle(loadedProject, filePath);
    const conflictingProject = activeOpenedProjects.find((projectInfo) => projectInfo.projectId === project.metadata.id);

    if (conflictingProject) {
      await cancelOpeningTab();
      toast.error(
        `"${conflictingProject.title} [${conflictingProject.fsPath?.split('/').pop() ?? 'no path'}]" shares the same ID (${project.metadata.id}) and is already open. Please close that project first.`,
      );
      return { opened: false };
    }

    const snapshot = splitProjectSnapshot(project);
    const openedGraph = resolveOpenedGraph(project, preferredGraphId);
    const projectId = project.metadata.id as ProjectId;
    const projectInput = {
      ...snapshot,
      path: filePath,
      openedGraph,
      testSuites: testData.testSuites,
    } satisfies RivetProjectSnapshotInput;

    let opened = false;
    try {
      opened = openingTabId
        ? await workspace.finishOpeningProjectTab(openingTabId, projectInput, tabUiOptions)
        : replaceCurrent
          ? await workspace.replaceCurrent(projectInput, tabUiOptions)
          : await workspace.openProjectSnapshot(projectInput, tabUiOptions);
    } catch (error) {
      await cancelOpeningTab();
      throw error;
    }

    if (!opened) {
      if (openingTabId) {
        await cancelOpeningTab();
        return { opened: false };
      }

      throw new Error(`Failed to activate "${resolveHostedProjectTitle(project, filePath)}".`);
    }

    primeOpenedProjectSession(projectId, {
      fsPath: filePath,
      testData,
    });

    if (resetOpenProjectState) {
      // When the visible tab strip is empty, discard hidden persisted tabs only
      // after the upstream host has opened the requested project.
      setProjects((previousProjects) => retainOnlyOpenedProject(previousProjects, projectId));
      setOpenedProjectSnapshots((previousSnapshots) => retainOnlySnapshot(previousSnapshots, projectId));
    }

    return {
      opened: true,
      projectId,
    };
  };
}

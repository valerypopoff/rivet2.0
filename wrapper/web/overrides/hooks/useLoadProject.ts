import { getError } from '@valerypopoff/rivet2-core';
import {
  loadedProjectState,
  type OpenedProjectSnapshot,
  openedProjectSnapshotsState,
  type OpenedProjectInfo,
  projectDataState,
  projectState,
} from '../../../../rivet/packages/app/src/state/savedGraphs.js';
import { isPathBasedIOProvider } from '../../../../rivet/packages/app/src/io/IOProvider.js';
import { useIOProvider } from '../../../../rivet/packages/app/src/providers/ProvidersContext.js';
import { useWorkspaceTransitions } from '../../../../rivet/packages/app/src/hooks/useWorkspaceTransitions.js';
import type { TrivetState } from '../../../../rivet/packages/app/src/state/trivet.js';
import { toast } from 'react-toastify';
import { useStore } from 'jotai';
import { getOpenedProjectSession, primeOpenedProjectSession } from '../../io/openedProjectSessionCache.js';

export function useLoadProject() {
  const store = useStore();
  const ioProvider = useIOProvider();
  const workspaceTransitions = useWorkspaceTransitions();

  return async (projectInfo: OpenedProjectInfo, providedSnapshot?: OpenedProjectSnapshot): Promise<boolean> => {
    try {
      const currentProject = store.get(projectState);
      const currentProjectData = store.get(projectDataState);
      const loadedProject = store.get(loadedProjectState);
      const openedProjectSnapshots = store.get(openedProjectSnapshotsState);
      const nextProjectPath = projectInfo.fsPath ?? '';
      if (
        currentProject.metadata.id === projectInfo.projectId &&
        loadedProject.loaded &&
        loadedProject.path === nextProjectPath
      ) {
        return true;
      }

      const activeProjectSnapshot =
        currentProject.metadata.id === projectInfo.projectId
          ? {
              project: currentProject,
              data: currentProjectData,
            }
          : undefined;
      const storedSnapshot = activeProjectSnapshot ?? providedSnapshot ?? openedProjectSnapshots[projectInfo.projectId];
      let project = storedSnapshot?.project;
      let data = storedSnapshot?.data;
      let markClean = false;
      let testSuites: TrivetState['testSuites'] = [];

      if (projectInfo.fsPath && isPathBasedIOProvider(ioProvider)) {
        let testData = getOpenedProjectSession(projectInfo.projectId, projectInfo.fsPath);

        if (!testData) {
          const loadedProject = await ioProvider.loadProjectDataNoPrompt(projectInfo.fsPath);
          markClean = !project;
          project ??= loadedProject.project;
          data ??= loadedProject.project.data;
          testData = loadedProject.testData;
          primeOpenedProjectSession(projectInfo.projectId, {
            fsPath: projectInfo.fsPath,
            testData,
          });
        }

        testSuites = testData.testSuites;
      }

      if (!project) {
        throw new Error(`No in-memory snapshot is available for "${projectInfo.title}".`);
      }

      return await workspaceTransitions.loadProject({
        project,
        data,
        fsPath: projectInfo.fsPath,
        openedGraph: projectInfo.openedGraph,
        executorMode: projectInfo.executorMode,
        markClean,
        testSuites,
      });
    } catch (err) {
      toast.error(`Failed to load project: ${getError(err).message}`);
      return false;
    }
  };
}

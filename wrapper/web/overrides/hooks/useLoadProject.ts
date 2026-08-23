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
import type { EvaluationProjectFileData } from '../../../../rivet/packages/app/src/io/IOProvider.js';
import { toast } from 'react-toastify';
import { useStore } from 'jotai';
import { getOpenedProjectSession, primeOpenedProjectSession } from '../../io/openedProjectSessionCache.js';
import { normalizeHostedProjectExecutorMode } from '../utils/hostedExecutorMode';

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
      let evaluation: EvaluationProjectFileData | undefined;

      if (projectInfo.fsPath && isPathBasedIOProvider(ioProvider)) {
        let cachedEvaluation = getOpenedProjectSession(projectInfo.projectId, projectInfo.fsPath);

        if (!cachedEvaluation) {
          const loadedProject = await ioProvider.loadProjectDataNoPrompt(projectInfo.fsPath);
          markClean = !project;
          project ??= loadedProject.project;
          data ??= loadedProject.project.data;
          cachedEvaluation = loadedProject.evaluation;
          primeOpenedProjectSession(projectInfo.projectId, {
            fsPath: projectInfo.fsPath,
            evaluation: cachedEvaluation,
          });
        }

        evaluation = cachedEvaluation;
      }

      if (!project) {
        throw new Error(`No in-memory snapshot is available for "${projectInfo.title}".`);
      }

      return await workspaceTransitions.loadProject({
        project,
        data,
        fsPath: projectInfo.fsPath,
        openedGraph: projectInfo.openedGraph,
        executorMode: normalizeHostedProjectExecutorMode(projectInfo.executorMode),
        markClean,
        evaluationData: evaluation?.evaluationData,
        evaluationDatasets: evaluation?.evaluationDatasets,
      });
    } catch (err) {
      toast.error(`Failed to load project: ${getError(err).message}`);
      return false;
    }
  };
}

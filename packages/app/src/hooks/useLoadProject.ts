import { useAtomValue } from 'jotai';
import { isPathBasedIOProvider } from '../io/IOProvider.js';
import { useIOProvider } from '../providers/ProvidersContext.js';
import { openedProjectSnapshotsState, type OpenedProjectInfo, projectState } from '../state/savedGraphs.js';
import { handleError } from '../utils/errorHandling.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';
import type { EvaluationProjectFileData } from '../io/IOProvider.js';
import { useRivetAppHostCallbacks } from '../providers/HostCallbacksContext.js';

export function useLoadProject() {
  const ioProvider = useIOProvider();
  const callbacks = useRivetAppHostCallbacks();
  const workspaceTransitions = useWorkspaceTransitions();
  const currentProject = useAtomValue(projectState);
  const openedProjectSnapshots = useAtomValue(openedProjectSnapshotsState);

  return async (projectInfo: OpenedProjectInfo): Promise<boolean> => {
    try {
      if (currentProject.metadata.id === projectInfo.projectId) {
        return true;
      }

      const storedSnapshot = openedProjectSnapshots[projectInfo.projectId];

      let project = storedSnapshot?.project;
      let data = storedSnapshot?.data;
      let markClean = false;
      let evaluation: EvaluationProjectFileData | undefined;

      if (!project && projectInfo.fsPath && isPathBasedIOProvider(ioProvider)) {
        const loadedProject = await ioProvider.loadProjectDataNoPrompt(projectInfo.fsPath);
        project = loadedProject.project;
        data = loadedProject.project.data;
        markClean = true;
        evaluation = loadedProject.evaluation;
      } else if (projectInfo.fsPath && isPathBasedIOProvider(ioProvider)) {
        const loadedProject = await ioProvider.loadProjectDataNoPrompt(projectInfo.fsPath);
        evaluation = loadedProject.evaluation;
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
        evaluationData: evaluation?.evaluationData,
        evaluationDatasets: evaluation?.evaluationDatasets,
        markClean,
      });
    } catch (err) {
      callbacks.onOpenError?.({
        error: err,
        operation: 'loadProject',
        path: projectInfo.fsPath,
        projectId: projectInfo.projectId,
        openedGraph: projectInfo.openedGraph,
      });
      handleError(err, 'Failed to load opened project', {
        metadata: {
          fsPath: projectInfo.fsPath,
          openedGraph: projectInfo.openedGraph,
          projectId: projectInfo.projectId,
          projectTitle: projectInfo.title,
        },
      });
      return false;
    }
  };
}

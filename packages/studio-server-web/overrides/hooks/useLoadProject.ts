import { getError } from '@valerypopoff/rivet2-core';
import {
  loadedProjectState,
  type OpenedProjectSnapshot,
  openedProjectSnapshotsState,
  type OpenedProjectInfo,
  projectDataState,
  projectState,
} from '../../../app/src/state/savedGraphs.js';
import { isPathBasedIOProvider } from '../../../app/src/io/IOProvider.js';
import { useIOProvider } from '../../../app/src/providers/ProvidersContext.js';
import { useWorkspaceTransitions } from '../../../app/src/hooks/useWorkspaceTransitions.js';
import type { EvaluationProjectFileData } from '../../../app/src/io/IOProvider.js';
import { toast } from 'react-toastify';
import { useStore } from 'jotai';
import { getOpenedProjectSession, primeOpenedProjectSession } from '../../io/openedProjectSessionCache.js';
import { normalizeHostedProjectExecutorMode } from '../utils/hostedExecutorMode';
import { isValidOpenedProjectSnapshot } from '../../../app/src/utils/openedProjectSnapshots.js';
import { flushHybridStorageGroup } from '../../../app/src/state/storage.js';

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
      const storedSnapshot =
        activeProjectSnapshot ??
        (isValidOpenedProjectSnapshot(providedSnapshot, projectInfo.projectId) ? providedSnapshot : undefined) ??
        (isValidOpenedProjectSnapshot(openedProjectSnapshots[projectInfo.projectId], projectInfo.projectId)
          ? openedProjectSnapshots[projectInfo.projectId]
          : undefined);
      let project = storedSnapshot?.project;
      let data = storedSnapshot?.data;
      let markClean = false;
      let evaluation: EvaluationProjectFileData | undefined;
      let loadedProjectFromPath = false;

      if (projectInfo.fsPath && isPathBasedIOProvider(ioProvider)) {
        let cachedEvaluation = getOpenedProjectSession(projectInfo.projectId, projectInfo.fsPath);

        // The session cache deliberately contains Evaluation payloads only. It
        // cannot stand in for a project snapshot after browser state recovery.
        if (!project || !cachedEvaluation) {
          const loadedProject = await ioProvider.loadProjectDataNoPrompt(projectInfo.fsPath);
          markClean = !project;
          project ??= loadedProject.project;
          data ??= loadedProject.project.data;
          cachedEvaluation ??= loadedProject.evaluation;
          loadedProjectFromPath = true;
          primeOpenedProjectSession(projectInfo.projectId, {
            fsPath: projectInfo.fsPath,
            evaluation: cachedEvaluation,
          });
        }

        evaluation = cachedEvaluation;
      }

      if (!project) {
        throw new Error(
          `Project tab "${projectInfo.title}" cannot be restored because it has neither a saved server path nor a valid workspace snapshot. Close the tab and reopen the project from the project tree.`,
        );
      }

      const loaded = await workspaceTransitions.loadProject({
        project,
        data,
        fsPath: projectInfo.fsPath,
        openedGraph: projectInfo.openedGraph,
        executorMode: normalizeHostedProjectExecutorMode(projectInfo.executorMode),
        markClean,
        evaluationData: evaluation?.evaluationData,
        evaluationDatasets: evaluation?.evaluationDatasets,
      });

      if (loaded && loadedProjectFromPath) {
        store.set(openedProjectSnapshotsState, (previousSnapshots) => ({
          ...previousSnapshots,
          [projectInfo.projectId]: { project, data },
        }));
        try {
          await flushHybridStorageGroup('project');
        } catch (error) {
          // The project is already open in memory. A failed persistence write
          // must not turn a successful recovery into a failed tab activation.
          console.error('Failed to persist recovered hosted project snapshot:', error);
        }
      }

      return loaded;
    } catch (err) {
      toast.error(`Failed to load project: ${getError(err).message}`);
      return false;
    }
  };
}

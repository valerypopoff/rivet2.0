import { useStore } from 'jotai';
import { projectsState, type OpenedProjectInfo } from '../state/savedGraphs.js';
import { toast } from 'react-toastify';
import { useIOProvider } from '../providers/ProvidersContext.js';
import { handleError } from '../utils/errorHandling.js';
import { useWorkspaceHostOpenProject } from './workspaceHost/useWorkspaceHostOpenProject.js';
import {
  getProjectActivationRevision,
  getProjectActivationSignal,
  supersedeProjectActivation,
} from '../utils/projectActivationCoordinator.js';

export function useLoadProjectWithFileBrowser() {
  const ioProvider = useIOProvider();
  const store = useStore();
  const { activateProject, openProjectSnapshot } = useWorkspaceHostOpenProject();

  return async () => {
    // A file picker is a user interaction, not a timed preparation. Its IO
    // still belongs to this intent and may not commit after another selection.
    supersedeProjectActivation(store);
    const revision = getProjectActivationRevision(store);
    const signal = getProjectActivationSignal(store);
    const isCurrent = () => revision === getProjectActivationRevision(store) && !signal.aborted;
    try {
      await ioProvider.loadProjectData(
        async ({ project, evaluation, path, commit }) => {
          if (!isCurrent()) return;
          const { data, ...projectData } = project;
          const openedProjects = Object.values(store.get(projectsState).openedProjects) as OpenedProjectInfo[];

          const existing = openedProjects.find((p) => p.fsPath === path && p.projectId === project.metadata.id);
          if (existing) {
            await activateProject(existing.projectId);
            return;
          }

          const alreadyOpenedProject = openedProjects.find((p) => p.projectId === project.metadata.id);

          if (alreadyOpenedProject) {
            toast.error(
              `"${alreadyOpenedProject.title} [${
                alreadyOpenedProject.fsPath?.split('/').pop() ?? 'no path'
              }]" shares the same ID (${
                project.metadata.id
              }) and is already open. Please close that project first to open this one.`,
            );
            return;
          }

          if (commit && !(await commit(isCurrent))) return;
          if (!isCurrent()) return;
          await openProjectSnapshot({
            project: projectData,
            data,
            path,
            evaluationData: evaluation.evaluationData,
            evaluationDatasets: evaluation.evaluationDatasets,
          });
        },
        { signal, deferCommit: true },
      );
    } catch (err) {
      if (!isCurrent()) return;
      handleError(err, 'Failed to load project from file browser', {
        metadata: {
          openProjectCount: Object.keys(store.get(projectsState).openedProjects).length,
        },
      });
    }
  };
}

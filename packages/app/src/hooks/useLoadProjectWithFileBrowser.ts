import { useStore } from 'jotai';
import { projectsState } from '../state/savedGraphs.js';
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
  const { openLoadedProject } = useWorkspaceHostOpenProject();

  return async () => {
    // A file picker is a user interaction, not a timed preparation. Its IO
    // still belongs to this intent and may not commit after another selection.
    supersedeProjectActivation(store);
    const revision = getProjectActivationRevision(store);
    const signal = getProjectActivationSignal(store);
    const isCurrent = () => revision === getProjectActivationRevision(store) && !signal.aborted;
    try {
      await ioProvider.loadProjectData(
        async (loaded) => {
          await openLoadedProject(loaded, isCurrent);
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

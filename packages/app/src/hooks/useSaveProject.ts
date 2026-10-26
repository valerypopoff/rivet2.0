import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';
import { useWorkspaceHostOpenProject } from './workspaceHost/useWorkspaceHostOpenProject.js';
import type { OpenCreatedProject } from '../io/IOProvider.js';

export function useSaveProject() {
  const workspaceTransitions = useWorkspaceTransitions();
  const { openProjectPath } = useWorkspaceHostOpenProject();
  const openCreatedProject: OpenCreatedProject = (copy, isCurrent) => openProjectPath(copy.path, { expectedProjectId: copy.projectId, isCurrent });

  function saveProject() {
    return workspaceTransitions.saveProject({ openCreatedProject });
  }

  function saveProjectAs() {
    return workspaceTransitions.saveProject({ forceSaveAs: true, openCreatedProject });
  }

  return {
    saveProject,
    saveProjectAs,
  };
}

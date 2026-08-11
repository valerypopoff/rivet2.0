import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';

export function useSaveProject() {
  const workspaceTransitions = useWorkspaceTransitions();

  function saveProject() {
    return workspaceTransitions.saveProject();
  }

  function saveProjectAs() {
    return workspaceTransitions.saveProject({ forceSaveAs: true });
  }

  return {
    saveProject,
    saveProjectAs,
  };
}

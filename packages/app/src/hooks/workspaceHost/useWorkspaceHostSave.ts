import { useWorkspaceTransitions } from '../useWorkspaceTransitions.js';
import { useStableCallback } from '../useStableCallback.js';
import { useWorkspaceHostOpenProject } from './useWorkspaceHostOpenProject.js';

export function useWorkspaceHostSave() {
  const workspaceTransitions = useWorkspaceTransitions();
  const { openProjectPath } = useWorkspaceHostOpenProject();

  return useStableCallback(() => workspaceTransitions.saveProject({
    openCreatedProject: (copy, isCurrent) => openProjectPath(copy.path, { expectedProjectId: copy.projectId, isCurrent }),
  }));
}

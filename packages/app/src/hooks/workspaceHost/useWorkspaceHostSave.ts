import { useWorkspaceTransitions } from '../useWorkspaceTransitions.js';
import { useStableCallback } from '../useStableCallback.js';

export function useWorkspaceHostSave() {
  const workspaceTransitions = useWorkspaceTransitions();

  return useStableCallback(() => workspaceTransitions.saveProject());
}

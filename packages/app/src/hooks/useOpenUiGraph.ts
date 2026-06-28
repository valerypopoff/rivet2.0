import type { UiGraphId } from '@valerypopoff/rivet2-core';
import { useStableCallback } from './useStableCallback.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';

export function useOpenUiGraph() {
  const workspaceTransitions = useWorkspaceTransitions();

  return useStableCallback((uiGraphId: UiGraphId) => {
    workspaceTransitions.switchToUiGraph(uiGraphId);
  });
}

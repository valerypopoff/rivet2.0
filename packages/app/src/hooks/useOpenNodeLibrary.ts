import type { NodeId, NodePrefabId } from '@valerypopoff/rivet2-core';
import { useStableCallback } from './useStableCallback.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';

export function useOpenNodeLibrary() {
  const workspaceTransitions = useWorkspaceTransitions();

  return useStableCallback(
    (options: { selectedNodeIds?: readonly NodeId[]; editingPrefabId?: NodePrefabId | undefined } = {}) => {
      workspaceTransitions.switchToNodeLibrary(options);
    },
  );
}

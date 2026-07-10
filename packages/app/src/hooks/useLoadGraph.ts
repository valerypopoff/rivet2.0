import { type NodeGraph } from '@valerypopoff/rivet2-core';
import type { GraphViewContext } from '../domain/graphEditing/navigationActions.js';
import { useStableCallback } from './useStableCallback.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';

export function useLoadGraph() {
  const workspaceTransitions = useWorkspaceTransitions();

  return useStableCallback(
    (
      savedGraph: NodeGraph,
      { graphView, pushHistory = true }: { graphView?: GraphViewContext; pushHistory?: boolean } = {},
    ) => {
      workspaceTransitions.switchGraph(savedGraph, { graphView, pushHistory });
    },
  );
}

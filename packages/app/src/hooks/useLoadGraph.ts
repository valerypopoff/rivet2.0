import { type NodeGraph } from '@valerypopoff/rivet2-core';
import type { GraphViewContext } from '../domain/graphEditing/navigationActions.js';
import { useStableCallback } from './useStableCallback.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';
import { useSetAtom } from 'jotai';
import { editingNodePrefabIdState, nodeLibraryOpenState } from '../state/nodeLibrary.js';

export function useLoadGraph() {
  const workspaceTransitions = useWorkspaceTransitions();
  const setNodeLibraryOpen = useSetAtom(nodeLibraryOpenState);
  const setEditingNodePrefabId = useSetAtom(editingNodePrefabIdState);

  return useStableCallback((
    savedGraph: NodeGraph,
    { graphView, pushHistory = true }: { graphView?: GraphViewContext; pushHistory?: boolean } = {},
  ) => {
    setNodeLibraryOpen(false);
    setEditingNodePrefabId(undefined);
    workspaceTransitions.switchGraph(savedGraph, { graphView, pushHistory });
  });
}

import { type NodeGraph } from '@valerypopoff/rivet2-core';
import type { GraphViewContext } from '../domain/graphEditing/navigationActions.js';
import { useStableCallback } from './useStableCallback.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';
import { useSetAtom } from 'jotai';
import { editingNodePrefabIdState, nodeLibraryOpenState } from '../state/nodeLibrary.js';
import { selectedUiGraphIdState } from '../state/uiGraphs.js';

export function useLoadGraph() {
  const workspaceTransitions = useWorkspaceTransitions();
  const setNodeLibraryOpen = useSetAtom(nodeLibraryOpenState);
  const setEditingNodePrefabId = useSetAtom(editingNodePrefabIdState);
  const setSelectedUiGraphId = useSetAtom(selectedUiGraphIdState);

  return useStableCallback(
    (
      savedGraph: NodeGraph,
      { graphView, pushHistory = true }: { graphView?: GraphViewContext; pushHistory?: boolean } = {},
    ) => {
      setNodeLibraryOpen(false);
      setEditingNodePrefabId(undefined);
      setSelectedUiGraphId(undefined);
      workspaceTransitions.switchGraph(savedGraph, { graphView, pushHistory });
    },
  );
}

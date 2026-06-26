import { useAtomValue, useSetAtom } from 'jotai';
import { useCommand } from './Command';
import { nodesState } from '../state/graph';
import { type NodeId } from '@valerypopoff/rivet2-core';
import { createAddedNode } from '../domain/graphEditing/nodeActions.js';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry';
import { resolveEditorPreferences, settingsState } from '../state/settings.js';
import { editingNodeState } from '../state/graphBuilder.js';

export function useAddNodeCommand() {
  const setNodes = useSetAtom(nodesState);
  const setEditingNodeId = useSetAtom(editingNodeState);
  const projectNodeRegistry = useProjectNodeRegistry();
  const settings = useAtomValue(settingsState);
  const editorPreferences = resolveEditorPreferences(settings);

  return useCommand<{ nodeType: string; position: { x: number; y: number } }, { id: NodeId }>({
    type: 'addNode',
    apply(params, appliedData, currentState) {
      const newNode = createAddedNode({
        nodeType: params.nodeType,
        position: params.position,
        registry: projectNodeRegistry,
        project: currentState.project,
        referencedProjects: currentState.referencedProjects,
        appliedId: appliedData?.id,
        applyDefaultColor: editorPreferences.applyDefaultNodeColors,
      });

      setNodes([...currentState.nodes, newNode]);
      if (editorPreferences.openNodeSettingsOnCreate) {
        setEditingNodeId(newNode.id);
      }

      return { id: newNode.id };
    },
    undo(_data, { id }) {
      setNodes((allNodes) => allNodes.filter((node) => node.id !== id));
      setEditingNodeId((currentNodeId: NodeId | null) => (currentNodeId === id ? null : currentNodeId));
    },
  });
}

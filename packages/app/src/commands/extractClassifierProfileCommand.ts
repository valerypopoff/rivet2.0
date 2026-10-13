import { type ClassifierProfileNode, type ClassifierEvaluateNode, type NodeId } from '@valerypopoff/rivet2-core';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCommand } from './Command.js';
import { connectionsState, nodesState } from '../state/graph.js';
import { extractClassifierConfigurationToProfile } from '../domain/graphEditing/extractClassifierProfile.js';
import { createAddedNode } from '../domain/graphEditing/nodeActions.js';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry.js';
import { resolveEditorPreferences, settingsState } from '../state/settings.js';
import {
  getRecoverableNodeConnectionsForNode,
  recoverableNodeConnectionsStatePerGraph,
  setRecoverableNodeConnectionsForGraphNode,
} from '../state/recoverableNodeConnections.js';

type Extraction = ReturnType<typeof extractClassifierConfigurationToProfile>;
type Applied = {
  extraction: Extraction;
  previousNode: ClassifierEvaluateNode;
  previousConnections: Extraction['connections'];
  previousRecoverable: Extraction['connections'];
};

export function useExtractClassifierProfileCommand() {
  const setNodes = useSetAtom(nodesState);
  const setConnections = useSetAtom(connectionsState);
  const setRecovery = useSetAtom(recoverableNodeConnectionsStatePerGraph);
  const registry = useProjectNodeRegistry();
  const preferences = resolveEditorPreferences(useAtomValue(settingsState));
  return useCommand<{ nodeId: NodeId }, Applied>({
    type: 'extractClassifierProfile',
    apply({ nodeId }, applied, state) {
      if (!applied) {
        const node = state.nodes.find((candidate) => candidate.id === nodeId);
        if (!node || node.type !== 'classifierEvaluate') throw new Error('Classifier Evaluate was not found.');
        const evaluateNode = node as ClassifierEvaluateNode;
        const profileNode = createAddedNode({
          nodeType: 'classifierProfile',
          position: { x: node.visualData.x, y: node.visualData.y },
          registry,
          project: state.project,
          referencedProjects: state.referencedProjects,
          applyDefaultColor: preferences.applyDefaultNodeColors,
        }) as ClassifierProfileNode;
        profileNode.visualData.x -= (profileNode.visualData.width ?? 260) + 80;
        const previousRecoverable = getRecoverableNodeConnectionsForNode(state.recoverableNodeConnections, nodeId);
        applied = {
          extraction: extractClassifierConfigurationToProfile({
            evaluateNode,
            profileNode,
            connections: state.connections,
            recoverableConnections: previousRecoverable,
          }),
          previousNode: structuredClone(evaluateNode),
          previousConnections: structuredClone(state.connections),
          previousRecoverable: structuredClone(previousRecoverable),
        };
      }
      const { extraction } = applied;
      setNodes([
        ...state.nodes.map((node) => (node.id === nodeId ? structuredClone(extraction.evaluateNode) : node)),
        structuredClone(extraction.profileNode),
      ]);
      setConnections(structuredClone(extraction.connections));
      setRecovery((entries) =>
        setRecoverableNodeConnectionsForGraphNode(
          setRecoverableNodeConnectionsForGraphNode(
            entries,
            state.graphId,
            nodeId,
            extraction.evaluateRecoverableConnections,
          ),
          state.graphId,
          extraction.profileNode.id,
          extraction.profileRecoverableConnections,
        ),
      );
      return applied;
    },
    undo({ nodeId }, applied, state) {
      setNodes(
        state.nodes
          .filter((node) => node.id !== applied.extraction.profileNode.id)
          .map((node) => (node.id === nodeId ? structuredClone(applied.previousNode) : node)),
      );
      setConnections(structuredClone(applied.previousConnections));
      setRecovery((entries) =>
        setRecoverableNodeConnectionsForGraphNode(
          setRecoverableNodeConnectionsForGraphNode(entries, state.graphId, nodeId, applied.previousRecoverable),
          state.graphId,
          applied.extraction.profileNode.id,
          [],
        ),
      );
    },
  });
}

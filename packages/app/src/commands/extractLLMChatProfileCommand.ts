import {
  type ChartNode,
  type LLMChatV2Node,
  type LLMProfileNode,
  type NodeConnection,
  type NodeId,
} from '@valerypopoff/rivet2-core';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCommand, type GraphCommandState } from './Command.js';
import { nodesState, connectionsState } from '../state/graph.js';
import { createAddedNode } from '../domain/graphEditing/nodeActions.js';
import {
  extractLLMChatConfigurationToProfile,
  LLM_PROFILE_EXTRACTION_HORIZONTAL_GAP,
} from '../domain/graphEditing/extractLLMChatProfile.js';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry.js';
import { resolveEditorPreferences, settingsState } from '../state/settings.js';
import {
  getRecoverableNodeConnectionsForNode,
  recoverableNodeConnectionsStatePerGraph,
  setRecoverableNodeConnectionsForGraphNode,
} from '../state/recoverableNodeConnections.js';

type ExtractLLMChatProfileParams = {
  nodeId: NodeId;
};

type ExtractLLMChatProfileAppliedData = {
  nextChatNode: LLMChatV2Node;
  nextConnections: NodeConnection[];
  nextProfileNode: LLMProfileNode;
  nextChatRecoverableConnections: NodeConnection[];
  nextProfileRecoverableConnections: NodeConnection[];
  previousChatNode: LLMChatV2Node;
  previousConnections: NodeConnection[];
  previousChatRecoverableConnections: NodeConnection[];
};

function getInlineLLMChatNode(currentState: GraphCommandState, nodeId: NodeId): LLMChatV2Node {
  const node = currentState.nodes.find((candidate) => candidate.id === nodeId);

  if (!node || node.type !== 'llmChatV2') {
    throw new Error(`LLM Chat node ${nodeId} was not found.`);
  }

  const chatNode = node as LLMChatV2Node;

  if (chatNode.data.configurationMode === 'profile') {
    throw new Error('LLM Chat already uses an LLM Profile.');
  }

  return chatNode;
}

function replaceNode(nodes: readonly ChartNode[], nodeId: NodeId, replacement: ChartNode): ChartNode[] {
  return nodes.map((node) => (node.id === nodeId ? structuredClone(replacement) : node));
}

export function useExtractLLMChatProfileCommand() {
  const setNodes = useSetAtom(nodesState);
  const setConnections = useSetAtom(connectionsState);
  const setRecoverableNodeConnections = useSetAtom(recoverableNodeConnectionsStatePerGraph);
  const projectNodeRegistry = useProjectNodeRegistry();
  const settings = useAtomValue(settingsState);
  const editorPreferences = resolveEditorPreferences(settings);

  const applyExtraction = (
    currentState: GraphCommandState,
    appliedData: ExtractLLMChatProfileAppliedData,
  ) => {
    setNodes([
      ...replaceNode(currentState.nodes, appliedData.previousChatNode.id, appliedData.nextChatNode),
      structuredClone(appliedData.nextProfileNode),
    ]);
    setConnections(structuredClone(appliedData.nextConnections));
    setRecoverableNodeConnections((entries) => {
      const withChatConnections = setRecoverableNodeConnectionsForGraphNode(
        entries,
        currentState.graphId,
        appliedData.previousChatNode.id,
        appliedData.nextChatRecoverableConnections,
      );
      return setRecoverableNodeConnectionsForGraphNode(
        withChatConnections,
        currentState.graphId,
        appliedData.nextProfileNode.id,
        appliedData.nextProfileRecoverableConnections,
      );
    });
  };

  return useCommand<ExtractLLMChatProfileParams, ExtractLLMChatProfileAppliedData>({
    type: 'extractLLMChatProfile',
    apply({ nodeId }, appliedData, currentState) {
      if (appliedData) {
        applyExtraction(currentState, appliedData);
        return appliedData;
      }

      const chatNode = getInlineLLMChatNode(currentState, nodeId);
      const profileNode = createAddedNode({
        nodeType: 'llmProfile',
        position: {
          x: chatNode.visualData.x,
          y: chatNode.visualData.y,
        },
        registry: projectNodeRegistry,
        project: currentState.project,
        referencedProjects: currentState.referencedProjects,
        applyDefaultColor: editorPreferences.applyDefaultNodeColors,
      }) as LLMProfileNode;
      profileNode.visualData.x =
        chatNode.visualData.x - ((profileNode.visualData.width ?? 260) + LLM_PROFILE_EXTRACTION_HORIZONTAL_GAP);
      const previousChatRecoverableConnections = getRecoverableNodeConnectionsForNode(
        currentState.recoverableNodeConnections,
        chatNode.id,
      );
      const extraction = extractLLMChatConfigurationToProfile({
        chatNode,
        connections: currentState.connections,
        profileNode,
        recoverableConnections: previousChatRecoverableConnections,
      });
      const nextAppliedData: ExtractLLMChatProfileAppliedData = {
        nextChatNode: extraction.nextChatNode,
        nextConnections: extraction.nextConnections,
        nextProfileNode: extraction.profileNode,
        nextChatRecoverableConnections: extraction.nextChatRecoverableConnections,
        nextProfileRecoverableConnections: extraction.nextProfileRecoverableConnections,
        previousChatNode: structuredClone(chatNode),
        previousConnections: structuredClone(currentState.connections),
        previousChatRecoverableConnections,
      };

      applyExtraction(currentState, nextAppliedData);
      return nextAppliedData;
    },
    undo(_data, appliedData, currentState) {
      setNodes(
        replaceNode(
          currentState.nodes.filter((node) => node.id !== appliedData.nextProfileNode.id),
          appliedData.previousChatNode.id,
          appliedData.previousChatNode,
        ),
      );
      setConnections(structuredClone(appliedData.previousConnections));
      setRecoverableNodeConnections((entries) => {
        const withChatConnections = setRecoverableNodeConnectionsForGraphNode(
          entries,
          currentState.graphId,
          appliedData.previousChatNode.id,
          appliedData.previousChatRecoverableConnections,
        );
        return setRecoverableNodeConnectionsForGraphNode(
          withChatConnections,
          currentState.graphId,
          appliedData.nextProfileNode.id,
          [],
        );
      });
    },
  });
}

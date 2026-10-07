import { type ChartNode, type NodeConnection, type NodeId } from '@valerypopoff/rivet2-core';
import { useSetAtom, useStore } from 'jotai';
import { connectionsState, nodesState } from '../state/graph';
import { hoveringNodeState, selectedNodesState } from '../state/graphBuilder';
import { useCommand } from './Command';
import { duplicateNodesWithConnections } from '../domain/graphEditing/nodeActions.js';
import { removeMatchingConnection } from '../domain/graphEditing/connectionActions.js';
import { selectedConnectionBendsState } from '../state/connectionBends.js';
import { getConnectionBendKeys } from '../domain/graphEditing/connectionBendSelection.js';

export function useDuplicateNodesCommand() {
  const store = useStore();
  const setNodes = useSetAtom(nodesState);
  const setConnections = useSetAtom(connectionsState);
  const setSelectedNodeIds = useSetAtom(selectedNodesState);
  const setSelectedBends = useSetAtom(selectedConnectionBendsState);
  const setHoveringNode = useSetAtom(hoveringNodeState);

  return useCommand<
    {
      nodeIds: NodeId[];
      delta: { x: number; y: number };
    },
    {
      duplicatedNodes: ChartNode[];
      duplicatedConnections: NodeConnection[];
      previousSelectedNodeIds: NodeId[];
      previousSelectedBends: string[];
    }
  >({
    type: 'duplicateNodes',
    apply({ nodeIds, delta }, appliedData, currentState) {
      if (!appliedData) {
        const { newNodes, duplicatedConnections } = duplicateNodesWithConnections({
          nodes: currentState.nodes,
          nodeIds,
          connections: currentState.connections,
          delta,
        });
        appliedData = {
          duplicatedNodes: newNodes,
          duplicatedConnections,
          previousSelectedNodeIds: store.get(selectedNodesState),
          previousSelectedBends: store.get(selectedConnectionBendsState),
        };
      }
      const { duplicatedNodes, duplicatedConnections } = appliedData;
      setHoveringNode(undefined);
      setNodes((prev) => [...prev, ...duplicatedNodes]);
      setConnections((prev) => [...prev, ...duplicatedConnections]);
      setSelectedNodeIds(duplicatedNodes.map((node) => node.id));
      setSelectedBends(getConnectionBendKeys(duplicatedConnections));
      return appliedData;
    },
    undo(_data, appliedData, currentState) {
      setHoveringNode(undefined);
      const duplicatedNodeIds = new Set(appliedData.duplicatedNodes.map((node) => node.id));
      setNodes(currentState.nodes.filter((node) => !duplicatedNodeIds.has(node.id)));

      const nextConnections = appliedData.duplicatedConnections.reduce(
        (connections, connection) => removeMatchingConnection(connections, connection),
        currentState.connections,
      );

      setConnections(nextConnections);
      setSelectedNodeIds(appliedData.previousSelectedNodeIds);
      setSelectedBends(appliedData.previousSelectedBends);
    },
  });
}

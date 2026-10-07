import { type ChartNode, type NodeConnection, type NodeId } from '@valerypopoff/rivet2-core';
import { useSetAtom } from 'jotai';
import { connectionsState, nodesState } from '../state/graph';
import { duplicateNodeWithConnections } from '../domain/graphEditing/nodeActions.js';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry';
import { useCommand } from './Command';
import { removeMatchingConnection } from '../domain/graphEditing/connectionActions.js';

export function useDuplicateNodeCommand() {
  const setNodes = useSetAtom(nodesState);
  const setConnections = useSetAtom(connectionsState);
  const projectNodeRegistry = useProjectNodeRegistry();

  return useCommand<
    {
      nodeId: NodeId;
    },
    {
      newNodeId: NodeId;
      duplicatedConnections: NodeConnection[];
      duplicatedNode: ChartNode;
    }
  >({
    type: 'duplicateNode',
    apply({ nodeId }, appliedData, currentState) {
      if (appliedData) {
        setNodes((prev) => [...prev, appliedData.duplicatedNode]);
        setConnections((prev) => [...prev, ...appliedData.duplicatedConnections]);

        return appliedData;
      }

      const node = currentState.nodes.find((candidate) => candidate.id === nodeId);

      if (!node) {
        throw new Error(`Node with id ${nodeId} not found`);
      }

      const { newNode, duplicatedIncomingConnections } = duplicateNodeWithConnections({
        node,
        connections: currentState.connections,
        registry: projectNodeRegistry,
      });

      setNodes((prev) => [...prev, newNode]);
      setConnections((prev) => [...prev, ...duplicatedIncomingConnections]);

      return {
        newNodeId: newNode.id,
        duplicatedConnections: duplicatedIncomingConnections,
        duplicatedNode: newNode,
      };
    },
    undo(_data, appliedData, currentState) {
      setNodes(currentState.nodes.filter((node) => node.id !== appliedData.newNodeId));

      const nextConnections = appliedData.duplicatedConnections.reduce(
        (connections, connection) => removeMatchingConnection(connections, connection),
        currentState.connections,
      );

      setConnections(nextConnections);
    },
  });
}

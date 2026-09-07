import { useSetAtom } from 'jotai';
import { useCommand } from './Command';
import { nodesState, connectionsState } from '../state/graph';
import { getProjectConnectionComparisonKey, type NodeId } from '@valerypopoff/rivet2-core';
import { moveConnectionBends, type ConnectionBendMove } from '../domain/graphEditing/connectionBendSelection.js';

export type NodePosition = {
  nodeId: NodeId;
  position: { x: number; y: number };
};

export function useMoveNodeCommand() {
  const setNodes = useSetAtom(nodesState);
  const setConnections = useSetAtom(connectionsState);

  return useCommand<
    {
      moves: NodePosition[];
      bendMoves?: ConnectionBendMove[];
    },
    {
      previousPositions: NodePosition[];
      previousBends: ConnectionBendMove[];
    }
  >({
    type: 'moveNode',
    apply(params, _appliedData, currentState) {
      const bendKeys = new Set(params.bendMoves?.map((move) => move.connectionKey));
      const previousBends = currentState.connections.flatMap((connection) => {
        const connectionKey = getProjectConnectionComparisonKey(connection);
        return connection.bendPoint && bendKeys.has(connectionKey)
          ? [{ connectionKey, position: { ...connection.bendPoint } }]
          : [];
      });
      const previousPositions: NodePosition[] = params.moves.map((move) => {
        const node = currentState.nodes.find((n) => n.id === move.nodeId);
        if (!node) {
          throw new Error(`Node with id ${move.nodeId} not found`);
        }
        return {
          nodeId: move.nodeId,
          position: {
            x: node.visualData.x,
            y: node.visualData.y,
          },
        };
      });

      setNodes(
        currentState.nodes.map((node) => {
          const move = params.moves.find((m) => m.nodeId === node.id);
          if (move) {
            return {
              ...node,
              visualData: {
                ...node.visualData,
                x: move.position.x,
                y: move.position.y,
              },
            };
          }
          return node;
        }),
      );

      if (params.bendMoves?.length) setConnections(moveConnectionBends(currentState.connections, params.bendMoves));
      return {
        previousPositions,
        previousBends,
      };
    },
    undo(_data, appliedData, currentState) {
      if (appliedData.previousBends.length)
        setConnections(moveConnectionBends(currentState.connections, appliedData.previousBends));
      setNodes(
        currentState.nodes.map((node) => {
          const previousPosition = appliedData.previousPositions.find((p) => p.nodeId === node.id);
          if (previousPosition) {
            return {
              ...node,
              visualData: {
                ...node.visualData,
                x: previousPosition.position.x,
                y: previousPosition.position.y,
              },
            };
          }
          return node;
        }),
      );
    },
  });
}

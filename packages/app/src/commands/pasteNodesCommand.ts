import { type ChartNode, type NodeConnection, type NodeId } from '@valerypopoff/rivet2-core';
import { useSetAtom, useStore } from 'jotai';
import { connectionsState, nodesState } from '../state/graph';
import { hoveringNodeState, selectedNodesState } from '../state/graphBuilder';
import { useCommand } from './Command';
import { createPastedNodes } from '../domain/graphEditing/nodeActions.js';
import { removeMatchingConnection } from '../domain/graphEditing/connectionActions.js';
import { selectedConnectionBendsState } from '../state/connectionBends.js';
import { getConnectionBendKeys } from '../domain/graphEditing/connectionBendSelection.js';

export function usePasteNodesCommand() {
  const store = useStore();
  const setNodes = useSetAtom(nodesState);
  const setConnections = useSetAtom(connectionsState);
  const setSelectedNodeIds = useSetAtom(selectedNodesState);
  const setSelectedBends = useSetAtom(selectedConnectionBendsState);
  const setHoveringNode = useSetAtom(hoveringNodeState);

  return useCommand<
    {
      nodes: ChartNode[];
      connections: NodeConnection[];
      position: { x: number; y: number };
    },
    {
      newNodes: ChartNode[];
      newConnections: NodeConnection[];
      previousSelectedNodeIds: NodeId[];
      previousSelectedBends: string[];
    }
  >({
    type: 'pasteNodes',
    apply(data, appliedData) {
      const result = appliedData ?? {
        ...createPastedNodes(data),
        previousSelectedNodeIds: store.get(selectedNodesState),
        previousSelectedBends: store.get(selectedConnectionBendsState),
      };
      setHoveringNode(undefined);
      setNodes((prev) => [...prev, ...result.newNodes]);
      setConnections((prev) => [...prev, ...result.newConnections]);
      setSelectedNodeIds(result.newNodes.map((node) => node.id));
      setSelectedBends(getConnectionBendKeys(result.newConnections));
      return result;
    },
    undo(_data, appliedData, currentState) {
      setHoveringNode(undefined);
      const newNodeIds = new Set(appliedData.newNodes.map((node) => node.id));

      setNodes(currentState.nodes.filter((node) => !newNodeIds.has(node.id)));

      const nextConnections = appliedData.newConnections.reduce(
        (connections, connection) => removeMatchingConnection(connections, connection),
        currentState.connections,
      );

      setConnections(nextConnections);
      setSelectedNodeIds(appliedData.previousSelectedNodeIds);
      setSelectedBends(appliedData.previousSelectedBends);
    },
  });
}

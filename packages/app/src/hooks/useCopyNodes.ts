import { type NodeId } from '@valerypopoff/rivet2-core';
import { useStore } from 'jotai';
import { selectedNodesState } from '../state/graphBuilder';
import { connectionsState, nodesState } from '../state/graph';
import { clipboardState } from '../state/clipboard';
import { isNotNull } from '../utils/genericUtilFunctions';

export function useCopyNodes() {
  const store = useStore();

  return (additionalNodeId?: NodeId) => {
    const selectedNodeIds = store.get(selectedNodesState);
    const nodesById = new Map(store.get(nodesState).map((node) => [node.id, node]));
    const connections = store.get(connectionsState);
    const nodes = [...new Set(additionalNodeId ? [...selectedNodeIds, additionalNodeId] : selectedNodeIds)]
      .map((id) => nodesById.get(id))
      .filter(isNotNull);
    if (nodes.length === 0) return;
    const nodeIds = new Set(nodes.map((node) => node.id));

    const copiedConnections = connections.filter((c) => nodeIds.has(c.inputNodeId) && nodeIds.has(c.outputNodeId));

    store.set(clipboardState, {
      type: 'nodes',
      nodes,
      connections: copiedConnections,
    });
  };
}

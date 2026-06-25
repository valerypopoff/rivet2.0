import { useSetAtom } from 'jotai';
import { useCommand } from './Command';
import { nodesState } from '../state/graph';
import { applyResizeChangesToNodes, type NodeResizeChange } from '../utils/nodeResize.js';

export function useResizeNodesCommand() {
  const setNodes = useSetAtom(nodesState);

  return useCommand<
    {
      changes: NodeResizeChange[];
    },
    null
  >({
    type: 'resizeNodes',
    apply(params, _appliedData, currentState) {
      setNodes(applyResizeChangesToNodes(currentState.nodes, params.changes, { requireAllChanges: true }));

      return null;
    },
    undo(params, _appliedData, currentState) {
      const previousNodesByNodeId = new Map(
        params.changes.map((change) => [change.nodeId, structuredClone(change.previousNode)]),
      );

      setNodes(currentState.nodes.map((node) => previousNodesByNodeId.get(node.id) ?? node));
    },
  });
}

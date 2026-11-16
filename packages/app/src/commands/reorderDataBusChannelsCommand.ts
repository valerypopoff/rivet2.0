import { canRenderDataBusNode, resolveNodePrefabInstance, type NodeGraph } from '@valerypopoff/rivet2-core';
import { useSetAtom } from 'jotai';
import { graphState } from '../state/graph.js';
import { useCommand, type Command } from './Command.js';
import {
  applyDataBusChannelOrders,
  getConnectedDataBusChannelOrder,
  moveDataBusChannel,
  type DataBusChannelOrderChange,
  type ReorderDataBusChannelsParams,
} from '../domain/graphEditing/dataBusChannelOrder.js';

export function createReorderDataBusChannelsCommand(
  setGraph: (update: (graph: NodeGraph) => NodeGraph) => void,
): Command<ReorderDataBusChannelsParams, DataBusChannelOrderChange[]> {
  return {
    type: 'reorderDataBusChannels',
    apply(params, appliedData, currentState) {
      const node = currentState.nodes.find((candidate) => candidate.id === params.nodeId);
      if (!node || !canRenderDataBusNode(resolveNodePrefabInstance(currentState.project, node))) return [];
      const order = getConnectedDataBusChannelOrder(node, currentState.connections);
      const next = moveDataBusChannel(order, params);
      const changes =
        appliedData ??
        (next
          ? [
              {
                nodeId: node.id,
                before: node.visualData.dataBusChannelOrder,
                after: next,
              },
            ]
          : []);
      if (changes.length) setGraph((graph) => ({ ...graph, nodes: applyDataBusChannelOrders(graph.nodes, changes) }));
      return changes;
    },
    undo(_params, changes) {
      if (changes.length)
        setGraph((graph) => ({ ...graph, nodes: applyDataBusChannelOrders(graph.nodes, changes, true) }));
    },
  };
}

export function useReorderDataBusChannelsCommand() {
  return useCommand(createReorderDataBusChannelsCommand(useSetAtom(graphState)));
}

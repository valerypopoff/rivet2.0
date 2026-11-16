import { type NodeConnection, type NodeGraph } from '@valerypopoff/rivet2-core';
import { useCommand, type Command } from './Command';
import { useSetAtom } from 'jotai';
import { graphState } from '../state/graph';
import {
  applyDataBusChannelOrders,
  captureDataBusChannelOrders,
  type DataBusChannelOrderChange,
} from '../domain/graphEditing/dataBusChannelOrder.js';
import {
  applySubgraphConnectionBoundaries,
  captureSubgraphConnectionBoundaries,
  type SubgraphConnectionBoundaryChange,
} from '../domain/graphEditing/subgraphConnectionBoundary.js';
import {
  createRewireConnectionChange,
  undoRewireConnectionChange,
  type ConnectionActionParams,
} from '../domain/graphEditing/connectionActions.js';

export function createRewireConnectionCommand(setGraph: (update: (graph: NodeGraph) => NodeGraph) => void): Command<
  ConnectionActionParams & {
    originalConnection: NodeConnection;
  },
  {
    originalConnection: NodeConnection;
    newConnection: NodeConnection;
    replacedTargetConnection: NodeConnection | undefined;
    boundaries: SubgraphConnectionBoundaryChange[];
    busOrders: DataBusChannelOrderChange[];
  }
> {
  return {
    type: 'rewireConnection',
    apply(params, appliedData, currentState) {
      const change = createRewireConnectionChange(currentState.connections, params.originalConnection, {
        outputNodeId: params.outputNodeId,
        outputId: params.outputId,
        inputNodeId: params.inputNodeId,
        inputId: params.inputId,
      });

      const busOrders =
        appliedData?.busOrders ??
        captureDataBusChannelOrders({
          nodes: currentState.nodes,
          project: currentState.project,
          previousConnections: currentState.connections,
          nextConnections: change.connections,
          newConnection: change.newConnection,
        });
      const boundaries =
        appliedData?.boundaries ??
        captureSubgraphConnectionBoundaries(currentState.nodes, change.newConnection, currentState.referencedProjects);
      setGraph((graph) => ({
        ...graph,
        nodes: applyDataBusChannelOrders(applySubgraphConnectionBoundaries(graph.nodes, boundaries), busOrders),
        connections: change.connections,
      }));

      return {
        originalConnection: change.originalConnection,
        newConnection: change.newConnection,
        replacedTargetConnection: change.replacedTargetConnection,
        boundaries,
        busOrders,
      };
    },
    undo(_data, appliedData, currentState) {
      setGraph((graph) => ({
        ...graph,
        nodes: applyDataBusChannelOrders(
          applySubgraphConnectionBoundaries(graph.nodes, appliedData.boundaries, true),
          appliedData.busOrders,
          true,
        ),
        connections: undoRewireConnectionChange({
          connections: currentState.connections,
          newConnection: appliedData.newConnection,
          originalConnection: appliedData.originalConnection,
          replacedTargetConnection: appliedData.replacedTargetConnection,
        }),
      }));
    },
  };
}

export function useRewireConnectionCommand() {
  return useCommand(createRewireConnectionCommand(useSetAtom(graphState)));
}

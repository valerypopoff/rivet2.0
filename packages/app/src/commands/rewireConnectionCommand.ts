import { type NodeConnection, type NodeGraph } from '@valerypopoff/rivet2-core';
import { useCommand, type Command } from './Command';
import { useSetAtom } from 'jotai';
import { graphState } from '../state/graph';
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

      const boundaries =
        appliedData?.boundaries ??
        captureSubgraphConnectionBoundaries(currentState.nodes, change.newConnection, currentState.referencedProjects);
      setGraph((graph) => ({
        ...graph,
        nodes: applySubgraphConnectionBoundaries(graph.nodes, boundaries),
        connections: change.connections,
      }));

      return {
        originalConnection: change.originalConnection,
        newConnection: change.newConnection,
        replacedTargetConnection: change.replacedTargetConnection,
        boundaries,
      };
    },
    undo(_data, appliedData, currentState) {
      setGraph((graph) => ({
        ...graph,
        nodes: applySubgraphConnectionBoundaries(graph.nodes, appliedData.boundaries, true),
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

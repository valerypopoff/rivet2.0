import { type NodeConnection, type NodeGraph } from '@valerypopoff/rivet2-core';
import { useCommand, type Command } from './Command';
import { useSetAtom } from 'jotai';
import { graphState } from '../state/graph';
import {
  createConnectionChange,
  undoConnectionChange,
  type ConnectionActionParams,
} from '../domain/graphEditing/connectionActions.js';
import {
  applySubgraphConnectionBoundaries,
  captureSubgraphConnectionBoundaries,
  type SubgraphConnectionBoundaryChange,
} from '../domain/graphEditing/subgraphConnectionBoundary.js';

export function createMakeConnectionCommand(setGraph: (update: (graph: NodeGraph) => NodeGraph) => void): Command<
  ConnectionActionParams,
  {
    newConnection: NodeConnection;
    previousConnectionToInput: NodeConnection | undefined;
    boundaries: SubgraphConnectionBoundaryChange[];
  }
> {
  return {
    type: 'makeConnection',
    apply(params, appliedData, currentState) {
      const change = createConnectionChange(currentState.connections, params);
      const boundaries =
        appliedData?.boundaries ??
        captureSubgraphConnectionBoundaries(currentState.nodes, change.newConnection, currentState.referencedProjects);
      setGraph((graph) => ({
        ...graph,
        nodes: applySubgraphConnectionBoundaries(graph.nodes, boundaries),
        connections: change.connections,
      }));

      return {
        newConnection: change.newConnection,
        previousConnectionToInput: change.previousConnectionToInput,
        boundaries,
      };
    },
    undo(_data, appliedData, currentState) {
      setGraph((graph) => ({
        ...graph,
        nodes: applySubgraphConnectionBoundaries(graph.nodes, appliedData.boundaries, true),
        connections: undoConnectionChange({
          connections: currentState.connections,
          newConnection: appliedData.newConnection,
          previousConnectionToInput: appliedData.previousConnectionToInput,
        }),
      }));
    },
  };
}

export function useMakeConnectionCommand() {
  return useCommand(createMakeConnectionCommand(useSetAtom(graphState)));
}

import type { NodeConnection, NodeId } from '@valerypopoff/rivet2-core';
import { useSetAtom } from 'jotai';
import { connectionsState } from '../state/graph.js';
import { useCommand } from './Command.js';
import { reorderVariadicNodeConnections } from '../domain/graphEditing/variadicPortReorder.js';

type ReorderVariadicPortsParams = {
  inputPortMapping?: Record<string, string>;
  nodeId: NodeId;
  outputPortMapping?: Record<string, string>;
};

type ReorderVariadicPortsAppliedData = {
  nextConnections: NodeConnection[];
  previousConnections: NodeConnection[];
};

export function useReorderVariadicPortsCommand() {
  const setConnections = useSetAtom(connectionsState);

  return useCommand<ReorderVariadicPortsParams, ReorderVariadicPortsAppliedData>({
    type: 'reorderVariadicPorts',
    apply(params, appliedData, currentState) {
      if (appliedData) {
        setConnections(structuredClone(appliedData.nextConnections));
        return appliedData;
      }

      const nextConnections = reorderVariadicNodeConnections({
        connections: currentState.connections,
        inputPortMapping: params.inputPortMapping,
        nodeId: params.nodeId,
        outputPortMapping: params.outputPortMapping,
      });

      setConnections(structuredClone(nextConnections));

      return {
        nextConnections: structuredClone(nextConnections),
        previousConnections: structuredClone(currentState.connections),
      };
    },
    undo(_params, appliedData) {
      setConnections(structuredClone(appliedData.previousConnections));
    },
  });
}

import { useSetAtom } from 'jotai';
import { type GraphCommandState, commandHistoryStackStatePerGraph, type CommandData, useCommand } from './Command';
import { type NodeConnection, type ChartNode, type NodeId } from '@valerypopoff/rivet2-core';
import { nodesState, connectionsState } from '../state/graph';
import { produce } from 'immer';
import {
  getRecoverableNodeConnectionsForNode,
  recoverableNodeConnectionsStatePerGraph,
  setRecoverableNodeConnectionsForGraphNode,
} from '../state/recoverableNodeConnections';

const MERGE_WINDOW_MS = 5000;

type EditNodeWithConnectionsParams = {
  nodeId: NodeId;
  newNode: ChartNode;
  nextConnections: NodeConnection[];
  nextRecoverableConnections: NodeConnection[];
  previousNodeOverride?: ChartNode;
};

type EditNodeWithConnectionsAppliedData = {
  previousNode: ChartNode;
  previousConnections: NodeConnection[];
  previousRecoverableConnections: NodeConnection[];
  nextRecoverableConnections: NodeConnection[];
};

export function shouldMergeEditNodeWithConnectionsCommand(
  lastCommand: CommandData<any, any> | undefined,
  nodeId: NodeId,
  now = Date.now(),
): boolean {
  return !!(
    lastCommand &&
    now - lastCommand.timestamp <= MERGE_WINDOW_MS &&
    lastCommand.command.type === 'editNodeWithConnections' &&
    lastCommand.data.nodeId === nodeId
  );
}

function replaceNodeInGraph(nodes: ChartNode[], nodeId: NodeId, nextNode: ChartNode): ChartNode[] {
  return produce(nodes, (draft) => {
    const index = draft.findIndex((node) => node.id === nodeId);

    if (index < 0) {
      throw new Error(`Node with id ${nodeId} not found`);
    }

    draft[index] = structuredClone(nextNode);
  });
}

function removeLastCommandHistoryEntryForGraph(
  stacks: Record<string, CommandData<any, any>[]>,
  graphId: string | undefined,
): Record<string, CommandData<any, any>[]> {
  if (!graphId) {
    return stacks;
  }

  const stack = stacks[graphId] ?? [];

  return {
    ...stacks,
    [graphId]: stack.slice(0, -1),
  };
}

export function useEditNodeWithConnectionsCommand() {
  const setNodes = useSetAtom(nodesState);
  const setConnections = useSetAtom(connectionsState);
  const setCommandHistories = useSetAtom(commandHistoryStackStatePerGraph);
  const setRecoverableNodeConnections = useSetAtom(recoverableNodeConnectionsStatePerGraph);

  const applyNodeAndConnections = (
    nodeId: NodeId,
    newNode: ChartNode,
    nextConnections: readonly NodeConnection[],
    nextRecoverableConnections: readonly NodeConnection[],
    currentState: GraphCommandState,
  ) => {
    setNodes(replaceNodeInGraph(currentState.nodes, nodeId, newNode));
    setConnections(structuredClone([...nextConnections]));
    setRecoverableNodeConnections((entries) =>
      setRecoverableNodeConnectionsForGraphNode(entries, currentState.graphId, nodeId, nextRecoverableConnections),
    );
  };

  return useCommand<EditNodeWithConnectionsParams, EditNodeWithConnectionsAppliedData>({
    type: 'editNodeWithConnections',
    apply(params, appliedData, currentState) {
      const nodeToEdit = currentState.nodes.find((node) => node.id === params.nodeId);

      if (!nodeToEdit) {
        throw new Error(`Node with id ${params.nodeId} not found`);
      }

      if (appliedData) {
        applyNodeAndConnections(
          params.nodeId,
          params.newNode,
          params.nextConnections,
          appliedData.nextRecoverableConnections,
          currentState,
        );

        return appliedData;
      }

      const lastCommand = currentState.commandHistoryStack.at(-1);
      const shouldMerge = shouldMergeEditNodeWithConnectionsCommand(lastCommand, params.nodeId);
      const currentRecoverableConnections = getRecoverableNodeConnectionsForNode(
        currentState.recoverableNodeConnections,
        params.nodeId,
      );

      if (shouldMerge) {
        setCommandHistories((stacks) => removeLastCommandHistoryEntryForGraph(stacks, currentState.graphId));

        applyNodeAndConnections(
          params.nodeId,
          params.newNode,
          params.nextConnections,
          params.nextRecoverableConnections,
          currentState,
        );

        const commandToMergeWith = lastCommand!;

        return {
          previousNode: structuredClone(commandToMergeWith.appliedData.previousNode),
          previousConnections: structuredClone(commandToMergeWith.appliedData.previousConnections),
          previousRecoverableConnections: structuredClone(
            commandToMergeWith.appliedData.previousRecoverableConnections,
          ),
          nextRecoverableConnections: structuredClone(params.nextRecoverableConnections),
        };
      }

      applyNodeAndConnections(
        params.nodeId,
        params.newNode,
        params.nextConnections,
        params.nextRecoverableConnections,
        currentState,
      );

      return {
        previousNode: structuredClone(params.previousNodeOverride ?? nodeToEdit),
        previousConnections: structuredClone(currentState.connections),
        previousRecoverableConnections: structuredClone(currentRecoverableConnections),
        nextRecoverableConnections: structuredClone(params.nextRecoverableConnections),
      };
    },
    undo({ nodeId }, appliedData, currentState) {
      setNodes(replaceNodeInGraph(currentState.nodes, nodeId, appliedData.previousNode));
      setConnections(structuredClone(appliedData.previousConnections));
      setRecoverableNodeConnections((entries) =>
        setRecoverableNodeConnectionsForGraphNode(
          entries,
          currentState.graphId,
          nodeId,
          appliedData.previousRecoverableConnections,
        ),
      );
    },
  });
}

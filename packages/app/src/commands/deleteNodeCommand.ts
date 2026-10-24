import { useSetAtom, useStore } from 'jotai';
import { connectionsState, nodesState, removeGraphNodeStateFamilies } from '../state/graph';
import { readGraphCommandState, useCommand } from './Command';
import { editingNodeState, selectedNodesState, removeGraphBuilderNodeStateFamilies } from '../state/graphBuilder';
import { type NodeConnection, type ChartNode, type NodeId } from '@valerypopoff/rivet2-core';
import { frozenNodeOutputsState, removeExecutionNodeStateFamilies } from '../state/dataFlow';
import { deleteNodesFromGraph } from '../domain/graphEditing/nodeActions.js';
import {
  recoverableNodeConnectionsStatePerGraph,
  removeRecoverableNodeConnectionsForGraphNodes,
} from '../state/recoverableNodeConnections';
import { findConnectedGraphInputUsages } from '../domain/graphEditing/graphInputUsage';
import { useStableCallback } from '../hooks/useStableCallback';
import { deleteGraphInputConfirmState, type GraphInputDeletionTarget } from '../state/ui';
import { projectBindingRegistryState } from '../state/projectBindings.js';
import { removeFrozenNodeOutputsForNodes } from '../utils/frozenNodeOutputs';

type DeleteNodesCommandArgs = {
  nodeIds: NodeId[];
  skipGraphInputUsageConfirm?: boolean;
  /** Confirmation is valid only for the workspace/graph in which it was requested. */
  expectedTarget?: GraphInputDeletionTarget;
};

export const useDeleteNodesCommand = () => {
  const store = useStore();

  const setNodes = useSetAtom(nodesState);
  const setConnections = useSetAtom(connectionsState);
  const setSelectedNodeIds = useSetAtom(selectedNodesState);
  const setEditingNodeId = useSetAtom(editingNodeState);
  const setRecoverableNodeConnections = useSetAtom(recoverableNodeConnectionsStatePerGraph);
  const setDeleteGraphInputConfirm = useSetAtom(deleteGraphInputConfirmState);
  const setFrozenNodeOutputs = useSetAtom(frozenNodeOutputsState);

  const deleteNodesCommand = useCommand<
    DeleteNodesCommandArgs,
    { removedNodes: ChartNode[]; removedConnections: NodeConnection[] }
  >({
    type: 'deleteNode',
    apply(args, _appliedData, currentState) {
      const nodeIds = [...new Set(args.nodeIds)];
      const { newNodes, newConnections, removedNodes, removedConnections } = deleteNodesFromGraph({
        nodeIds,
        nodes: currentState.nodes,
        connections: currentState.connections,
      });

      if (currentState.editingNodeId && nodeIds.includes(currentState.editingNodeId)) {
        setEditingNodeId(null);
      }

      setNodes?.(newNodes);
      setConnections?.(newConnections);
      setRecoverableNodeConnections((entries) =>
        removeRecoverableNodeConnectionsForGraphNodes(entries, currentState.graphId, nodeIds),
      );
      setFrozenNodeOutputs((entries) => removeFrozenNodeOutputsForNodes(entries, currentState.graphId, nodeIds));
      setSelectedNodeIds((current) => current.filter((id) => !nodeIds.includes(id)));
      for (const nodeId of nodeIds) {
        removeGraphNodeStateFamilies(nodeId);
        removeExecutionNodeStateFamilies(nodeId);
        removeGraphBuilderNodeStateFamilies(nodeId);
      }

      return {
        removedNodes,
        removedConnections,
      };
    },
    undo(_data, { removedNodes, removedConnections }, currentState) {
      const newNodes = [...currentState.nodes, ...removedNodes];
      const newConnections = [...currentState.connections, ...removedConnections];

      setNodes(newNodes);
      setConnections(newConnections);
    },
  });

  return useStableCallback((args: DeleteNodesCommandArgs) => {
    const selectedNodeIds = store.get(selectedNodesState);
    const { nodes, connections, graphId, project } = readGraphCommandState(store);
    const bindings = store.get(projectBindingRegistryState);
    const target: GraphInputDeletionTarget = {
      projectId: project.metadata.id,
      graphId,
      workspaceToken: bindings.getWorkspaceToken(),
      bindingToken: bindings.get(project.metadata.id)?.token,
    };
    const expected = args.expectedTarget;
    if (
      expected &&
      (expected.projectId !== target.projectId ||
        expected.graphId !== target.graphId ||
        expected.workspaceToken !== target.workspaceToken ||
        expected.bindingToken !== target.bindingToken)
    )
      return;
    const nodeIds = args.skipGraphInputUsageConfirm
      ? [...new Set(args.nodeIds)]
      : selectedNodeIds.length > 0
        ? [...new Set([...selectedNodeIds, ...args.nodeIds])]
        : [...args.nodeIds];

    if (args.skipGraphInputUsageConfirm) {
      deleteNodesCommand({ nodeIds });
      return;
    }

    const graphInputUsages = findConnectedGraphInputUsages({
      currentGraph: { nodes, connections },
      currentGraphId: graphId,
      nodeIdsToDelete: nodeIds,
      project,
    });

    if (graphInputUsages.length > 0) {
      setDeleteGraphInputConfirm({
        nodeIds,
        usages: graphInputUsages,
        target,
      });
      return;
    }

    deleteNodesCommand({ nodeIds });
  });
};

import {
  type NodeGraph,
  type NodeConnection,
  type NodeRegistration,
  type Project,
  type ProjectId,
  isNodePrefabInstanceNode,
} from '@valerypopoff/rivet2-core';
import { reconcileNodeEditConnections } from '../graphEditing/editNodeConnectionRecovery.js';
import {
  type RecoverableNodeConnectionsByNode,
  getRecoverableNodeConnectionsForNode,
  setRecoverableNodeConnectionsForNode,
} from '../../state/recoverableNodeConnections.js';

export type ReconcileNodePrefabInstanceConnectionsResult = {
  graph: NodeGraph;
  recoverableConnections: RecoverableNodeConnectionsByNode;
};

export function reconcileNodePrefabInstanceConnectionsInGraph({
  graph,
  project,
  projectNodeRegistry,
  recoverableConnections,
  referencedProjects,
}: {
  graph: NodeGraph;
  project: Project;
  projectNodeRegistry: NodeRegistration<any, any>;
  recoverableConnections: RecoverableNodeConnectionsByNode;
  referencedProjects: Record<ProjectId, Project>;
}): ReconcileNodePrefabInstanceConnectionsResult {
  const instanceIds = graph.nodes.filter(isNodePrefabInstanceNode).map((node) => node.id);

  if (instanceIds.length === 0) {
    return {
      graph,
      recoverableConnections,
    };
  }

  let nextConnections: NodeConnection[] = graph.connections;
  let nextRecoverableConnections = recoverableConnections;

  for (const nodeId of instanceIds) {
    const result = reconcileNodeEditConnections({
      nodeId,
      newNode: {},
      nodes: graph.nodes,
      liveConnections: nextConnections,
      recoverableConnections: getRecoverableNodeConnectionsForNode(nextRecoverableConnections, nodeId),
      project,
      referencedProjects,
      projectNodeRegistry,
    });

    nextConnections = result.nextConnections;
    nextRecoverableConnections = setRecoverableNodeConnectionsForNode(
      nextRecoverableConnections,
      nodeId,
      result.nextRecoverableConnections,
    );
  }

  return {
    graph: {
      ...graph,
      connections: nextConnections,
    },
    recoverableConnections: nextRecoverableConnections,
  };
}

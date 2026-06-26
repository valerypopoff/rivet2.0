import { atom } from 'jotai';
import { type GraphId, type NodeConnection, type NodeId } from '@valerypopoff/rivet2-core';

export type RecoverableNodeConnectionsByNode = Record<NodeId, NodeConnection[]>;
export type RecoverableNodeConnectionsByGraph = Record<GraphId, RecoverableNodeConnectionsByNode>;

export const recoverableNodeConnectionsStatePerGraph = atom<RecoverableNodeConnectionsByGraph>({});

function cloneConnections(connections: readonly NodeConnection[]): NodeConnection[] {
  return structuredClone([...connections]);
}

export function clearRecoverableNodeConnectionsForGraph(
  entries: RecoverableNodeConnectionsByGraph,
  graphId: GraphId | undefined,
): RecoverableNodeConnectionsByGraph {
  if (!graphId || !(graphId in entries)) {
    return entries;
  }

  const nextEntries = { ...entries };
  delete nextEntries[graphId];
  return nextEntries;
}

export function getRecoverableNodeConnectionsForNode(
  entriesByNode: RecoverableNodeConnectionsByNode,
  nodeId: NodeId,
): NodeConnection[] {
  return cloneConnections(entriesByNode[nodeId] ?? []);
}

export function setRecoverableNodeConnectionsForNode(
  entriesByNode: RecoverableNodeConnectionsByNode,
  nodeId: NodeId,
  connections: readonly NodeConnection[],
): RecoverableNodeConnectionsByNode {
  const hasExistingEntry = nodeId in entriesByNode;

  if (connections.length === 0) {
    if (!hasExistingEntry) {
      return entriesByNode;
    }

    const nextEntries = { ...entriesByNode };
    delete nextEntries[nodeId];
    return nextEntries;
  }

  return {
    ...entriesByNode,
    [nodeId]: cloneConnections(connections),
  };
}

export function setRecoverableNodeConnectionsForGraphNode(
  entries: RecoverableNodeConnectionsByGraph,
  graphId: GraphId | undefined,
  nodeId: NodeId,
  connections: readonly NodeConnection[],
): RecoverableNodeConnectionsByGraph {
  if (!graphId) {
    return entries;
  }

  const currentEntriesByNode = entries[graphId] ?? ({} as RecoverableNodeConnectionsByNode);
  const nextEntriesByNode = setRecoverableNodeConnectionsForNode(currentEntriesByNode, nodeId, connections);

  if (Object.keys(nextEntriesByNode).length === 0) {
    return clearRecoverableNodeConnectionsForGraph(entries, graphId);
  }

  return {
    ...entries,
    [graphId]: nextEntriesByNode,
  };
}

export function setRecoverableNodeConnectionsForGraph(
  entries: RecoverableNodeConnectionsByGraph,
  graphId: GraphId | undefined,
  connectionsByNode: RecoverableNodeConnectionsByNode,
): RecoverableNodeConnectionsByGraph {
  if (!graphId) {
    return entries;
  }

  if (Object.keys(connectionsByNode).length === 0) {
    return clearRecoverableNodeConnectionsForGraph(entries, graphId);
  }

  return {
    ...entries,
    [graphId]: connectionsByNode,
  };
}

export function removeRecoverableNodeConnectionsForNodes(
  entriesByNode: RecoverableNodeConnectionsByNode,
  nodeIds: readonly NodeId[],
): RecoverableNodeConnectionsByNode {
  const idsToRemove = new Set(nodeIds.filter((nodeId) => nodeId in entriesByNode));

  if (idsToRemove.size === 0) {
    return entriesByNode;
  }

  const nextEntries = { ...entriesByNode };

  for (const nodeId of idsToRemove) {
    delete nextEntries[nodeId];
  }

  return nextEntries;
}

export function removeRecoverableNodeConnectionsForGraphNodes(
  entries: RecoverableNodeConnectionsByGraph,
  graphId: GraphId | undefined,
  nodeIds: readonly NodeId[],
): RecoverableNodeConnectionsByGraph {
  if (!graphId || !(graphId in entries)) {
    return entries;
  }

  const nextEntriesByNode = removeRecoverableNodeConnectionsForNodes(entries[graphId]!, nodeIds);

  if (Object.keys(nextEntriesByNode).length === 0) {
    return clearRecoverableNodeConnectionsForGraph(entries, graphId);
  }

  return {
    ...entries,
    [graphId]: nextEntriesByNode,
  };
}

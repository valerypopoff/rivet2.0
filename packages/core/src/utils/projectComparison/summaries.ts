import type { NodeId } from '../../model/NodeBase.js';
import type {
  ProjectConnectionComparison,
  ProjectComparison,
  ProjectGraphComparison,
  ProjectNodePrefabComparison,
  ProjectNodeComparison,
  ProjectUiGraphComparison,
} from '../projectComparison.js';

export function summarizeProjectComparison(
  graphs: Record<ProjectGraphComparison['id'], ProjectGraphComparison>,
  nodePrefabs: Record<string, ProjectNodePrefabComparison> = {},
  uiGraphs: Record<string, ProjectUiGraphComparison> = {},
): ProjectComparison['summary'] {
  const summary = Object.values(graphs).reduce((acc, graph) => {
    if (graph.kind === 'added') acc.addedGraphs += 1;
    if (graph.kind === 'removed') acc.removedGraphs += 1;
    if (graph.kind === 'changed') acc.changedGraphs += 1;

    acc.addedNodes += graph.summary.addedNodes;
    acc.removedNodes += graph.summary.removedNodes;
    acc.changedNodes += graph.summary.changedNodes;
    acc.addedConnections += graph.summary.addedConnections;
    acc.removedConnections += graph.summary.removedConnections;
    acc.changedConnections += graph.summary.changedConnections;
    return acc;
  }, createEmptyProjectSummary());

  for (const prefab of Object.values(nodePrefabs)) {
    if (prefab.kind === 'added') summary.addedNodePrefabs = (summary.addedNodePrefabs ?? 0) + 1;
    if (prefab.kind === 'removed') summary.removedNodePrefabs = (summary.removedNodePrefabs ?? 0) + 1;
    if (prefab.kind === 'changed') summary.changedNodePrefabs = (summary.changedNodePrefabs ?? 0) + 1;
  }

  for (const uiGraph of Object.values(uiGraphs)) {
    if (uiGraph.kind === 'added') summary.addedUiGraphs = (summary.addedUiGraphs ?? 0) + 1;
    if (uiGraph.kind === 'removed') summary.removedUiGraphs = (summary.removedUiGraphs ?? 0) + 1;
    if (uiGraph.kind === 'changed') summary.changedUiGraphs = (summary.changedUiGraphs ?? 0) + 1;
  }

  return summary;
}

export function summarizeGraphComparison(
  nodes: Record<NodeId, ProjectNodeComparison>,
  connections: Record<string, ProjectConnectionComparison>,
): ProjectGraphComparison['summary'] {
  const nodeComparisons = Object.values(nodes);
  const connectionComparisons = Object.values(connections);

  return {
    addedNodes: nodeComparisons.filter((node) => node.kind === 'added').length,
    removedNodes: nodeComparisons.filter((node) => node.kind === 'removed').length,
    changedNodes: nodeComparisons.filter((node) => node.kind === 'changed').length,
    addedConnections: connectionComparisons.filter((connection) => connection.kind === 'added').length,
    removedConnections: connectionComparisons.filter((connection) => connection.kind === 'removed').length,
    changedConnections: connectionComparisons.filter((connection) => connection.kind === 'changed' && connection.after)
      .length,
  };
}

function createEmptyProjectSummary(): ProjectComparison['summary'] {
  return {
    addedGraphs: 0,
    removedGraphs: 0,
    changedGraphs: 0,
    addedNodes: 0,
    removedNodes: 0,
    changedNodes: 0,
    addedConnections: 0,
    removedConnections: 0,
    changedConnections: 0,
  };
}

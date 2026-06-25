import type { NodeId } from '../../model/NodeBase.js';
import type {
  ProjectConnectionComparison,
  ProjectComparison,
  ProjectGraphComparison,
  ProjectNodeComparison,
} from '../projectComparison.js';

export function summarizeProjectComparison(
  graphs: Record<ProjectGraphComparison['id'], ProjectGraphComparison>,
): ProjectComparison['summary'] {
  return Object.values(graphs).reduce(
    (acc, graph) => {
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
    },
    createEmptyProjectSummary(),
  );
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
    changedConnections: connectionComparisons.filter((connection) => connection.kind === 'changed' && connection.after).length,
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

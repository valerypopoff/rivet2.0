import type { ProjectComparison, ProjectGraphComparison } from '@valerypopoff/rivet2-core';

export type ProjectComparisonSummaryCounts = {
  connectionChanges: number;
  graphs: number;
  nodes: number;
  nodePrefabs?: number;
};

export function getProjectComparisonReferenceFileName(referencePath: string | undefined, fallbackTitle: string): string {
  const fileName = referencePath?.split(/[\\/]/).filter(Boolean).at(-1);
  return fileName && fileName.length > 0 ? fileName : fallbackTitle;
}

export function getOverallProjectComparisonCounts(comparison: ProjectComparison): ProjectComparisonSummaryCounts {
  return {
    connectionChanges:
      comparison.summary.addedConnections + comparison.summary.removedConnections + comparison.summary.changedConnections,
    graphs: comparison.summary.addedGraphs + comparison.summary.removedGraphs + comparison.summary.changedGraphs,
    nodePrefabs:
      (comparison.summary.addedNodePrefabs ?? 0) +
      (comparison.summary.removedNodePrefabs ?? 0) +
      (comparison.summary.changedNodePrefabs ?? 0),
    nodes: Object.values(comparison.graphs).reduce(
      (count, graphComparison) => count + countHighlightedCurrentNodes(graphComparison),
      0,
    ),
  };
}

export function getGraphProjectComparisonCounts(
  graphComparison: ProjectGraphComparison | undefined,
): ProjectComparisonSummaryCounts {
  if (!graphComparison) {
    return {
      connectionChanges: 0,
      graphs: 0,
      nodes: 0,
      nodePrefabs: 0,
    };
  }

  return {
    connectionChanges:
      graphComparison.summary.addedConnections +
      graphComparison.summary.removedConnections +
      graphComparison.summary.changedConnections,
    graphs: graphComparison.kind === 'unchanged' ? 0 : 1,
    nodes: countHighlightedCurrentNodes(graphComparison),
    nodePrefabs: 0,
  };
}

export function formatProjectComparisonCounts(counts: ProjectComparisonSummaryCounts): string {
  return formatPresentCounts([
    formatPresentCount(counts.graphs, 'graph', 'graphs'),
    formatPresentCount(counts.nodes, 'node', 'nodes'),
    formatPresentCount(counts.nodePrefabs ?? 0, 'library node', 'library nodes'),
    formatPresentCount(counts.connectionChanges, 'connection change', 'connection changes'),
  ]);
}

export function formatProjectComparisonCurrentGraphCounts(counts: ProjectComparisonSummaryCounts): string {
  return formatPresentCounts([
    formatPresentCount(counts.nodes, 'node', 'nodes'),
    formatPresentCount(counts.connectionChanges, 'connection change', 'connection changes'),
  ]);
}

function formatPresentCounts(parts: Array<string | undefined>): string {
  const presentParts = parts.filter((part): part is string => part != null);
  return presentParts.length > 0 ? presentParts.join(', ') : 'No changes';
}

function formatPresentCount(count: number, singular: string, plural: string): string | undefined {
  if (count === 0) {
    return undefined;
  }

  return `${count} ${count === 1 ? singular : plural}`;
}

function countHighlightedCurrentNodes(graphComparison: ProjectGraphComparison): number {
  return Object.values(graphComparison.nodes).filter(
    (nodeComparison) =>
      (nodeComparison.kind === 'added' || nodeComparison.kind === 'changed') &&
      nodeComparison.after &&
      nodeComparison.after.type !== 'comment',
  ).length;
}

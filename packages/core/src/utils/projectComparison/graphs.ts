import type { NodeConnection } from '../../model/NodeBase.js';
import type { GraphId, NodeGraph } from '../../model/NodeGraph.js';
import { compareConnections, getComparableGraphConnections, getProjectConnectionComparisonKey } from './connections.js';
import { compareNodes, getComparableGraphNodes } from './nodes.js';
import { summarizeGraphComparison } from './summaries.js';
import type { ProjectConnectionComparison, ProjectGraphComparison, ProjectNodeComparison } from '../projectComparison.js';
import { areComparisonValuesEqual } from './values.js';

export function compareGraphs(
  id: GraphId,
  before: NodeGraph | undefined,
  after: NodeGraph | undefined,
): ProjectGraphComparison {
  if (!before && after) {
    return createOneSidedGraphComparison(id, after, 'added');
  }

  if (before && !after) {
    return createOneSidedGraphComparison(id, before, 'removed');
  }

  if (!before || !after) {
    throw new Error(`Cannot compare missing graph ${id}`);
  }

  const nodes = compareNodes(getComparableGraphNodes(before.nodes), getComparableGraphNodes(after.nodes));
  const connections = compareConnections(
    getComparableGraphConnections(before.connections, before.nodes),
    getComparableGraphConnections(after.connections, after.nodes),
  );
  const summary = summarizeGraphComparison(nodes, connections);
  const metadataChanged = !areComparisonValuesEqual(before.metadata, after.metadata);

  return {
    id,
    kind: metadataChanged || Object.values(summary).some((count) => count > 0) ? 'changed' : 'unchanged',
    before,
    after,
    metadataChanged,
    nodes,
    connections,
    summary,
  };
}

function createOneSidedGraphComparison(
  id: GraphId,
  graph: NodeGraph,
  kind: 'added' | 'removed',
): ProjectGraphComparison {
  const graphNodes = getComparableGraphNodes(graph.nodes);
  const graphConnections = getComparableGraphConnections(graph.connections, graph.nodes);
  const nodes = Object.fromEntries(
    graphNodes.map((node) => [
      node.id,
      kind === 'added'
        ? ({ id: node.id, kind, after: node } satisfies ProjectNodeComparison)
        : ({ id: node.id, kind, before: node } satisfies ProjectNodeComparison),
    ]),
  );
  const connections = createOneSidedConnectionComparisons(graphConnections, kind);

  return {
    id,
    kind,
    ...(kind === 'added' ? { after: graph } : { before: graph }),
    metadataChanged: true,
    nodes,
    connections,
    summary: summarizeGraphComparison(nodes, connections),
  };
}

function createOneSidedConnectionComparisons(
  connections: NodeConnection[],
  kind: 'added' | 'removed',
): Record<string, ProjectConnectionComparison> {
  return Object.fromEntries(
    connections.map((connection) => {
      const key = getProjectConnectionComparisonKey(connection);
      return [
        key,
        kind === 'added'
          ? ({ key, kind, after: connection } satisfies ProjectConnectionComparison)
          : ({ key, kind, before: connection } satisfies ProjectConnectionComparison),
      ];
    }),
  );
}

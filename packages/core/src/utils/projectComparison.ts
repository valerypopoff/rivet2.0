import type { ChartNode, NodeConnection, NodeId } from '../model/NodeBase.js';
import type { GraphId, NodeGraph } from '../model/NodeGraph.js';
import type { Project } from '../model/Project.js';
import { compareGraphs } from './projectComparison/graphs.js';
import { summarizeProjectComparison } from './projectComparison/summaries.js';
import { areComparisonValuesEqual, unionKeys } from './projectComparison/values.js';

export { getProjectConnectionComparisonKey } from './projectComparison/connections.js';
export { getProjectNodeFieldComparisons } from './projectComparison/nodes.js';

export type ProjectComparisonChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

export type ProjectNodeComparison = {
  id: NodeId;
  kind: ProjectComparisonChangeKind;
  before?: ChartNode;
  after?: ChartNode;
};

export type ProjectNodeFieldComparison = {
  field: string;
  path: string[];
  before?: unknown;
  after?: unknown;
};

export type ProjectConnectionComparison = {
  key: string;
  kind: ProjectComparisonChangeKind;
  before?: NodeConnection;
  after?: NodeConnection;
};

type ProjectGraphComparisonSummary = {
  addedNodes: number;
  removedNodes: number;
  changedNodes: number;
  addedConnections: number;
  removedConnections: number;
  changedConnections: number;
};

type ProjectComparisonSummary = {
  addedGraphs: number;
  removedGraphs: number;
  changedGraphs: number;
} & ProjectGraphComparisonSummary;

export type ProjectGraphComparison = {
  id: GraphId;
  kind: ProjectComparisonChangeKind;
  before?: NodeGraph;
  after?: NodeGraph;
  metadataChanged: boolean;
  nodes: Record<NodeId, ProjectNodeComparison>;
  connections: Record<string, ProjectConnectionComparison>;
  summary: ProjectGraphComparisonSummary;
};

export type ProjectComparison = {
  beforeProjectId: Project['metadata']['id'];
  afterProjectId: Project['metadata']['id'];
  metadataChanged: boolean;
  graphs: Record<GraphId, ProjectGraphComparison>;
  summary: ProjectComparisonSummary;
};

export function compareProjects(before: Project, after: Project): ProjectComparison {
  const graphIds = unionKeys(before.graphs, after.graphs) as GraphId[];
  const graphs = Object.fromEntries(
    graphIds.map((graphId) => [graphId, compareGraphs(graphId, before.graphs[graphId], after.graphs[graphId])]),
  ) as Record<GraphId, ProjectGraphComparison>;

  return {
    beforeProjectId: before.metadata.id,
    afterProjectId: after.metadata.id,
    metadataChanged: !areComparisonValuesEqual(before.metadata, after.metadata),
    graphs,
    summary: summarizeProjectComparison(graphs),
  };
}

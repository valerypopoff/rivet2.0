import type { ChartNode, NodeConnection, NodeId } from '../model/NodeBase.js';
import type { GraphId, NodeGraph } from '../model/NodeGraph.js';
import type { NodePrefab, NodePrefabId, Project } from '../model/Project.js';
import type { UiGraph, UiGraphId } from '../model/UiGraph.js';
import { compareGraphs } from './projectComparison/graphs.js';
import { summarizeProjectComparison } from './projectComparison/summaries.js';
import { compareNodes } from './projectComparison/nodes.js';
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
  addedNodePrefabs?: number;
  removedNodePrefabs?: number;
  changedNodePrefabs?: number;
  addedUiGraphs?: number;
  removedUiGraphs?: number;
  changedUiGraphs?: number;
} & ProjectGraphComparisonSummary;

export type ProjectNodePrefabComparison = {
  id: NodePrefabId;
  kind: ProjectComparisonChangeKind;
  before?: NodePrefab;
  after?: NodePrefab;
  sourceNode?: ProjectNodeComparison;
};

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

export type ProjectUiGraphComparison = {
  id: UiGraphId;
  kind: ProjectComparisonChangeKind;
  before?: UiGraph;
  after?: UiGraph;
};

export type ProjectComparison = {
  beforeProjectId: Project['metadata']['id'];
  afterProjectId: Project['metadata']['id'];
  metadataChanged: boolean;
  graphs: Record<GraphId, ProjectGraphComparison>;
  nodePrefabs?: Record<NodePrefabId, ProjectNodePrefabComparison>;
  uiGraphs?: Record<UiGraphId, ProjectUiGraphComparison>;
  summary: ProjectComparisonSummary;
};

export function compareProjects(before: Project, after: Project): ProjectComparison {
  const graphIds = unionKeys(before.graphs, after.graphs) as GraphId[];
  const graphs = Object.fromEntries(
    graphIds.map((graphId) => [graphId, compareGraphs(graphId, before.graphs[graphId], after.graphs[graphId])]),
  ) as Record<GraphId, ProjectGraphComparison>;
  const nodePrefabs = compareNodePrefabs(before.nodePrefabs ?? {}, after.nodePrefabs ?? {});
  const uiGraphs = compareUiGraphs(before.uiGraphs ?? {}, after.uiGraphs ?? {});

  return {
    beforeProjectId: before.metadata.id,
    afterProjectId: after.metadata.id,
    metadataChanged: !areComparisonValuesEqual(before.metadata, after.metadata),
    graphs,
    nodePrefabs,
    uiGraphs,
    summary: summarizeProjectComparison(graphs, nodePrefabs, uiGraphs),
  };
}

function compareNodePrefabs(
  before: Record<NodePrefabId, NodePrefab>,
  after: Record<NodePrefabId, NodePrefab>,
): Record<NodePrefabId, ProjectNodePrefabComparison> {
  const prefabIds = unionKeys(before, after) as NodePrefabId[];

  return Object.fromEntries(
    prefabIds.map((prefabId) => {
      const beforePrefab = before[prefabId];
      const afterPrefab = after[prefabId];

      if (!beforePrefab && afterPrefab) {
        return [prefabId, { id: prefabId, kind: 'added', after: afterPrefab }];
      }

      if (beforePrefab && !afterPrefab) {
        return [prefabId, { id: prefabId, kind: 'removed', before: beforePrefab }];
      }

      if (!beforePrefab || !afterPrefab) {
        throw new Error(`Cannot compare missing library node ${prefabId}`);
      }

      const sourceNodeComparison = Object.values(compareNodes([beforePrefab.sourceNode], [afterPrefab.sourceNode]))[0]!;

      return [
        prefabId,
        {
          id: prefabId,
          kind: sourceNodeComparison.kind === 'unchanged' ? 'unchanged' : 'changed',
          before: beforePrefab,
          after: afterPrefab,
          sourceNode: sourceNodeComparison,
        },
      ];
    }),
  ) as Record<NodePrefabId, ProjectNodePrefabComparison>;
}

function compareUiGraphs(
  before: Record<UiGraphId, UiGraph>,
  after: Record<UiGraphId, UiGraph>,
): Record<UiGraphId, ProjectUiGraphComparison> {
  const uiGraphIds = unionKeys(before, after) as UiGraphId[];

  return Object.fromEntries(
    uiGraphIds.map((uiGraphId) => {
      const beforeUiGraph = before[uiGraphId];
      const afterUiGraph = after[uiGraphId];

      if (!beforeUiGraph && afterUiGraph) {
        return [uiGraphId, { id: uiGraphId, kind: 'added', after: afterUiGraph }];
      }

      if (beforeUiGraph && !afterUiGraph) {
        return [uiGraphId, { id: uiGraphId, kind: 'removed', before: beforeUiGraph }];
      }

      if (!beforeUiGraph || !afterUiGraph) {
        throw new Error(`Cannot compare missing UI graph ${uiGraphId}`);
      }

      return [
        uiGraphId,
        {
          id: uiGraphId,
          kind: areComparisonValuesEqual(beforeUiGraph, afterUiGraph) ? 'unchanged' : 'changed',
          before: beforeUiGraph,
          after: afterUiGraph,
        },
      ];
    }),
  ) as Record<UiGraphId, ProjectUiGraphComparison>;
}

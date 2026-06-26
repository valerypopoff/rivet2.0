import type { ChartNode, GraphId, Project } from '@valerypopoff/rivet2-core';
import { entries } from '../utils/typeSafety';
import { NODE_LIBRARY_GRAPH_SEARCH_ID } from './graphSearch.js';

export type SearchableItem = {
  type: 'node';
  id: string;
  title: string;
  description: string;
  joinedData: string;
  containerGraph: GraphId;
  nodeType: string;
};

export function buildProjectSearchItems(
  project: Pick<Project, 'graphs' | 'nodePrefabs'>,
  getNodeTypeLabel: (node: ChartNode) => string,
): SearchableItem[] {
  const items: SearchableItem[] = [];

  const addNode = (node: ChartNode, containerGraph: GraphId) => {
    const joinedData = entries((node.data ?? {}) as object).map(([, value]) => `${value}`);

    items.push({
      type: 'node',
      title: node.title,
      description: node.description ?? '',
      id: node.id,
      joinedData: joinedData.join(' '),
      containerGraph,
      nodeType: getNodeTypeLabel(node),
    });
  };

  for (const graph of Object.values(project.graphs)) {
    const graphId = graph.metadata?.id;
    if (!graphId) {
      continue;
    }

    for (const node of graph.nodes) {
      addNode(node, graphId);
    }
  }

  for (const prefab of Object.values(project.nodePrefabs ?? {})) {
    addNode(prefab.sourceNode, NODE_LIBRARY_GRAPH_SEARCH_ID);
  }

  return items;
}

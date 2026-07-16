import {
  getUiGraphActionInputBindings,
  getUiGraphActionOutputBindings,
  type ChartNode,
  type GraphId,
  type Project,
  type UiGraph,
  type UiGraphId,
} from '@valerypopoff/rivet2-core';
import { entries } from '../utils/typeSafety';
import { NODE_LIBRARY_GRAPH_SEARCH_ID } from './graphSearch.js';

export type SearchableNodeItem = {
  type: 'node';
  id: string;
  title: string;
  description: string;
  joinedData: string;
  containerGraph: GraphId;
  nodeType: string;
};

export type SearchableUiGraphItem = {
  type: 'uiGraph';
  id: string;
  title: string;
  description: string;
  joinedData: string;
  uiGraphId: UiGraphId;
  nodeType: string;
};

export type SearchableItem = SearchableNodeItem | SearchableUiGraphItem;

export function buildProjectSearchItems(
  project: Pick<Project, 'graphs' | 'nodePrefabs' | 'uiGraphs'>,
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

  for (const uiGraph of Object.values(project.uiGraphs ?? {})) {
    items.push({
      type: 'uiGraph',
      id: uiGraph.id,
      title: uiGraph.name,
      description: uiGraph.description ?? '',
      joinedData: getUiGraphSearchData(uiGraph),
      uiGraphId: uiGraph.id,
      nodeType: 'Web app',
    });
  }

  return items;
}

function getUiGraphSearchData(uiGraph: UiGraph): string {
  return uiGraph.components
    .flatMap((component) => {
      switch (component.type) {
        case 'text':
          return [component.type, component.text];
        case 'markdown':
          return [component.type, component.markdown];
        case 'gap':
          return [component.type, component.size];
        case 'input':
        case 'textarea':
          return [component.type, component.label, component.placeholder, component.stateKey];
        case 'dropdown':
          return [
            component.type,
            component.label,
            component.stateKey,
            ...component.items.flatMap((item) => [item.label, item.value]),
          ];
        case 'output':
          return [component.type, component.label, component.stateKey, component.renderAs];
        case 'button':
          return [
            component.type,
            component.label,
            component.action.graphId,
            ...getUiGraphActionInputBindings(component.action).flatMap((binding) => [
              binding.inputKey,
              binding.stateKey,
            ]),
            ...getUiGraphActionOutputBindings(component.action).flatMap((binding) => [
              binding.outputKey,
              binding.stateKey,
            ]),
            component.action.outputKey,
            component.action.outputStateKey,
            ...Object.keys(component.action.inputs ?? {}),
          ];
        case 'chat':
          return [
            component.type,
            component.placeholder,
            component.action.graphId,
            component.action.userInputId,
            component.action.historyInputId,
            component.action.responseOutputId,
            ...(component.action.inputMappings ?? []).flatMap((binding) => [binding.inputKey, binding.stateKey]),
          ];
      }
    })
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
}

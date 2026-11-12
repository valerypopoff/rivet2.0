import { produce } from 'immer';
import { nanoid } from 'nanoid/non-secure';
import { type GraphId, type NodeGraph } from '@valerypopoff/rivet2-core';

export type PreparedCurrentGraphSave = {
  currentGraph: NodeGraph;
  savedGraphs: NodeGraph[];
};

export function shouldPersistCurrentGraph(graph: NodeGraph, savedGraphs: NodeGraph[]): boolean {
  if ('comparisonReferenceView' in graph && graph.comparisonReferenceView === true) return false;
  if (graph.nodes.length > 0 || graph.connections.length > 0) {
    return true;
  }

  const graphId = graph.metadata?.id;
  return graphId != null && savedGraphs.some((savedGraph) => savedGraph.metadata?.id === graphId);
}

export function prepareCurrentGraphForSave(
  graph: NodeGraph,
  savedGraphs: NodeGraph[],
): PreparedCurrentGraphSave | undefined {
  if (!shouldPersistCurrentGraph(graph, savedGraphs)) {
    return undefined;
  }

  const currentGraph = produce(graph, (draft) => {
    if (!draft.metadata) {
      draft.metadata = {
        id: nanoid() as GraphId,
        name: 'Untitled',
        description: '',
      };
    } else if (!draft.metadata.id) {
      draft.metadata.id = nanoid() as GraphId;
    }

    return draft;
  });

  const existingGraphIndex = savedGraphs.findIndex(
    (savedGraph) => savedGraph.metadata?.id === currentGraph.metadata?.id,
  );
  const nextSavedGraphs =
    existingGraphIndex === -1
      ? [...savedGraphs, currentGraph]
      : savedGraphs.map((savedGraph, index) => (index === existingGraphIndex ? currentGraph : savedGraph));

  return {
    currentGraph,
    savedGraphs: nextSavedGraphs,
  };
}

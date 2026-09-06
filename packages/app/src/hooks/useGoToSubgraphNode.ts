import { type ChartNode, type SubGraphNode } from '@valerypopoff/rivet2-core';
import { useAtomValue, useStore } from 'jotai';
import { createSubgraphGraphViewContext } from '../domain/graphEditing/navigationActions.js';
import { graphMetadataState } from '../state/graph.js';
import { projectState } from '../state/savedGraphs.js';
import {
  lastRunDataState,
  resolvedGraphSelectionState,
  selectedGraphRunByViewState,
  selectedProcessPageState,
} from '../state/dataFlow.js';
import { getSubgraphCallerRunSelection } from '../state/selectors/executionSelectors.js';
import { useLoadGraph } from './useLoadGraph.js';
import { useStableCallback } from './useStableCallback.js';

export function useGoToSubgraphNode() {
  const loadGraph = useLoadGraph();
  const project = useAtomValue(projectState);
  const graph = useAtomValue(graphMetadataState);
  const store = useStore();

  return useStableCallback((node: ChartNode | undefined) => {
    if (node?.type !== 'subGraph') {
      return;
    }

    const subGraphNode = node as SubGraphNode;
    const graphId = subGraphNode.data.graphId;
    const subgraph = project.graphs[graphId];

    if (!subgraph || !graph?.id) {
      return;
    }

    const graphView = createSubgraphGraphViewContext({
      graphId,
      parentGraphId: graph.id,
      parentNodeId: subGraphNode.id,
    });
    const callerSelection = getSubgraphCallerRunSelection(
      node.id,
      store.get(lastRunDataState(node.id)),
      store.get(selectedProcessPageState(node.id)),
      store.get(resolvedGraphSelectionState),
    );
    if (callerSelection) {
      store.set(selectedGraphRunByViewState, (previous) => ({ ...previous, [graphView.key]: callerSelection }));
    }
    loadGraph(subgraph, { graphView });
  });
}

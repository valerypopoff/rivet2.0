import { useStore } from 'jotai';
import { graphState } from '../state/graph.js';
import { savedGraphsState, projectState } from '../state/savedGraphs.js';
import { projectWorkspaceTargetsState } from '../state/workspaceTarget.js';
import { useStableCallback } from './useStableCallback.js';
import { prepareCurrentGraphForSave } from '../utils/currentGraphSave.js';

export function useSaveCurrentGraph() {
  const store = useStore();

  return useStableCallback(() => {
    if (store.get(projectWorkspaceTargetsState)[store.get(projectState).metadata.id]?.type === 'comparisonReference')
      return undefined;
    const graphData = store.get(graphState);
    const savedGraphs = store.get(savedGraphsState);
    const prepared = prepareCurrentGraphForSave(graphData, savedGraphs);

    if (!prepared) {
      return undefined;
    }

    store.set(graphState, prepared.currentGraph);
    store.set(savedGraphsState, prepared.savedGraphs);

    return prepared.currentGraph;
  });
}

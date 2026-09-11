import { useCallback } from 'react';
import { graphNavigationStackState } from '../state/graphBuilder.js';
import { projectState } from '../state/savedGraphs.js';
import { useLoadGraph } from '../hooks/useLoadGraph.js';
import { useAtom, useAtomValue } from 'jotai';
import { getGraphNavigationAvailability, resolveNavigationTarget } from '../domain/graphEditing/navigationActions.js';

export const useGraphHistoryNavigation = () => {
  const [graphNavigationStack, setGraphNavigationStack] = useAtom(graphNavigationStackState);
  const loadGraph = useLoadGraph();
  const project = useAtomValue(projectState);

  const { hasForward, hasBackward } = getGraphNavigationAvailability(graphNavigationStack, project);

  const navigateBack = useCallback(() => {
    const target = resolveNavigationTarget({
      direction: 'backward',
      navigationStack: graphNavigationStack,
      project,
    });

    if (!target) {
      return;
    }

    setGraphNavigationStack(target.nextStack);

    const graph = project.graphs[target.targetGraphId];

    if (graph) {
      loadGraph(graph, { graphView: target.targetView, pushHistory: false });
    }
  }, [graphNavigationStack, loadGraph, project, setGraphNavigationStack]);

  const navigateForward = useCallback(() => {
    const target = resolveNavigationTarget({
      direction: 'forward',
      navigationStack: graphNavigationStack,
      project,
    });

    if (!target) {
      return;
    }

    setGraphNavigationStack(target.nextStack);

    const graph = project.graphs[target.targetGraphId];

    if (graph) {
      loadGraph(graph, { graphView: target.targetView, pushHistory: false });
    }
  }, [graphNavigationStack, loadGraph, project, setGraphNavigationStack]);

  return { navigateBack, navigateForward, hasForward, hasBackward };
};

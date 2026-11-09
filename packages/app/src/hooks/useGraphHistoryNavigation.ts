import { useAtomValue, useStore } from 'jotai';
import { graphHistoryNavigationPendingState, graphNavigationStackState } from '../state/graphBuilder.js';
import { graphState } from '../state/graph.js';
import { openedProjectSnapshotsState, projectsState, projectState } from '../state/savedGraphs.js';
import { useLoadGraph } from './useLoadGraph.js';
import { useLoadProject } from './useLoadProject.js';
import { useStableCallback } from './useStableCallback.js';
import { getProjectActivationRevision } from '../utils/projectActivationCoordinator.js';
import {
  getGraphNavigationAvailability,
  resolveNavigationTarget,
  type GraphViewContext,
} from '../domain/graphEditing/navigationActions.js';

export const useGraphHistoryNavigation = () => {
  const store = useStore();
  const graphNavigationStack = useAtomValue(graphNavigationStackState);
  const pending = useAtomValue(graphHistoryNavigationPendingState);
  const loadGraph = useLoadGraph();
  const loadProject = useLoadProject();
  const project = useAtomValue(projectState);
  const projects = useAtomValue(projectsState);
  const snapshots = useAtomValue(openedProjectSnapshotsState);
  const getProject = (view: GraphViewContext) =>
    !view.projectId || view.projectId === project.metadata.id
      ? project
      : projects.openedProjects[view.projectId]
        ? snapshots[view.projectId]?.project
        : undefined;

  const { hasForward, hasBackward } = getGraphNavigationAvailability(graphNavigationStack, project, getProject);

  const navigate = useStableCallback(async (direction: 'backward' | 'forward') => {
    if (store.get(graphHistoryNavigationPendingState)) return;
    const currentProject = store.get(projectState);
    const target = resolveNavigationTarget({
      direction,
      navigationStack: store.get(graphNavigationStackState),
      project: currentProject,
      getProject: (view) =>
        !view.projectId || view.projectId === currentProject.metadata.id
          ? currentProject
          : store.get(projectsState).openedProjects[view.projectId]
            ? store.get(openedProjectSnapshotsState)[view.projectId]?.project
            : undefined,
    });

    if (!target) {
      return;
    }

    const targetProjectId = target.targetView.projectId ?? currentProject.metadata.id;
    if (targetProjectId !== currentProject.metadata.id) {
      const info = store.get(projectsState).openedProjects[targetProjectId];
      if (!info) return;
      store.set(graphHistoryNavigationPendingState, true);
      try {
        const activating = loadProject(info, { preferredGraphId: target.targetGraphId, graphView: target.targetView });
        const revision = getProjectActivationRevision(store);
        const loaded = await activating;
        if (
          !loaded ||
          revision !== getProjectActivationRevision(store) ||
          store.get(projectState).metadata.id !== targetProjectId ||
          store.get(graphState).metadata?.id !== target.targetGraphId
        )
          return;
        store.set(graphNavigationStackState, target.nextStack);
      } finally {
        store.set(graphHistoryNavigationPendingState, false);
      }
      return;
    }
    const graph = currentProject.graphs[target.targetGraphId];
    if (graph) {
      store.set(graphNavigationStackState, target.nextStack);
      loadGraph(graph, { graphView: target.targetView, pushHistory: false });
    }
  });

  return {
    navigateBack: () => navigate('backward'),
    navigateForward: () => navigate('forward'),
    hasForward: !pending && hasForward,
    hasBackward: !pending && hasBackward,
  };
};

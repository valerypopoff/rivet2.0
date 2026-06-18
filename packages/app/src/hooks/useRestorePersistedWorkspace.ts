import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { graphState } from '../state/graph.js';
import { canvasPositionState, graphNavigationStackState, lastCanvasPositionByGraphState } from '../state/graphBuilder.js';
import { openedProjectsState, openedProjectsSortedIdsState, projectState } from '../state/savedGraphs.js';
import { projectEditorHydratedState, projectEditorStateByProjectIdState } from '../state/projectEditor.js';
import { resolvePersistedCanvasPositionsForLegacyCache, resolveProjectEditorRestoreTarget } from '../utils/projectEditorState.js';
import { useCenterViewOnGraph } from './useCenterViewOnGraph.js';
import { handleError } from '../utils/errorHandling.js';
import { useApplyProjectExecutorMode } from './useProjectExecutorMode.js';

export function useRestorePersistedWorkspace() {
  const didRestoreRef = useRef(false);

  const currentProject = useAtomValue(projectState);
  const currentGraph = useAtomValue(graphState);
  const openedProjects = useAtomValue(openedProjectsState);
  const openedProjectIds = useAtomValue(openedProjectsSortedIdsState);
  const projectEditorStateByProjectId = useAtomValue(projectEditorStateByProjectIdState);
  const lastCanvasPositionsByGraph = useAtomValue(lastCanvasPositionByGraphState);

  const setGraph = useSetAtom(graphState);
  const setCanvasPosition = useSetAtom(canvasPositionState);
  const setGraphNavigationStack = useSetAtom(graphNavigationStackState);
  const setLastCanvasPositionsByGraph = useSetAtom(lastCanvasPositionByGraphState);
  const setProjectEditorHydrated = useSetAtom(projectEditorHydratedState);
  const centerViewOnGraph = useCenterViewOnGraph();
  const applyProjectExecutorMode = useApplyProjectExecutorMode();

  useEffect(() => {
    if (didRestoreRef.current) {
      return;
    }

    didRestoreRef.current = true;

    try {
      if (openedProjectIds.length === 0 || !currentProject.metadata.id) {
        return;
      }

      const currentProjectId = currentProject.metadata.id;
      const persistedProjectEditorState = projectEditorStateByProjectId[currentProjectId];
      const restoreTarget = resolveProjectEditorRestoreTarget({
        project: currentProject,
        persistedProjectEditorState,
        openedGraphId: openedProjects[currentProjectId]?.openedGraph,
        legacyCanvasPositionsByGraph: lastCanvasPositionsByGraph,
      });

      const persistedCanvasPositionsByGraph = resolvePersistedCanvasPositionsForLegacyCache({
        project: currentProject,
        persistedProjectEditorState,
      });
      if (Object.keys(persistedCanvasPositionsByGraph).length > 0) {
        setLastCanvasPositionsByGraph((previousPositionsByGraph) => ({
          ...previousPositionsByGraph,
          ...persistedCanvasPositionsByGraph,
        }));
      }

      const currentGraphId = currentGraph.metadata?.id;
      const currentGraphIsValid = currentGraphId != null && currentProject.graphs[currentGraphId] != null;
      const targetGraphId = restoreTarget.graph.metadata?.id;
      const graphForViewportRestore =
        currentGraphIsValid && currentGraphId != null && currentGraphId === targetGraphId ? currentGraph : restoreTarget.graph;

      setGraphNavigationStack(restoreTarget.navigationStack);

      if (restoreTarget.viewport.type === 'saved') {
        setCanvasPosition(restoreTarget.viewport.position);
      } else if (restoreTarget.viewport.type === 'center') {
        centerViewOnGraph(graphForViewportRestore);
      } else {
        setCanvasPosition({ x: 0, y: 0, zoom: 1 });
      }

      if (!currentGraphIsValid || (targetGraphId != null && currentGraphId !== targetGraphId)) {
        setGraph(restoreTarget.graph);
      }

      applyProjectExecutorMode(openedProjects[currentProjectId]?.executorMode);
    } catch (error) {
      handleError(error, 'Failed to restore persisted workspace view', {
        metadata: {
          currentGraphId: currentGraph.metadata?.id,
          currentProjectId: currentProject.metadata.id,
          openedProjectCount: openedProjectIds.length,
        },
        toastError: false,
      });
    } finally {
      setProjectEditorHydrated(true);
    }
  }, [
    centerViewOnGraph,
    applyProjectExecutorMode,
    currentGraph,
    currentProject,
    lastCanvasPositionsByGraph,
    openedProjectIds.length,
    openedProjects,
    projectEditorStateByProjectId,
    setCanvasPosition,
    setGraph,
    setGraphNavigationStack,
    setLastCanvasPositionsByGraph,
    setProjectEditorHydrated,
  ]);
}

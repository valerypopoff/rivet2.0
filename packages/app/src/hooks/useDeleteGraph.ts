import { useStore } from 'jotai';
import { type GraphId, emptyNodeGraph } from '@valerypopoff/rivet2-core';
import { graphState } from '../state/graph.js';
import { projectState, savedGraphsState } from '../state/savedGraphs.js';
import { frozenNodeOutputsState, runningGraphsState } from '../state/dataFlow.js';
import { removeFrozenNodeOutputsForGraphs } from '../utils/frozenNodeOutputs.js';
import { useStableCallback } from './useStableCallback.js';
import {
  graphNavigationStackState,
  lastCanvasPositionByGraphState,
  removeCanvasPositionsForGraphs,
} from '../state/graphBuilder.js';
import {
  clearRecoverableNodeConnectionsForGraphs,
  recoverableNodeConnectionsStatePerGraph,
} from '../state/recoverableNodeConnections.js';
import { projectEditorStateByProjectIdState } from '../state/projectEditor.js';
import { sanitizeNavigationStackForProject, sanitizeProjectEditorStateForProject } from '../utils/projectEditorState.js';
import { clearProjectWorkspaceTargetState, projectWorkspaceTargetsState } from '../state/workspaceTarget.js';
import { isProjectWorkspaceTargetValid } from '../domain/workspace/projectWorkspaceTarget.js';
import { getGraphIdsReferencingGraph, getUiGraphIdsReferencingGraph } from '../utils/graphReachability.js';

export type DeleteGraphsResult = {
  blockedGraphIds: GraphId[];
  deletedGraphIds: GraphId[];
  referencedGraphIds: GraphId[];
};

/**
 * Deletes project graphs as one local editor transition. Project content and
 * graph-scoped session state have different lifetimes, so the latter must not
 * retain references to a graph after the former no longer contains it.
 */
export function useDeleteGraphs() {
  const store = useStore();

  return useStableCallback((requestedGraphIds: readonly GraphId[]): DeleteGraphsResult => {
    const project = store.get(projectState);
    const deletedGraphIds = [...new Set(requestedGraphIds.filter((graphId) => project.graphs[graphId] != null))];
    if (deletedGraphIds.length === 0) {
      return { blockedGraphIds: [], deletedGraphIds: [], referencedGraphIds: [] };
    }

    const deletedGraphIdSet = new Set(deletedGraphIds);
    const blockedGraphIds = [...new Set(store.get(runningGraphsState).filter((graphId) => deletedGraphIdSet.has(graphId)))];
    if (blockedGraphIds.length > 0) {
      return { blockedGraphIds, deletedGraphIds: [], referencedGraphIds: [] };
    }

    const referencedGraphIds = deletedGraphIds.filter((targetGraphId) => {
      const isReferencedByRetainedGraph = [...getGraphIdsReferencingGraph(project, targetGraphId, {
        includeDelegateFunctionCallEdges: true,
        includeDynamicCallGraphEdges: false,
      })].some((referencingGraphId) => !deletedGraphIdSet.has(referencingGraphId));
      return isReferencedByRetainedGraph || getUiGraphIdsReferencingGraph(project, targetGraphId).size > 0;
    });
    if (referencedGraphIds.length > 0) {
      return { blockedGraphIds: [], deletedGraphIds: [], referencedGraphIds };
    }

    const currentGraphId = store.get(graphState).metadata?.id;
    const currentGraphWasDeleted = currentGraphId != null && deletedGraphIdSet.has(currentGraphId);

    store.set(savedGraphsState, (previousGraphs) =>
      previousGraphs.filter((graph) => {
        const graphId = graph.metadata?.id;
        return graphId == null || !deletedGraphIdSet.has(graphId);
      }),
    );

    const nextProject = store.get(projectState);
    store.set(frozenNodeOutputsState, (previousOutputs) => removeFrozenNodeOutputsForGraphs(previousOutputs, deletedGraphIds));
    store.set(recoverableNodeConnectionsStatePerGraph, (previousConnections) =>
      clearRecoverableNodeConnectionsForGraphs(previousConnections, deletedGraphIds),
    );
    store.set(lastCanvasPositionByGraphState, (previousPositions) =>
      removeCanvasPositionsForGraphs(previousPositions, deletedGraphIds),
    );
    store.set(projectEditorStateByProjectIdState, (previousEditorStateByProjectId) => {
      const projectId = nextProject.metadata.id;
      const previousEditorState = previousEditorStateByProjectId[projectId];
      if (!previousEditorState) {
        return previousEditorStateByProjectId;
      }

      return {
        ...previousEditorStateByProjectId,
        [projectId]: sanitizeProjectEditorStateForProject(nextProject, previousEditorState),
      };
    });

    // The blank placeholder is deliberately not a project graph. It cannot
    // share a navigation entry with a deleted graph, otherwise the target and
    // visible canvas disagree until the next project transition.
    store.set(graphNavigationStackState, (previousNavigationStack) =>
      currentGraphWasDeleted
        ? { stack: [], index: undefined }
        : sanitizeNavigationStackForProject(nextProject, previousNavigationStack),
    );

    const projectId = nextProject.metadata.id;
    const workspaceTarget = store.get(projectWorkspaceTargetsState)[projectId];
    if (workspaceTarget && !isProjectWorkspaceTargetValid(workspaceTarget, nextProject)) {
      store.set(clearProjectWorkspaceTargetState, projectId);
    }

    // Deleting another graph is a project edit; it must not discard the
    // active canvas or its unsaved edits. The deleted active graph has no
    // remaining canvas, so replace only that one with the normal placeholder.
    if (currentGraphWasDeleted) {
      store.set(graphState, emptyNodeGraph());
    }

    return { blockedGraphIds: [], deletedGraphIds, referencedGraphIds: [] };
  });
}

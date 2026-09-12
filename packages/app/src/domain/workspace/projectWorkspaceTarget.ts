import type { GraphId, NodePrefabId, Project, UiGraphId } from '@valerypopoff/rivet2-core';
import { createRootGraphViewContext, type GraphViewContext } from '../graphEditing/navigationActions.js';

export type ProjectWorkspaceTarget =
  | { type: 'graph'; graphView: GraphViewContext }
  | { type: 'nodeLibrary'; editingPrefabId?: NodePrefabId }
  | { type: 'uiGraph'; uiGraphId: UiGraphId };

export type ProjectWorkspaceTargetCapabilities = {
  canRun: boolean;
  hasCanvas: boolean;
};

export type ProjectWorkspaceLeavePolicy = {
  commitLiveGraph: boolean;
  persistGraphViewport: boolean;
};

type WorkspaceTargetProject = Pick<Project, 'graphs' | 'uiGraphs'>;

export function createGraphWorkspaceTarget(graphView: GraphViewContext): ProjectWorkspaceTarget {
  return { graphView, type: 'graph' };
}

export function getProjectWorkspaceTargetCapabilities(
  target: ProjectWorkspaceTarget | undefined,
): ProjectWorkspaceTargetCapabilities {
  return {
    canRun: target == null || target.type === 'graph',
    hasCanvas: target?.type !== 'uiGraph',
  };
}

export function getProjectWorkspaceLeavePolicy(
  target: ProjectWorkspaceTarget | undefined,
): ProjectWorkspaceLeavePolicy {
  const leavesGraph = target == null || target.type === 'graph';
  return { commitLiveGraph: leavesGraph, persistGraphViewport: leavesGraph };
}

/** A nested graph view is valid only while its exact Subgraph caller remains. */
export function isProjectGraphViewContextValid(
  graphView: GraphViewContext,
  project: Pick<Project, 'graphs'>,
): boolean {
  if (!project.graphs[graphView.graphId]) {
    return false;
  }

  if (!graphView.parent) {
    return true;
  }

  const parentNode = project.graphs[graphView.parent.parentGraphId]?.nodes.find(
    (node) => node.id === graphView.parent?.parentNodeId,
  );
  return parentNode?.type === 'subGraph' && (parentNode.data as { graphId?: GraphId }).graphId === graphView.graphId;
}

/**
 * Workspace targets are session state, while graphs and web apps are project
 * content. Validate the former against the latter whenever project content can
 * have changed outside a workspace transition (for example, graph deletion).
 */
export function isProjectWorkspaceTargetValid(
  target: ProjectWorkspaceTarget,
  project: WorkspaceTargetProject,
): boolean {
  if (target.type === 'nodeLibrary') {
    return true;
  }

  if (target.type === 'uiGraph') {
    return project.uiGraphs?.[target.uiGraphId] != null;
  }

  return isProjectGraphViewContextValid(target.graphView, project);
}

export function resolveProjectWorkspaceTarget(options: {
  fallbackGraphView: GraphViewContext;
  project: Pick<Project, 'nodePrefabs' | 'uiGraphs'>;
  restoreResourceTarget: boolean;
  storedTarget?: ProjectWorkspaceTarget;
}): ProjectWorkspaceTarget {
  const { fallbackGraphView, project, restoreResourceTarget, storedTarget } = options;

  if (restoreResourceTarget && storedTarget?.type === 'nodeLibrary') {
    const editingPrefabId =
      storedTarget.editingPrefabId && project.nodePrefabs?.[storedTarget.editingPrefabId]
        ? storedTarget.editingPrefabId
        : undefined;
    return { editingPrefabId, type: 'nodeLibrary' };
  }

  if (restoreResourceTarget && storedTarget?.type === 'uiGraph' && project.uiGraphs?.[storedTarget.uiGraphId]) {
    return storedTarget;
  }

  return createGraphWorkspaceTarget(fallbackGraphView);
}

export function getFallbackGraphView(graphId: GraphId): GraphViewContext {
  return createRootGraphViewContext(graphId);
}

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

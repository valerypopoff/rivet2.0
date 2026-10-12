import { resolveNodePrefabInstance, type NodeGraph, type Project, type RootRunId } from '@valerypopoff/rivet2-core';
import type { ProcessDataForNode, RunDataByNodeId } from '../../state/dataFlow.js';
import { buildModelInvocationTrace } from '../agentTrace/agentTraceViewModel.js';
import type { RunActivityInvocationIdentity } from './types.js';

/** Resolve live retained evidence, never a click-time snapshot or another invocation. */
export function resolveRunActivityInspectorTrace(
  project: Project,
  currentGraph: NodeGraph,
  runDataByNode: RunDataByNodeId,
  identity: RunActivityInvocationIdentity,
) {
  const graph = currentGraph.metadata?.id === identity.graphId ? currentGraph : project.graphs[identity.graphId];
  const node = graph?.nodes.find((candidate) => candidate.id === identity.nodeId);
  return node == null
    ? undefined
    : buildModelInvocationTrace(
        resolveNodePrefabInstance(project, node),
        findExactProcessData(runDataByNode, identity),
      );
}

export function findExactProcessData(
  runDataByNode: RunDataByNodeId,
  identity: RunActivityInvocationIdentity,
): ProcessDataForNode | undefined {
  return runDataByNode[identity.nodeId]?.find(
    (process) =>
      process.rootRunId === identity.rootRunId &&
      process.graphRunId === identity.graphRunId &&
      process.processId === identity.processId &&
      (process.graphId == null || process.graphId === identity.graphId),
  );
}

/**
 * Response inspectors belong to one rendered Run Activity root. Keeping one
 * open after the drawer closes or another root is selected would show stale
 * trace data without its owning activity row.
 */
export function shouldCloseRunActivityInspector(options: {
  drawerOpen: boolean;
  inspectedRootRunId: RootRunId | undefined;
  selectedRootRunId: RootRunId | undefined;
}): boolean {
  if (options.inspectedRootRunId == null) {
    return false;
  }

  return !options.drawerOpen || options.inspectedRootRunId !== options.selectedRootRunId;
}

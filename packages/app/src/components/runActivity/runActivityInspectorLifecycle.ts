import {
  resolveNodePrefabInstance,
  type NodeGraph,
  type PortId,
  type Project,
  type RootRunId,
} from '@valerypopoff/rivet2-core';
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

export function findExactProcessPage(runDataByNode: RunDataByNodeId, identity: RunActivityInvocationIdentity) {
  const graphProcesses =
    runDataByNode[identity.nodeId]?.filter(
      (process) =>
        process.rootRunId === identity.rootRunId &&
        process.graphRunId === identity.graphRunId &&
        (process.graphId == null || process.graphId === identity.graphId),
    ) ?? [];
  const page = graphProcesses.findIndex((process) => process.processId === identity.processId);
  return page < 0 ? undefined : page;
}

/** Result-owner pointers identify a concrete retained port, not merely a node. */
export function processHasStoredOutputPort(processData: ProcessDataForNode, outputPortId: PortId): boolean {
  return (
    processData.data.outputData?.[outputPortId] != null ||
    Object.values(processData.data.splitOutputData ?? {}).some((outputs) => outputs?.[outputPortId] != null)
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

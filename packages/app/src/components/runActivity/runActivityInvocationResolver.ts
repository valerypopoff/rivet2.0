import {
  resolveNodePrefabInstance,
  type ChartNode,
  type GraphId,
  type NodeGraph,
  type NodeRegistration,
  type NodeRunActivityDescriptor,
  type Project,
} from '@valerypopoff/rivet2-core';
import type { RunDataByNodeId } from '../../state/dataFlow.js';
import type { RunActivityNodeInvocation, RunActivityRoot } from '../../features/runActivity/runActivityJournal.js';
import { hasStoredPortMapValues, hasStoredSplitOutputValues } from '../../utils/executionDataReaders.js';
import { canInspectModelInvocation } from '../agentTrace/agentTraceViewModel.js';
import { findExactProcessData } from './runActivityInspectorLifecycle.js';
import type { ResolveRunActivityInvocation, RunActivityInvocationResolution } from './buildRunActivityViewModel.js';

export function getCurrentGraphDefinition(saved: NodeGraph | undefined, current: NodeGraph, graphId: GraphId) {
  return current.metadata?.id === graphId ? current : saved;
}

/** One presentation lifetime, reset by the owning component when definitions or
 * registry change. No IDs-only global cache and no retained output dereference. */
export function createRunActivityInvocationResolver(
  project: Project,
  currentGraph: NodeGraph,
  registry: Pick<NodeRegistration, 'createDynamicImpl' | 'getDynamicDisplayName'>,
) {
  const nodesByGraph = new WeakMap<NodeGraph, Map<string, ChartNode>>();
  const definitions = new WeakMap<
    ChartNode,
    { effective: ChartNode; displayName: string; descriptor: NodeRunActivityDescriptor | undefined }
  >();
  const cache = new WeakMap<
    RunActivityNodeInvocation,
    {
      processData: ReturnType<typeof findExactProcessData>;
      graphRuns: RunActivityRoot['graphRunsById'];
      graphRun: Parameters<ResolveRunActivityInvocation>[0]['graphRun'];
      rootGraphId: RunActivityRoot['rootGraphId'];
      rootGraphName: string | undefined;
      result: RunActivityInvocationResolution;
    }
  >();
  const findNode = (graph: NodeGraph | undefined, id: string) => {
    if (!graph) return undefined;
    let index = nodesByGraph.get(graph);
    if (!index) {
      index = new Map();
      for (const node of graph.nodes) if (!index.has(node.id)) index.set(node.id, node);
      nodesByGraph.set(graph, index);
    }
    return index.get(id);
  };
  const definition = (node: ChartNode | undefined) => {
    if (!node) return undefined;
    let value = definitions.get(node);
    if (!value) {
      const effective = resolveNodePrefabInstance(project, node);
      let displayName = effective.type,
        descriptor;
      try {
        displayName = registry.getDynamicDisplayName(effective.type);
      } catch {
        /* Deleted plugin fallback. */
      }
      try {
        descriptor = registry.createDynamicImpl(effective).getRunActivityDescriptor();
      } catch {
        /* Metadata is optional. */
      }
      value = { effective, displayName, descriptor };
      definitions.set(node, value);
    }
    return value;
  };
  return (
    context: Parameters<ResolveRunActivityInvocation>[0],
    runDataByNode: RunDataByNodeId,
  ): RunActivityInvocationResolution => {
    const { root, graphRun, invocation } = context;
    const processData = findExactProcessData(runDataByNode, invocation);
    const previous = cache.get(invocation);
    if (
      previous &&
      previous.processData === processData &&
      previous.graphRun === graphRun &&
      previous.graphRuns === root.graphRunsById &&
      previous.rootGraphId === root.rootGraphId &&
      previous.rootGraphName === root.rootGraphName
    )
      return previous.result;
    const graph =
      graphRun?.projectId != null && graphRun.projectId !== project.metadata.id
        ? undefined
        : getCurrentGraphDefinition(project.graphs[invocation.graphId], currentGraph, invocation.graphId);
    const sourceNode = findNode(graph, invocation.nodeId),
      resolved = definition(sourceNode);
    const executor = graphRun?.executor;
    const parent = graphRun?.parentGraphRunId == null ? undefined : root.graphRunsById[graphRun.parentGraphRunId];
    const foreignCaller = graphRun?.projectId != null && parent?.projectId !== project.metadata.id;
    const parentGraph =
      executor == null || foreignCaller
        ? undefined
        : getCurrentGraphDefinition(project.graphs[executor.parentGraphId], currentGraph, executor.parentGraphId);
    const callerNode = executor == null ? undefined : findNode(parentGraph, executor.nodeId);
    const label = (text: string | undefined) => text?.trim() || undefined;
    const result: RunActivityInvocationResolution = {
      graphName: graph?.metadata?.name,
      nodeTitle: sourceNode?.title,
      nodeType: resolved?.displayName ?? invocation.nodeType,
      ...(executor == null
        ? {}
        : {
            subgraphCaller: {
              nodeTitle:
                label(callerNode?.title) ?? label(definition(callerNode)?.displayName) ?? 'Unavailable caller node',
              graphName:
                label(parentGraph?.metadata?.name) ??
                label(parent?.graphName) ??
                (executor.parentGraphId === root.rootGraphId ? label(root.rootGraphName) : undefined) ??
                'Unavailable caller graph',
            },
          }),
      category: resolved?.descriptor?.category,
      primaryOutputPortId: resolved?.descriptor?.primaryOutputPortId,
      runData: processData?.data,
      navigable: graph != null && sourceNode != null,
      fullOutputAvailable:
        graph != null &&
        sourceNode != null &&
        processData != null &&
        (hasStoredPortMapValues(processData.data.outputData) ||
          hasStoredSplitOutputValues(processData.data.splitOutputData)),
      fullOutputActionLabel: resolved?.descriptor?.fullOutputActionLabel,
      inspectable: resolved != null && canInspectModelInvocation(resolved.effective, processData),
      searchTerms: [sourceNode?.title, resolved?.effective.type, resolved?.displayName].filter(
        (value): value is string => value != null && value.length > 0,
      ),
    };
    cache.set(invocation, {
      processData,
      graphRun,
      graphRuns: root.graphRunsById,
      rootGraphId: root.rootGraphId,
      rootGraphName: root.rootGraphName,
      result,
    });
    return result;
  };
}

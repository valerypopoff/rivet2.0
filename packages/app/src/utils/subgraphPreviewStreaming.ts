import type { NodeGraph, NodeId, Project } from '@valerypopoff/rivet2-core';

// Hosted previews intentionally omit executable nodes and connections. Keep
// their server-derived stream hints outside Project so they cannot be saved.
const previewStreamingOutputs = new WeakMap<Project, ReadonlyMap<string, ReadonlySet<string>>>();

export function rememberSubgraphPreviewStreamingOutputs(
  project: Project,
  outputNodeIdsByGraph: Record<string, readonly string[]>,
): void {
  previewStreamingOutputs.set(
    project,
    new Map(
      Object.entries(outputNodeIdsByGraph)
        .filter(([, ids]) => Array.isArray(ids))
        .map(([graphId, ids]) => [graphId, new Set(ids.filter((id) => typeof id === 'string'))]),
    ),
  );
}

export function getSubgraphPreviewGraphOutputStreamingCapability(
  project: Project,
  graph: NodeGraph,
  outputNodeId: NodeId,
): boolean | undefined {
  const ids = graph.metadata?.id && previewStreamingOutputs.get(project)?.get(graph.metadata.id);
  return ids?.has(outputNodeId);
}

import type { GraphId } from '../NodeGraph.js';
import type { Project } from '../Project.js';
import type { ToolCallDelegationConfig } from '../nodes/toolCallDelegation.js';

export type ResolvedToolHandler =
  | { kind: 'graph'; graphId: GraphId; graphName?: string }
  | { kind: 'external'; name: string }
  | { kind: 'unknown'; graphId: GraphId };

export function findAutoDelegateGraphCandidate<T>(
  candidates: readonly T[],
  toolName: string,
  getGraphName: (candidate: T) => string | undefined,
): T | undefined {
  return (
    candidates.find((candidate) => getGraphName(candidate) === toolName) ??
    candidates.find((candidate) => getGraphName(candidate)?.includes(toolName))
  );
}

/**
 * Preserves legacy exact-name then first fuzzy auto-delegation matching in a
 * single resolver, making all runtime paths use identical routing.
 */
export function resolveToolHandler(params: {
  project: Project;
  toolName: string;
  config: ToolCallDelegationConfig;
  hasExternalFunction: boolean;
}): ResolvedToolHandler | undefined {
  const { project, toolName, config, hasExternalFunction } = params;
  if (!config.autoDelegate) {
    const selected = config.handlers.find((handler) => handler.key === toolName);
    if (selected)
      return { kind: 'graph', graphId: selected.value, graphName: project.graphs[selected.value]?.metadata?.name };
    return config.unknownHandler ? { kind: 'unknown', graphId: config.unknownHandler } : undefined;
  }
  const graph = findAutoDelegateGraphCandidate(
    Object.values(project.graphs),
    toolName,
    (candidate) => candidate.metadata?.name,
  );
  if (graph?.metadata?.id) return { kind: 'graph', graphId: graph.metadata.id, graphName: graph.metadata.name };
  if (config.fallBackToExternalCall && hasExternalFunction) return { kind: 'external', name: toolName };
  return config.unknownHandler ? { kind: 'unknown', graphId: config.unknownHandler } : undefined;
}

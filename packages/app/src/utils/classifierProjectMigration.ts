import {
  hasLegacyClassifierGraphData,
  hasLegacyClassifierProjectData,
  normalizeClassifierGraph,
  normalizeClassifierProject,
  type NodeGraph,
  type Project,
} from '@valerypopoff/rivet2-core';

/**
 * Project files are normalized by Core deserialization. App-state snapshots,
 * however, can come directly from a host callback or browser storage. Clone
 * only legacy data before applying Core's intentional in-place migration so
 * the host's object and already-current state retain their identity.
 */
export function normalizeClassifierProjectForAppState<T extends Project>(project: T): T {
  if (!hasLegacyClassifierProjectData(project)) return project;
  const normalized = structuredClone(project);
  normalizeClassifierProject(normalized);
  return normalized;
}

export function normalizeClassifierGraphForAppState<T extends NodeGraph>(graph: T): T {
  if (!hasLegacyClassifierGraphData(graph)) return graph;
  const normalized = structuredClone(graph);
  normalizeClassifierGraph(normalized);
  return normalized;
}

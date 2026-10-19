import { resolveNodePrefabInstance, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import type { OpenedProjectInfo, OpenedProjectSnapshot } from '../state/savedGraphs.js';

/** Undirected open-project component: attaching from a dependency also finds its callers. */
export function getRemoteDebuggerBundleProjects(
  projectId: ProjectId,
  opened: Record<ProjectId, OpenedProjectInfo>,
  snapshots: Record<ProjectId, OpenedProjectSnapshot>,
  active: Project,
): ProjectId[] {
  const neighbors = new Map<ProjectId, Set<ProjectId>>();
  const link = (left: ProjectId, right: ProjectId) => {
    if (!opened[left] || !opened[right] || left === right) return;
    if (!neighbors.has(left)) neighbors.set(left, new Set());
    if (!neighbors.has(right)) neighbors.set(right, new Set());
    neighbors.get(left)!.add(right);
    neighbors.get(right)!.add(left);
  };
  const manifests = new Map<string, ProjectId>();
  for (const [key, info] of Object.entries(opened)) {
    const id = key as ProjectId;
    if (info.bundleManifestPath) {
      const first = manifests.get(info.bundleManifestPath);
      if (first) link(first, id);
      else manifests.set(info.bundleManifestPath, id);
    }
    const project = active.metadata.id === id ? active : snapshots[id]?.project;
    if (!project) continue;
    for (const reference of project.references ?? []) link(id, reference.id);
    for (const graph of Object.values(project.graphs))
      for (const authored of graph.nodes) {
        const node = resolveNodePrefabInstance(project, authored);
        if (node.disabled || node.type !== 'subGraph') continue;
        const target = (node.data as { targetProjectId?: string }).targetProjectId;
        if (target) link(id, target as ProjectId);
      }
  }
  const members = new Set<ProjectId>([projectId]);
  for (const id of members) for (const neighbor of neighbors.get(id) ?? []) members.add(neighbor);
  return [...members];
}

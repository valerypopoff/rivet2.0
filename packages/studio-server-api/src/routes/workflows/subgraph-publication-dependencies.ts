import { resolveNodePrefabInstance, type Project, type SubGraphNode } from '@valerypopoff/rivet2-node';

/** Dynamic saved-latest calls can change the behavior of an already-published caller. */
export function listSavedLatestSubgraphProjectIds(project: Project): string[] {
  const ids = new Set<string>();
  for (const graph of Object.values(project.graphs)) {
    for (const authored of graph.nodes) {
      const node = resolveNodePrefabInstance(project, authored);
      if (node.type !== 'subGraph' || node.disabled) continue;
      const target = node as SubGraphNode;
      if (target.data.targetProjectId && (target.data.targetVersion ?? 'latest') === 'latest') {
        ids.add(target.data.targetProjectId);
      }
    }
  }
  return [...ids].sort();
}

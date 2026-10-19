import type { Project } from './Project.js';
import type { SubGraphNode } from './nodes/SubGraphNode.js';
import type { ReferencedGraphAliasNode } from './nodes/ReferencedGraphAliasNode.js';
import { resolveNodePrefabInstance } from './NodePrefabResolver.js';

/** Explicit cross-project calls; graph identity is always paired with its owner. */
export type ProjectGraphCallSite = {
  sourceGraphId: string;
  sourceGraphName: string;
  nodeId: string;
  nodeTitle: string;
  targetProjectId: string;
  targetGraphId: string;
  targetVersion: 'latest' | 'published' | 'project-reference';
};

export function listProjectGraphCallSites(project: Project): ProjectGraphCallSite[] {
  const calls: ProjectGraphCallSite[] = [];
  for (const [sourceGraphId, graph] of Object.entries(project.graphs)) {
    for (const authored of graph.nodes) {
      const node = resolveNodePrefabInstance(project, authored);
      if (node.disabled) continue;
      // Broken library links have no effective call to inspect. They must not
      // suppress known callers elsewhere or make the reference check incomplete.
      if (node.type === 'nodePrefabInstance') continue;
      let targetProjectId: string | undefined;
      let targetGraphId: string;
      let targetVersion: ProjectGraphCallSite['targetVersion'];
      if (node.type === 'subGraph') {
        const data = (node as SubGraphNode).data;
        targetProjectId = data.targetProjectId;
        targetGraphId = data.graphId;
        targetVersion = data.targetVersion ?? 'latest';
        if (targetVersion !== 'latest' && targetVersion !== 'published') throw new Error('Invalid Subgraph version.');
      } else if (node.type === 'referencedGraphAlias') {
        const data = (node as ReferencedGraphAliasNode).data;
        targetProjectId = data.projectId;
        targetGraphId = data.graphId;
        targetVersion = 'project-reference';
      } else continue;
      if (!targetProjectId || !targetGraphId) continue;
      calls.push({
        sourceGraphId,
        sourceGraphName: graph.metadata?.name ?? sourceGraphId,
        nodeId: authored.id,
        nodeTitle: node.title || (node.type === 'subGraph' ? 'Subgraph' : 'Referenced Graph Alias'),
        targetProjectId,
        targetGraphId,
        targetVersion,
      });
    }
  }
  return calls;
}

import type { SubGraphNode } from '@valerypopoff/rivet2-core';
import type { SubgraphProjectCatalogProvider } from '../providers/ProvidersContext.js';

export type SubgraphProjectTree = Awaited<ReturnType<SubgraphProjectCatalogProvider['listTree']>>;
export function findSubgraphProjectBundle(tree: SubgraphProjectTree | null, projectId: string): string | null {
  const visit = (tree: SubgraphProjectTree, inherited: string | null): string | null | undefined => {
    const item = tree.projects.find((p) => p.projectMetadataId === projectId);
    if (item) return item.bundleId === undefined ? inherited : item.bundleId;
    for (const folder of tree.folders) {
      const found = visit(folder, folder.bundleId ?? inherited);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return tree ? visit(tree, null) ?? null : null;
}

export function subgraphSourceScope(data: SubGraphNode['data'], tree: SubgraphProjectTree | null, ownId: string) {
  const bundle = findSubgraphProjectBundle(tree, ownId);
  // Once membership is known, the selected target wins over a saved UI hint.
  // Moves must not strand ordinary targets in a sibling-only picker.
  if (tree && data.targetProjectId)
    return bundle && findSubgraphProjectBundle(tree, data.targetProjectId) === bundle
      ? 'same-bundle'
      : 'other-projects';
  if (data.targetScope === 'same-bundle' && (!tree || bundle)) return 'same-bundle';
  return data.targetScope || data.targetProjectId ? 'other-projects' : 'this-project';
}

/** Picker projection only; the server independently validates every runtime edge. */
export function filterSubgraphProjectTree(
  tree: SubgraphProjectTree,
  ownId: string,
  scope: string,
): SubgraphProjectTree {
  const ownBundle = findSubgraphProjectBundle(tree, ownId);
  const visit = (tree: SubgraphProjectTree, inherited: string | null): SubgraphProjectTree => ({
    projects: tree.projects.filter((p) => {
      const bundle = p.bundleId === undefined ? inherited : p.bundleId;
      return scope === 'same-bundle' ? Boolean(ownBundle && bundle === ownBundle) : !bundle;
    }),
    folders: tree.folders.flatMap((folder) => {
      const filtered = visit(folder, folder.bundleId ?? inherited);
      return filtered.projects.length || filtered.folders.length ? [{ ...folder, ...filtered }] : [];
    }),
  });
  if (scope === 'same-bundle') {
    const findRoot = (branch: SubgraphProjectTree): SubgraphProjectTree | undefined => {
      for (const folder of branch.folders) {
        if (folder.bundleId === ownBundle) return folder;
        const found = findRoot(folder);
        if (found) return found;
      }
      return undefined;
    };
    const root = ownBundle ? findRoot(tree) : undefined;
    // Start at the bundle's contents, not its ancestors or the bundle wrapper.
    return root ? visit(root, ownBundle) : { projects: [], folders: [] };
  }
  return visit(tree, null);
}

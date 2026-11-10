import { type Project, type ProjectId } from '@valerypopoff/rivet2-node';
import type { BundleMergeSite } from '../../../../studio-server-shared/workflow-bundle-types.js';

export const bundleGraphKey = (projectId: string, graphId: string) => JSON.stringify([projectId, graphId]);

/** Authored bindings include disabled nodes, Library sources and inactive variants. */
function* projectReferenceData(project: Project) {
  // Runtime resolves links before checking disabled state, inheriting it from
  // the Library source rather than from the authored link wrapper.
  const usedPrefabs = new Set(
    Object.values(project.graphs).flatMap((graph) =>
      graph.nodes
        .filter((node) => node.type === 'nodePrefabInstance')
        .map((node) => (node.data as { prefabId?: string } | null)?.prefabId),
    ),
  );
  for (const { node, location, active } of [
    ...Object.entries(project.graphs).flatMap(([graphId, graph]) =>
      graph.nodes.map((node) => ({
        node,
        location: { graphId, graphName: graph.metadata?.name || graphId },
        active: !node.disabled,
      })),
    ),
    ...Object.entries(project.nodePrefabs ?? {}).map(([prefabId, prefab]) => ({
      node: prefab.sourceNode,
      location: { prefabId },
      active: usedPrefabs.has(prefabId) && !prefab.sourceNode.disabled,
    })),
  ]) {
    if (node.type !== 'subGraph' && node.type !== 'referencedGraphAlias') continue;
    const field = node.type === 'subGraph' ? 'targetProjectId' : 'projectId';
    for (const [index, value] of [node.data, ...(node.variants ?? []).map((variant) => variant.data)].entries()) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const data = value as Record<string, unknown>;
      if (typeof data[field] === 'string' && data[field])
        yield {
          node,
          data,
          field,
          id: data[field] as ProjectId,
          site: {
            projectId: project.metadata.id,
            projectTitle: project.metadata.title || project.metadata.id,
            ...location,
            nodeId: node.id,
            nodeTitle: node.title,
            ...(index ? { variantIndex: index - 1 } : {}),
            active: active && index === 0,
          } satisfies BundleMergeSite,
        };
    }
  }
}

export function inspectBundleProjectBindings(project: Project) {
  return [
    ...(project.references ?? []).map((reference) => ({
      kind: 'reference' as const,
      projectId: reference.id as string,
      graphId: undefined as string | undefined,
      version: 'latest' as const,
      boundary: undefined,
      invalidVersion: false,
      site: { projectId: project.metadata.id, projectTitle: project.metadata.title, active: true } as BundleMergeSite,
    })),
    ...Array.from(projectReferenceData(project), ({ id, node, data, site }) => ({
      kind: node.type === 'subGraph' ? ('subgraph' as const) : ('alias' as const),
      projectId: id as string,
      graphId: typeof data.graphId === 'string' ? data.graphId : undefined,
      version:
        node.type === 'subGraph' && data.targetVersion === 'published' ? ('published' as const) : ('latest' as const),
      invalidVersion:
        node.type === 'subGraph' &&
        data.targetVersion !== undefined &&
        data.targetVersion !== 'latest' &&
        data.targetVersion !== 'published',
      boundary:
        node.type === 'subGraph'
          ? (data.targetBoundary as import('@valerypopoff/rivet2-node').GraphBoundary | undefined)
          : undefined,
      site,
    })),
  ];
}

/** No mutation and no graph resolution: missing Library definitions cannot hide other bindings. */
export function listBundleProjectReferenceIds(project: Project): Set<string> {
  return new Set([
    ...(project.references ?? []).map((reference) => reference.id),
    ...Array.from(projectReferenceData(project), (binding) => binding.id),
  ]);
}

/** Mutates an already-private parsed copy. External bindings are deliberately retained. */
export function remapBundleProject(
  project: Project,
  ids: ReadonlyMap<string, ProjectId>,
  options: { graphs?: ReadonlyMap<string, string>; titles?: ReadonlyMap<string, string> } = {},
): Set<string> {
  const external = new Set<string>();
  const map = (id: ProjectId) => {
    const mapped = ids.get(id);
    if (!mapped) external.add(id);
    return mapped ?? id;
  };
  const own = ids.get(project.metadata.id);
  if (!own) throw new Error('Project is not a member of the copied bundle.');
  project.metadata.id = own;
  delete project.metadata.path;
  if (project.references)
    project.references = project.references.map((reference) => {
      const id = map(reference.id);
      if (id === reference.id) return reference;
      const { hintPaths: _hints, ...rest } = reference;
      return { ...rest, id, ...(options.titles?.has(id) ? { title: options.titles.get(id)! } : {}) };
    });
  for (const { node, data, field, id } of projectReferenceData(project)) {
    const mapped = map(id);
    if (mapped === id) continue;
    data[field] = mapped;
    if (typeof data.graphId === 'string')
      data.graphId = options.graphs?.get(bundleGraphKey(id, data.graphId)) ?? data.graphId;
    if (node.type === 'subGraph') data.targetVersion = 'latest';
  }
  return external;
}

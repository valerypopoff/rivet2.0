import { type Project, type ProjectId } from '@valerypopoff/rivet2-node';

/** Authored bindings include disabled nodes, Library sources and inactive variants. */
function* projectReferenceData(project: Project) {
  for (const node of [
    ...Object.values(project.graphs).flatMap((graph) => graph.nodes),
    ...Object.values(project.nodePrefabs ?? {}).map((prefab) => prefab.sourceNode),
  ]) {
    if (node.type !== 'subGraph' && node.type !== 'referencedGraphAlias') continue;
    const field = node.type === 'subGraph' ? 'targetProjectId' : 'projectId';
    for (const value of [node.data, ...(node.variants ?? []).map((variant) => variant.data)]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const data = value as Record<string, unknown>;
      if (typeof data[field] === 'string' && data[field]) yield { node, data, field, id: data[field] as ProjectId };
    }
  }
}

/** No mutation and no graph resolution: missing Library definitions cannot hide other bindings. */
export function listBundleProjectReferenceIds(project: Project): Set<string> {
  return new Set([
    ...(project.references ?? []).map((reference) => reference.id),
    ...Array.from(projectReferenceData(project), (binding) => binding.id),
  ]);
}

/** Mutates an already-private parsed copy. External bindings are deliberately retained. */
export function remapBundleProject(project: Project, ids: ReadonlyMap<string, ProjectId>): Set<string> {
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
      return { ...rest, id };
    });
  for (const { node, data, field, id } of projectReferenceData(project)) {
    const mapped = map(id);
    if (mapped === id) continue;
    data[field] = mapped;
    if (node.type === 'subGraph') data.targetVersion = 'latest';
  }
  return external;
}

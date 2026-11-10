import type {
  BundleMergeProject,
  BundleMergePreview,
  BundleMergeSite,
} from '../../studio-server-shared/workflow-bundle-types';

/** Suggestions need an explicit click. Names are never treated as identity. */
export function suggestBundleMergeCounterpart(source: BundleMergeProject, destination: readonly BundleMergeProject[]) {
  const path = destination.filter((project) => project.relativePath === source.relativePath);
  if (path.length === 1) return path[0]!.projectId;
  const title = destination.filter((project) => project.title === source.title);
  return title.length === 1 ? title[0]!.projectId : null;
}

export function describeBundleMergeSite(
  site: BundleMergeSite,
  catalogs: Pick<BundleMergePreview, 'source' | 'destination'> | null,
) {
  const catalog =
    catalogs &&
    [catalogs.source, catalogs.destination].find((value) =>
      value.projects.some((project) => project.projectId === site.projectId),
    );
  const project = catalog?.projects.find((project) => project.projectId === site.projectId);
  return [
    project ? `${catalog!.relativePath}/${project.relativePath}` : `${site.projectTitle} (${site.projectId})`,
    site.graphName || site.graphId || site.prefabId,
    site.nodeTitle,
    site.nodeId && `(${site.nodeId})`,
    site.variantIndex !== undefined && `variant ${site.variantIndex + 1}`,
    !site.active && '(inactive)',
  ]
    .filter(Boolean)
    .join(' / ');
}

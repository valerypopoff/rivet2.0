import type {
  BundleMergeProject,
  BundleMergePreview,
  BundleMergeSite,
  BundleMergeChoices,
  BundleMergeSuggestion,
} from '../../studio-server-shared/workflow-bundle-types';

const projectExtension = '.rivet-project';

/** Display names never expose the storage suffix; persisted paths retain it. */
export function displayBundleMergePath(path: string) {
  return path.endsWith(projectExtension) ? path.slice(0, -projectExtension.length) : path;
}

export function savedBundleMergePath(displayPath: string) {
  return displayPath ? displayPath + projectExtension : '';
}

export function formatBundleMergeProject(project: BundleMergeProject) {
  const path = displayBundleMergePath(project.relativePath);
  return path === project.title ? project.title : `${project.title} — ${path}`;
}

/** Metadata fallback for older APIs; names remain suggestions rather than identity. */
export function suggestBundleMergeCounterpart(source: BundleMergeProject, destination: readonly BundleMergeProject[]) {
  const path = destination.filter((project) => project.relativePath === source.relativePath);
  if (path.length === 1) return path[0]!.projectId;
  const title = destination.filter((project) => project.title === source.title);
  return title.length === 1 ? title[0]!.projectId : null;
}

/** Fill only untouched choices. A skipped action or edited path must not reappear on validation. */
export function applyBundleMergeSuggestions(
  choices: BundleMergeChoices,
  preview: BundleMergePreview,
  suggestions: BundleMergeSuggestion[] | undefined,
  initialize: boolean,
): BundleMergeChoices {
  const actions =
    initialize &&
    suggestions &&
    suggestions.some((suggestion) => suggestion.state === 'changed' || suggestion.state === 'new')
      ? suggestions.flatMap((suggestion): BundleMergeChoices['actions'] => {
          if (suggestion.state === 'changed' && suggestion.targetProjectId)
            return [
              {
                sourceProjectId: suggestion.sourceProjectId,
                kind: 'replace',
                targetProjectId: suggestion.targetProjectId,
              },
            ];
          const source = preview.source.projects.find((project) => project.projectId === suggestion.sourceProjectId);
          return suggestion.state === 'new' && source
            ? [{ sourceProjectId: source.projectId, kind: 'add', relativePath: source.relativePath }]
            : [];
        })
      : choices.actions;
  const dependencies = [...choices.dependencies];
  for (const { project } of preview.requiredProjects) {
    if (
      actions.some((action) => action.sourceProjectId === project.projectId) ||
      dependencies.some((choice) => choice.sourceProjectId === project.projectId)
    )
      continue;
    const suggestion = suggestions?.find((suggestion) => suggestion.sourceProjectId === project.projectId);
    const target =
      suggestion?.targetProjectId ??
      (!suggestions ? suggestBundleMergeCounterpart(project, preview.destination.projects) : null);
    if (target) dependencies.push({ sourceProjectId: project.projectId, kind: 'existing', targetProjectId: target });
    else if (suggestion?.state === 'new')
      dependencies.push({ sourceProjectId: project.projectId, kind: 'add', relativePath: project.relativePath });
  }
  return actions === choices.actions && dependencies.length === choices.dependencies.length
    ? choices
    : { ...choices, actions, dependencies };
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
    project
      ? `${catalog!.name}/${displayBundleMergePath(project.relativePath)}`
      : `${site.projectTitle} (${site.projectId})`,
    site.graphName || site.graphId || site.prefabId,
    site.nodeTitle,
    site.nodeId && `(${site.nodeId})`,
    site.variantIndex !== undefined && `variant ${site.variantIndex + 1}`,
    !site.active && '(inactive)',
  ]
    .filter(Boolean)
    .join(' / ');
}

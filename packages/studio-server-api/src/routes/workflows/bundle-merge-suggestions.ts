import { createHash } from 'node:crypto';
import {
  remapOwnedDatasets,
  type ProjectId,
  type loadProjectAndAttachedDataFromString,
} from '@valerypopoff/rivet2-node';
import type {
  BundleMergeProject,
  BundleMergeSuggestion,
} from '../../../../studio-server-shared/workflow-bundle-types.js';
import { mutationRequestText } from '../../../../studio-server-shared/workflow-mutation-contract.js';
import type { parseBundleDatasets } from './bundle-datasets.js';
import { remapBundleProject } from './remap-bundle-project.js';

export type BundleMergeSavedContent = {
  project: ReturnType<typeof loadProjectAndAttachedDataFromString>[0];
  attached: ReturnType<typeof loadProjectAndAttachedDataFromString>[1];
  datasets: ReturnType<typeof parseBundleDatasets>;
};

/** Suggestions compare saved content; a new project ID or revision alone is not a change. */
export async function suggestBundleMergeChanges(
  source: readonly BundleMergeProject[],
  destination: readonly BundleMergeProject[],
  load: (id: string) => Promise<BundleMergeSavedContent>,
): Promise<BundleMergeSuggestion[]> {
  if (!source.length) return [];
  if (!destination.length) return source.map((project) => ({ sourceProjectId: project.projectId, state: 'new' }));
  const saved = new Map<string, BundleMergeSavedContent>();
  const projects = [...source, ...destination];
  // Bound cloud reads, and stop scheduling more work when a batch fails.
  for (let offset = 0; offset < projects.length; offset += 4)
    await Promise.all(
      projects.slice(offset, offset + 4).map(async (project) => {
        saved.set(project.projectId, await load(project.projectId));
      }),
    );

  const matches = new Map<string, string>();
  const ambiguous = new Set<string>();
  const graphOnly = new Set<string>();
  const propose = (candidates: Map<string, string[]>) => {
    const counts = new Map<string, number>();
    for (const values of candidates.values()) for (const id of values) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, values] of candidates) {
      if (values.length === 1 && counts.get(values[0]!) === 1) matches.set(id, values[0]!);
      else if (values.length) ambiguous.add(id);
    }
  };
  for (const field of ['relativePath', 'title'] as const) {
    const claimed = new Set(matches.values());
    const candidates = new Map<string, string[]>();
    for (const project of source) {
      if (matches.has(project.projectId) || ambiguous.has(project.projectId)) continue;
      candidates.set(
        project.projectId,
        destination
          .filter((target) => !claimed.has(target.projectId) && target[field] === project[field])
          .map((target) => target.projectId),
      );
    }
    propose(candidates);
  }
  const claimed = new Set(matches.values());
  const graphCandidates = new Map<string, string[]>();
  for (const project of source) {
    if (matches.has(project.projectId) || ambiguous.has(project.projectId)) continue;
    const ids = new Set(Object.keys(saved.get(project.projectId)!.project.graphs));
    graphCandidates.set(
      project.projectId,
      destination
        .filter(
          (target) =>
            !claimed.has(target.projectId) &&
            Object.keys(saved.get(target.projectId)!.project.graphs).some((id) => ids.has(id)),
        )
        .map((target) => target.projectId),
    );
    graphOnly.add(project.projectId);
  }
  propose(graphCandidates);

  const ids = new Map([...matches].map(([sourceId, targetId]) => [sourceId, targetId as ProjectId]));
  const titles = new Map(destination.map((project) => [project.projectId, project.title]));
  const internalTargets = new Set(destination.map((project) => project.projectId));
  const contentHash = (id: string, targetId: string, remap: boolean) => {
    const value = saved.get(id)!;
    const project = structuredClone(value.project);
    if (remap) remapBundleProject(project, ids, { titles });
    project.metadata.title = titles.get(targetId)!;
    delete project.metadata.path;
    // Discovery hints and catalog labels do not change the saved executable content.
    for (const reference of project.references ?? [])
      if (internalTargets.has(reference.id)) {
        delete reference.hintPaths;
        reference.title = titles.get(reference.id);
      }
    const datasets = value.datasets ? remapOwnedDatasets(value.datasets, id as ProjectId, targetId as ProjectId) : [];
    return createHash('sha256')
      .update(mutationRequestText(null, { project, attached: value.attached, datasets }))
      .digest('hex');
  };
  return source.map((project) => {
    const target = matches.get(project.projectId);
    if (!target)
      return { sourceProjectId: project.projectId, state: ambiguous.has(project.projectId) ? 'ambiguous' : 'new' };
    // A renamed graph-only match is useful, but never hide it as certainly unchanged.
    const unchanged =
      !graphOnly.has(project.projectId) &&
      contentHash(project.projectId, target, true) === contentHash(target, target, false);
    return { sourceProjectId: project.projectId, targetProjectId: target, state: unchanged ? 'unchanged' : 'changed' };
  });
}

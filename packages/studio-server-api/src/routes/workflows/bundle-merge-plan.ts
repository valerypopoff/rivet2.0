import type { Project } from '@valerypopoff/rivet2-node';
import type {
  BundleMergeAction,
  BundleMergeChoices,
  BundleMergeProject,
  BundleMergeSite,
} from '../../../../studio-server-shared/workflow-bundle-types.js';
import { badRequest } from '../../utils/httpError.js';
import { inspectBundleProjectBindings } from './remap-bundle-project.js';

export const bundleMergeAdditionId = (id: string) => `merge-add:${id}`;

/** Only imported content expands the queue. A reference-only counterpart never does. */
export async function resolveBundleMerge(
  source: readonly BundleMergeProject[],
  destination: readonly BundleMergeProject[],
  choices: BundleMergeChoices,
  load: (id: string) => Promise<Project>,
) {
  const sources = new Map(source.map((project) => [project.projectId, project]));
  const targets = new Set(destination.map((project) => project.projectId));
  const explicit = new Map<string, BundleMergeAction>();
  const dependencies = new Map(choices.dependencies.map((choice) => [choice.sourceProjectId, choice]));
  if (dependencies.size !== choices.dependencies.length) throw badRequest('Duplicate dependency correspondence.');
  const writes = new Set<string>();
  for (const choice of choices.actions) {
    if (!sources.has(choice.sourceProjectId)) throw badRequest('A selected project is not in the source bundle.');
    if (choice.kind !== 'add' && !targets.has(choice.targetProjectId))
      throw badRequest('A counterpart is not in the destination bundle.');
  }
  for (const action of choices.actions) {
    if (explicit.has(action.sourceProjectId)) throw badRequest('Choose one action per source project.');
    if (action.kind === 'replace') {
      if (writes.has(action.targetProjectId)) throw badRequest('Two projects cannot replace the same destination.');
      writes.add(action.targetProjectId);
    }
    explicit.set(action.sourceProjectId, action);
  }
  const actions = new Map(explicit);
  const mapping = new Map<string, string>();
  for (const action of actions.values())
    mapping.set(
      action.sourceProjectId,
      action.kind === 'add' ? bundleMergeAdditionId(action.sourceProjectId) : action.targetProjectId,
    );
  const required = new Map<string, { project: BundleMergeProject; sites: BundleMergeSite[] }>();
  const bindings: ReturnType<typeof inspectBundleProjectBindings> = [];
  const queue = [...actions.keys()];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (visited.has(id)) continue;
    visited.add(id);
    const project = await load(id);
    for (const binding of inspectBundleProjectBindings(project)) {
      bindings.push(binding);
      const member = sources.get(binding.projectId);
      if (!member || explicit.has(member.projectId)) continue;
      const entry = required.get(member.projectId) ?? { project: member, sites: [] };
      entry.sites.push(binding.site);
      required.set(member.projectId, entry);
      if (mapping.has(member.projectId)) continue;
      const dependency = dependencies.get(member.projectId);
      if (!dependency) continue;
      if (dependency.kind === 'existing') {
        if (!targets.has(dependency.targetProjectId))
          throw badRequest('A required counterpart is not in the destination bundle.');
        mapping.set(member.projectId, dependency.targetProjectId);
      } else {
        mapping.set(member.projectId, bundleMergeAdditionId(member.projectId));
        actions.set(member.projectId, dependency);
        queue.push(member.projectId);
      }
    }
  }
  return { actions: [...actions.values()], mapping, requiredProjects: [...required.values()], bindings };
}

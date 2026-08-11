import type { Project, ProjectId, RivetLLMProfileHealthSnapshot } from '@valerypopoff/rivet2-core';

export function getOperationalLLMProfileHealthEntries(
  projectId: ProjectId,
  entries: readonly RivetLLMProfileHealthSnapshot[],
): readonly RivetLLMProfileHealthSnapshot[] {
  return entries
    .filter(
      (entry) =>
        entry.identity.projectId === projectId &&
        entry.state !== 'closed',
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function getLLMProfileHealthDisplayName(
  project: Project | undefined,
  snapshot: RivetLLMProfileHealthSnapshot,
): string {
  const profileNodeId = snapshot.identity.profileNodeId;
  if (project && profileNodeId != null) {
    for (const graph of Object.values(project.graphs)) {
      const node = graph.nodes.find((candidate) => candidate.id === profileNodeId);
      if (node) {
        return `${node.title || 'LLM Profile'} in ${graph.metadata?.name || 'unnamed graph'}`;
      }
    }
  }

  return profileNodeId == null ? 'LLM Profile' : `LLM Profile ${profileNodeId}`;
}

export function getLLMProfileHealthIdentityLabel(snapshot: RivetLLMProfileHealthSnapshot): string {
  const provider = snapshot.identity.provider === 'custom'
    ? `Custom ${snapshot.identity.customProviderApi === 'responses' ? 'Responses' : 'Completions'}`
    : snapshot.identity.provider;
  return `${provider}/${snapshot.identity.model}`;
}

export function getLLMProfileHealthStatusDetail(
  snapshot: RivetLLMProfileHealthSnapshot,
  now = Date.now(),
): string {
  const failureLabel = `${snapshot.failureCount} recent failure${snapshot.failureCount === 1 ? '' : 's'}`;
  if (snapshot.state === 'open' && snapshot.openUntil != null && snapshot.openUntil > now) {
    return `${failureLabel} - suspended until ${new Date(snapshot.openUntil).toLocaleString()}`;
  }
  if (snapshot.halfOpenLeaseUntil != null && snapshot.halfOpenLeaseUntil > now) {
    return `${failureLabel} - recovery attempt in progress`;
  }
  return `${failureLabel} - awaiting recovery attempt`;
}

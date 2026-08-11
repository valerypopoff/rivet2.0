import type { Project, RivetLLMProfileHealthSnapshot } from '@valerypopoff/rivet2-core';

export function getLLMProfileHealthDisplayName(project: Project, snapshot: RivetLLMProfileHealthSnapshot): string {
  const profileNodeId = snapshot.identity.profileNodeId;
  if (profileNodeId != null) {
    for (const graph of Object.values(project.graphs)) {
      const node = graph.nodes.find((candidate) => candidate.id === profileNodeId);
      if (node) {
        return `${node.title || 'LLM Profile'} in ${graph.metadata?.name || 'unnamed graph'}`;
      }
    }
  }

  return `${snapshot.identity.provider}/${snapshot.identity.model}`;
}

export function getLLMProfileHealthIdentityLabel(snapshot: RivetLLMProfileHealthSnapshot): string {
  const provider =
    snapshot.identity.provider === 'custom'
      ? `Custom ${snapshot.identity.customProviderApi === 'responses' ? 'Responses' : 'Completions'}`
      : snapshot.identity.provider;
  return `${provider}/${snapshot.identity.model}`;
}

export function getLLMProfileHealthDetail(snapshot: RivetLLMProfileHealthSnapshot, now = Date.now()): string {
  const failureLabel = `${snapshot.failureCount} recent failure${snapshot.failureCount === 1 ? '' : 's'}`;
  if (snapshot.state === 'open' && snapshot.openUntil != null) {
    if (snapshot.openUntil <= now) return `${failureLabel} - recovery probe available`;
    return `${failureLabel} - suspended until ${new Date(snapshot.openUntil).toLocaleString()}`;
  }
  if (snapshot.state === 'half-open') {
    return `${failureLabel} - recovery probe ${snapshot.halfOpenLeaseUntil != null && snapshot.halfOpenLeaseUntil > now ? 'in progress' : 'available'}`;
  }
  return failureLabel;
}

export function normalizeLLMProfileHealthEntries(
  projectId: Project['metadata']['id'],
  entries: readonly RivetLLMProfileHealthSnapshot[],
): readonly RivetLLMProfileHealthSnapshot[] {
  return entries
    .filter((entry) => entry.identity.projectId === projectId)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

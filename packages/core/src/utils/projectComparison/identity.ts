import type { ChartNode } from '../../model/NodeBase.js';

export type ProjectComparisonIdentity = {
  pairs: readonly { beforeProjectId: string; afterProjectId: string }[];
};
export type ProjectComparisonSide = 'before' | 'after';

/** Side-specific tagged identities cannot equate a stale opposite-bundle link. */
export function comparisonProjectIdentity(
  id: string,
  side: ProjectComparisonSide,
  identity: ProjectComparisonIdentity,
): string {
  const index = identity.pairs.findIndex((p) => (side === 'before' ? p.beforeProjectId : p.afterProjectId) === id);
  return JSON.stringify(index < 0 ? ['project', id] : ['pair', index]);
}

export function comparisonNodeIdentity(
  node: ChartNode,
  side: ProjectComparisonSide,
  identity?: ProjectComparisonIdentity,
): ChartNode {
  if (!identity || (node.type !== 'subGraph' && node.type !== 'referencedGraphAlias')) return node;
  const field = node.type === 'subGraph' ? 'targetProjectId' : 'projectId';
  const data = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return typeof record[field] === 'string'
      ? { ...record, [field]: comparisonProjectIdentity(record[field], side, identity) }
      : value;
  };
  return {
    ...node,
    data: data(node.data),
    ...(node.variants ? { variants: node.variants.map((v) => ({ ...v, data: data(v.data) })) } : {}),
  } as ChartNode;
}

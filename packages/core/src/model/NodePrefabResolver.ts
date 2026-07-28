import type { ChartNode } from './NodeBase.js';
import type { NodePrefabId, Project } from './Project.js';

export const NODE_PREFAB_INSTANCE_TYPE = 'nodePrefabInstance';

export type NodePrefabInstanceNodeData = {
  prefabId?: NodePrefabId;
};

export type NodePrefabInstanceNode = ChartNode<typeof NODE_PREFAB_INSTANCE_TYPE, NodePrefabInstanceNodeData>;

const BLOCKED_NODE_PREFAB_SOURCE_TYPES = new Set([
  'comment',
  'graphInput',
  'graphOutput',
  'referencedGraphAlias',
  NODE_PREFAB_INSTANCE_TYPE,
]);

export function isNodePrefabInstanceNode(node: ChartNode | undefined): node is NodePrefabInstanceNode {
  return node?.type === NODE_PREFAB_INSTANCE_TYPE;
}

export function canUseNodeAsPrefabSource(node: ChartNode): boolean {
  return !BLOCKED_NODE_PREFAB_SOURCE_TYPES.has(node.type);
}

export function getNodePrefabInstancePrefabId(node: ChartNode | undefined): NodePrefabId | undefined {
  if (!isNodePrefabInstanceNode(node)) {
    return undefined;
  }

  const prefabId = node.data?.prefabId;
  return typeof prefabId === 'string' && prefabId.length > 0 ? (prefabId as NodePrefabId) : undefined;
}

export function resolveNodePrefabInstance(project: Project, node: ChartNode): ChartNode {
  const prefabId = getNodePrefabInstancePrefabId(node);
  if (!prefabId) {
    return node;
  }

  const sourceNode = project.nodePrefabs?.[prefabId]?.sourceNode;
  if (!sourceNode || !canUseNodeAsPrefabSource(sourceNode)) {
    return {
      ...node,
      title: `Missing library node (${prefabId})`,
    };
  }

  return {
    ...structuredClone(sourceNode),
    id: node.id,
    visualData: {
      ...structuredClone(sourceNode.visualData),
      x: node.visualData.x,
      y: node.visualData.y,
      width: node.visualData.width ?? sourceNode.visualData.width,
      zIndex: node.visualData.zIndex,
    },
  };
}

/**
 * Turns a valid graph-local library link into its current effective node.
 *
 * The returned node keeps the link's id and graph-local geometry, so existing
 * connections remain valid. All node behavior and settings are cloned from
 * the library source. Missing or invalid sources cannot be detached because
 * there is no concrete node definition to preserve.
 */
export function detachNodePrefabInstance(project: Project, node: ChartNode): ChartNode | undefined {
  const prefabId = getNodePrefabInstancePrefabId(node);
  const sourceNode = prefabId ? project.nodePrefabs?.[prefabId]?.sourceNode : undefined;

  if (!sourceNode || !canUseNodeAsPrefabSource(sourceNode)) {
    return undefined;
  }

  return resolveNodePrefabInstance(project, node);
}

export function resolveNodePrefabInstances(project: Project, nodes: readonly ChartNode[]): ChartNode[] {
  return nodes.map((node) => resolveNodePrefabInstance(project, node));
}

export function getNodePrefabDisplayName(project: Project, prefabId: NodePrefabId | undefined): string {
  if (!prefabId) {
    return 'Missing library node';
  }

  const sourceNode = project.nodePrefabs?.[prefabId]?.sourceNode;
  return sourceNode && canUseNodeAsPrefabSource(sourceNode)
    ? sourceNode.title || 'Untitled library node'
    : 'Missing library node';
}

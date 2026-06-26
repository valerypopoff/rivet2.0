import type { ChartNode } from '@valerypopoff/rivet2-core';
import { createPastedNodes } from '../graphEditing/nodeActions.js';
import { buildNodePrefab, canUseNodeAsPrefabSource } from './nodePrefabs.js';

export function createPastedNodeLibraryPrefabs({
  nodes,
  position,
}: {
  nodes: readonly ChartNode[];
  position: { x: number; y: number };
}) {
  const supportedNodes = nodes.filter(canUseNodeAsPrefabSource);
  const skippedNodeCount = nodes.length - supportedNodes.length;

  if (supportedNodes.length === 0) {
    return {
      prefabs: [],
      skippedNodeCount,
    };
  }

  const { newNodes } = createPastedNodes({
    nodes: supportedNodes,
    connections: [],
    position,
  });

  return {
    prefabs: newNodes.map(buildNodePrefab),
    skippedNodeCount,
  };
}

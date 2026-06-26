import { atom } from 'jotai';
import { type ChartNode, type NodeId } from '@valerypopoff/rivet2-core';
import { projectState } from '../savedGraphs.js';

const EMPTY_NODE_PREFAB_SOURCE_NODES_BY_ID = {} as Record<NodeId, ChartNode>;

export const nodePrefabSourceNodesByIdState = atom((get) => {
  const nodePrefabs = get(projectState).nodePrefabs;

  if (!nodePrefabs) {
    return EMPTY_NODE_PREFAB_SOURCE_NODES_BY_ID;
  }

  return Object.fromEntries(
    Object.values(nodePrefabs).map((prefab) => [prefab.sourceNode.id, prefab.sourceNode]),
  ) as Record<NodeId, ChartNode>;
});

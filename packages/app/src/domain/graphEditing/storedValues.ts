import type { ChartNode, NodeGraph, Project } from '@valerypopoff/rivet2-core';
import { getGraphsWithLiveGraph } from './globalVariables.js';

export function getStaticSetStoredValueKey(node: ChartNode): string | undefined {
  if (node.type !== 'setStoredValue' || node.disabled) return undefined;
  const data = node.data as { key?: unknown; useKeyInput?: unknown };
  if (data.useKeyInput) return undefined;
  return typeof data.key === 'string' && data.key.trim() ? data.key : undefined;
}

export function getStaticStoredValueKeys(
  project: Pick<Project, 'graphs'> | undefined,
  liveGraph?: NodeGraph,
): Set<string> {
  const keys = new Set<string>();
  for (const graph of getGraphsWithLiveGraph(project, liveGraph)) {
    for (const node of graph.nodes ?? []) {
      const key = getStaticSetStoredValueKey(node);
      if (key) keys.add(key);
    }
  }
  return keys;
}

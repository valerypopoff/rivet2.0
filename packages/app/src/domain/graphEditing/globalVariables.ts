import { getProjectGlobalVariableIds, type ChartNode, type NodeGraph, type Project } from '@valerypopoff/rivet2-core';

type SetGlobalNodeData = {
  id?: unknown;
  useIdInput?: unknown;
};

type GetGlobalNodeData = {
  id?: unknown;
  useIdInput?: unknown;
};

export type FixedSetGlobalIdOptions = {
  includeDisabled?: boolean;
};

export function getFixedSetGlobalId(
  node: ChartNode,
  { includeDisabled = true }: FixedSetGlobalIdOptions = {},
): string | undefined {
  if (node.type !== 'setGlobal') {
    return undefined;
  }

  if (!includeDisabled && node.disabled) {
    return undefined;
  }

  const data = node.data as SetGlobalNodeData;
  if (data.useIdInput) {
    return undefined;
  }

  return typeof data.id === 'string' && data.id.trim() ? data.id : undefined;
}

function getFixedGetGlobalId(node: ChartNode): string | undefined {
  if (node.type !== 'getGlobal') {
    return undefined;
  }

  if (node.disabled) {
    return undefined;
  }

  const data = node.data as GetGlobalNodeData;
  if (data.useIdInput) {
    return undefined;
  }

  return typeof data.id === 'string' && data.id.trim() ? data.id : undefined;
}

export function getGraphsWithLiveGraph(
  project: Pick<Project, 'graphs'> | undefined,
  liveGraph: NodeGraph | undefined,
): NodeGraph[] {
  if (!liveGraph) {
    return Object.values(project?.graphs ?? {});
  }

  const liveGraphId = liveGraph.metadata?.id;
  const projectGraphs = Object.values(project?.graphs ?? {});
  const projectGraphsWithoutLiveGraph = liveGraphId
    ? projectGraphs.filter((graph) => graph.metadata?.id !== liveGraphId)
    : projectGraphs;

  return [...projectGraphsWithoutLiveGraph, liveGraph];
}

export function getKnownGlobalVariableIds(
  project: Pick<Project, 'graphs' | 'metadata'> | undefined,
  liveGraph?: NodeGraph,
  options?: FixedSetGlobalIdOptions,
  referencedProjects?: Readonly<Record<string, Pick<Project, 'metadata'>>>,
): Set<string> {
  const ids = new Set<string>();

  for (const id of getProjectGlobalVariableIds(project)) {
    ids.add(id);
  }

  for (const referencedProject of Object.values(referencedProjects ?? {})) {
    for (const id of getProjectGlobalVariableIds(referencedProject)) {
      ids.add(id);
    }
  }

  for (const graph of getGraphsWithLiveGraph(project, liveGraph)) {
    for (const node of graph.nodes ?? []) {
      const id = getFixedSetGlobalId(node, options);
      if (id != null) {
        ids.add(id);
      }
    }
  }

  return ids;
}

export function getMissingKnownGlobalVariableWarning(
  node: ChartNode,
  knownGlobalVariableIds: ReadonlySet<string>,
): string | undefined {
  const id = getFixedGetGlobalId(node);
  if (!id || knownGlobalVariableIds.has(id)) {
    return undefined;
  }

  return `No enabled Set Global node or configured project global sets variable ID "${id}".`;
}

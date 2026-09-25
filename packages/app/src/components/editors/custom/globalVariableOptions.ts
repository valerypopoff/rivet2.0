import {
  scalarTypes,
  type GetGlobalNodeData,
  type NodeGraph,
  type Project,
  type ScalarOrArrayDataType,
} from '@valerypopoff/rivet2-core';
import {
  getFixedSetGlobalId,
  getGraphsWithLiveGraph,
  getKnownGlobalVariableIds,
} from '../../../domain/graphEditing/globalVariables.js';

export {
  getGraphsWithLiveGraph,
  getFixedSetGlobalId,
  getKnownGlobalVariableIds,
  getMissingKnownGlobalVariableWarning,
} from '../../../domain/graphEditing/globalVariables.js';

export type GlobalVariableOption = {
  label: string;
  value: string;
};

export type GlobalVariableTypeSuggestion = Omit<NonNullable<GetGlobalNodeData['typeSuggestion']>, 'id'>;

const selectableScalarTypes = new Set<string>(scalarTypes.filter((type) => type !== 'control-flow-excluded'));
const compareIds = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function isSelectableGlobalType(value: unknown): value is ScalarOrArrayDataType {
  if (typeof value !== 'string') return false;
  const scalarType = value.endsWith('[]') ? value.slice(0, -2) : value;
  return selectableScalarTypes.has(scalarType) && (value === scalarType || value === `${scalarType}[]`);
}

/** This is an editor-time suggestion, never a runtime read of the global value. */
export function getGlobalVariableTypeSuggestion(
  id: string,
  project: Pick<Project, 'graphs' | 'metadata'> | undefined,
  liveGraph?: NodeGraph,
  referencedProjects?: Readonly<Record<string, Pick<Project, 'metadata'>>>,
): GlobalVariableTypeSuggestion | undefined {
  if (!id.trim()) return undefined;

  const candidates: Array<{ type: ScalarOrArrayDataType; source: string }> = [];
  const addCandidate = (type: unknown, source: string) => {
    if (isSelectableGlobalType(type)) candidates.push({ type, source });
  };

  const projectVariable = project?.metadata.globalVariables;
  if (projectVariable && Object.hasOwn(projectVariable, id)) {
    addCandidate(projectVariable[id]?.type, 'project settings');
  }

  const graphs = getGraphsWithLiveGraph(project, liveGraph).sort((left, right) => {
    if (left === liveGraph) return -1;
    if (right === liveGraph) return 1;
    return compareIds(String(left.metadata?.id ?? ''), String(right.metadata?.id ?? ''));
  });
  for (const graph of graphs) {
    for (const node of [...(graph.nodes ?? [])].sort((left, right) => compareIds(left.id, right.id))) {
      if (getFixedSetGlobalId(node, { includeDisabled: false }) === id) {
        addCandidate((node.data as { dataType?: unknown }).dataType, `Set Global "${node.title}"`);
      }
    }
  }

  for (const [projectId, referencedProject] of Object.entries(referencedProjects ?? {}).sort(([left], [right]) =>
    compareIds(left, right),
  )) {
    const definitions = referencedProject.metadata.globalVariables;
    if (definitions && Object.hasOwn(definitions, id)) {
      addCandidate(definitions[id]?.type, `referenced project "${referencedProject.metadata.title || projectId}"`);
    }
  }

  const chosen = candidates[0];
  if (!chosen) return undefined;
  return {
    ...chosen,
    conflictingTypes: [...new Set(candidates.map((candidate) => candidate.type).filter((type) => type !== chosen.type))]
      .sort(compareIds),
  };
}

export function getGlobalVariableOptions(
  project: Pick<Project, 'graphs' | 'metadata'> | undefined,
  liveGraph?: NodeGraph,
  referencedProjects?: Readonly<Record<string, Pick<Project, 'metadata'>>>,
): GlobalVariableOption[] {
  const ids = getKnownGlobalVariableIds(project, liveGraph, { includeDisabled: false }, referencedProjects);

  return Array.from(ids)
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      label: id,
      value: id,
    }));
}

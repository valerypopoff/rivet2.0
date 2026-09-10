import type { NodeGraph, Project } from '@valerypopoff/rivet2-core';
import { getKnownGlobalVariableIds } from '../../../domain/graphEditing/globalVariables.js';

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

export function getGlobalVariableOptions(
  project: Pick<Project, 'graphs' | 'metadata'> | undefined,
  liveGraph?: NodeGraph,
  referencedProjects?: Readonly<Record<string, Pick<Project, 'metadata'>>>,
): GlobalVariableOption[] {
  const ids = getKnownGlobalVariableIds(project, liveGraph, undefined, referencedProjects);

  return Array.from(ids)
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      label: id,
      value: id,
    }));
}

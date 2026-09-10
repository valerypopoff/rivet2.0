import { atom } from 'jotai';
import { getKnownGlobalVariableIds } from '../../domain/graphEditing/globalVariables.js';
import { graphState } from '../atoms/graph.js';
import { projectState, referencedProjectsState } from '../savedGraphs.js';

export const enabledKnownGlobalVariableIdsState = atom((get) =>
  getKnownGlobalVariableIds(
    get(projectState),
    get(graphState),
    { includeDisabled: false },
    get(referencedProjectsState),
  ),
);

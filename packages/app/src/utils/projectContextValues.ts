import type { DataValue } from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import type { ProjectContext } from '../state/savedGraphs.js';
import { entries } from './typeSafety.js';

export function getProjectContextValues(projectContext: ProjectContext): Record<string, DataValue> {
  return Object.fromEntries(entries(projectContext).map(([id, contextValue]) => [id, cloneDeep(contextValue.value)]));
}

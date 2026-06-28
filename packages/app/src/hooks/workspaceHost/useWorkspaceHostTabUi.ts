import { useAtomValue, useSetAtom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { projectsState } from '../../state/savedGraphs.js';
import { projectTabUiState, updateProjectTabUiState } from '../../state/projectTabUi.js';
import { useStableCallback } from '../useStableCallback.js';
import type { RivetProjectTabUiState } from './types.js';

export function useWorkspaceHostTabUi() {
  const projects = useAtomValue(projectsState);
  const setProjectTabUiStates = useSetAtom(projectTabUiState);

  return useStableCallback(async (projectId: ProjectId, state?: RivetProjectTabUiState) => {
    if (!projects.openedProjects[projectId]) {
      return false;
    }

    setProjectTabUiStates((states) => updateProjectTabUiState(states, projectId, state));
    return true;
  });
}

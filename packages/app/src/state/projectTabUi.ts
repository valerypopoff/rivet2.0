import { atom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';

export type ProjectTabUiState = {
  preview?: boolean;
};

export const projectTabUiState = atom<Record<ProjectId, ProjectTabUiState | undefined>>({});

export function normalizeProjectTabUiState(state: ProjectTabUiState | null | undefined): ProjectTabUiState | undefined {
  return state?.preview === true ? { preview: true } : undefined;
}

export function updateProjectTabUiState(
  current: Record<ProjectId, ProjectTabUiState | undefined>,
  projectId: ProjectId,
  state: ProjectTabUiState | null | undefined,
): Record<ProjectId, ProjectTabUiState | undefined> {
  const nextState = normalizeProjectTabUiState(state);
  const currentState = current[projectId];

  if (currentState?.preview === nextState?.preview) {
    return current;
  }

  if (!nextState) {
    const next = { ...current };
    delete next[projectId];
    return next;
  }

  return {
    ...current,
    [projectId]: nextState,
  };
}

export function removeProjectTabUiState(
  current: Record<ProjectId, ProjectTabUiState | undefined>,
  projectId: ProjectId,
): Record<ProjectId, ProjectTabUiState | undefined> {
  if (!current[projectId]) {
    return current;
  }

  const next = { ...current };
  delete next[projectId];
  return next;
}

import { atom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { ProjectWorkspaceTarget } from '../domain/workspace/projectWorkspaceTarget.js';
import type { CanvasPosition } from './graphBuilder.js';

export const projectWorkspaceTargetsState = atom<Partial<Record<ProjectId, ProjectWorkspaceTarget>>>({});
export const nodeLibraryCanvasPositionsState = atom<Partial<Record<ProjectId, CanvasPosition>>>({});

export const setProjectWorkspaceTargetState = atom(
  null,
  (get, set, input: { projectId: ProjectId; target: ProjectWorkspaceTarget }) => {
    const current = get(projectWorkspaceTargetsState);
    set(projectWorkspaceTargetsState, { ...current, [input.projectId]: input.target });
  },
);

export const removeProjectWorkspaceTargetState = atom(null, (get, set, projectId: ProjectId) => {
  const current = get(projectWorkspaceTargetsState);
  if (current[projectId]) {
    const next = { ...current };
    delete next[projectId];
    set(projectWorkspaceTargetsState, next);
  }

  const canvasPositions = get(nodeLibraryCanvasPositionsState);
  if (canvasPositions[projectId]) {
    const nextCanvasPositions = { ...canvasPositions };
    delete nextCanvasPositions[projectId];
    set(nodeLibraryCanvasPositionsState, nextCanvasPositions);
  }
});

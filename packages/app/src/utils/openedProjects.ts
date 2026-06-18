import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { OpenedProjectsInfo } from '../state/savedGraphs.js';
import type { ProjectExecutorMode } from './projectExecutorMode.js';
import { sanitizeProjectExecutorMode } from './projectExecutorMode.js';

export type ProjectPathMove = {
  from: string;
  to: string;
};

export type ProjectPathMovesInput = Record<string, string> | ProjectPathMove[];

export function addOpenedProject(
  current: OpenedProjectsInfo,
  project: Project,
  options: { executorMode?: ProjectExecutorMode; fsPath?: string | null; openedGraph?: GraphId } = {},
): OpenedProjectsInfo {
  const projectId = project.metadata.id as ProjectId;
  const existingProject = current.openedProjects[projectId];
  const nextFsPath = 'fsPath' in options ? options.fsPath ?? null : existingProject?.fsPath ?? null;
  const nextOpenedGraph =
    'openedGraph' in options ? options.openedGraph : existingProject?.openedGraph ?? project.metadata.mainGraphId;
  const nextExecutorMode =
    'executorMode' in options ? sanitizeProjectExecutorMode(options.executorMode) : existingProject?.executorMode;

  return {
    openedProjects: {
      ...current.openedProjects,
      [projectId]: {
        ...existingProject,
        projectId,
        title: project.metadata.title,
        fsPath: nextFsPath,
        openedGraph: nextOpenedGraph,
        executorMode: nextExecutorMode,
      },
    },
    openedProjectsSortedIds: current.openedProjectsSortedIds.includes(projectId)
      ? current.openedProjectsSortedIds
      : [...current.openedProjectsSortedIds, projectId],
  };
}

export function resolveSyncedOpenedProjectFsPathOptions(
  current: OpenedProjectsInfo,
  projectId: ProjectId,
  loadedProjectPath: string | null | undefined,
): { fsPath?: string | null } {
  const existingProject = current.openedProjects[projectId];
  const isPathOwnedByAnotherProject = (path: string | null | undefined) =>
    path != null &&
    Object.entries(current.openedProjects).some(
      ([otherProjectId, projectInfo]) => otherProjectId !== projectId && projectInfo.fsPath === path,
    );
  const existingPathIsOwnedByAnotherProject = isPathOwnedByAnotherProject(existingProject?.fsPath);

  if (loadedProjectPath) {
    if (!isPathOwnedByAnotherProject(loadedProjectPath)) {
      return { fsPath: loadedProjectPath };
    }

    return existingPathIsOwnedByAnotherProject ? { fsPath: null } : {};
  }

  if (existingPathIsOwnedByAnotherProject) {
    return { fsPath: null };
  }

  return {};
}

export function removeOpenedProject(current: OpenedProjectsInfo, projectId: ProjectId): OpenedProjectsInfo {
  const openedProjects = { ...current.openedProjects };
  delete openedProjects[projectId];

  const openedProjectsSortedIds = current.openedProjectsSortedIds.filter(
    (id) => id !== projectId && openedProjects[id] != null,
  );

  for (const id of Object.keys(openedProjects) as ProjectId[]) {
    if (!openedProjectsSortedIds.includes(id)) {
      delete openedProjects[id];
    }
  }

  return {
    openedProjects,
    openedProjectsSortedIds,
  };
}

export function normalizeProjectPathMoves(moves: ProjectPathMovesInput): ProjectPathMove[] {
  return Array.isArray(moves)
    ? moves
    : Object.entries(moves).map(([from, to]) => ({
        from,
        to,
      }));
}

export function moveOpenedProjectPaths(current: OpenedProjectsInfo, moves: ProjectPathMovesInput): OpenedProjectsInfo {
  const normalizedMoves = normalizeProjectPathMoves(moves).filter(
    (move) => move.from && move.to && move.from !== move.to,
  );

  if (normalizedMoves.length === 0) {
    return current;
  }

  const pathsByPreviousPath = new Map(normalizedMoves.map((move) => [move.from, move.to]));
  let changed = false;

  const openedProjects = Object.fromEntries(
    Object.entries(current.openedProjects).map(([projectId, projectInfo]) => {
      const nextPath = projectInfo.fsPath ? pathsByPreviousPath.get(projectInfo.fsPath) : undefined;
      if (!nextPath) {
        return [projectId, projectInfo];
      }

      changed = true;
      return [
        projectId,
        {
          ...projectInfo,
          fsPath: nextPath,
        },
      ];
    }),
  ) as OpenedProjectsInfo['openedProjects'];

  return changed
    ? {
        ...current,
        openedProjects,
      }
    : current;
}

import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { OpenedProjectsInfo } from '../state/savedGraphs.js';
import type { ProjectMetadataPatch } from './projectMetadataUpdates.js';
import type { ProjectExecutorMode } from './projectExecutorMode.js';
import { projectExecutorModesEqual, sanitizeProjectExecutorMode } from './projectExecutorMode.js';

export type ProjectPathMove = {
  from: string;
  to: string;
};

export type ProjectPathMovesInput = Record<string, string> | ProjectPathMove[];

function isOpenedProjectPathOwnedByAnotherProject(
  current: OpenedProjectsInfo,
  projectId: ProjectId,
  path: string | null | undefined,
): boolean {
  return (
    path != null &&
    Object.entries(current.openedProjects).some(
      ([otherProjectId, projectInfo]) => otherProjectId !== projectId && projectInfo.fsPath === path,
    )
  );
}

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
  const existingPathIsOwnedByAnotherProject = isOpenedProjectPathOwnedByAnotherProject(
    current,
    projectId,
    existingProject?.fsPath,
  );

  if (loadedProjectPath) {
    if (!isOpenedProjectPathOwnedByAnotherProject(current, projectId, loadedProjectPath)) {
      return { fsPath: loadedProjectPath };
    }

    return existingPathIsOwnedByAnotherProject ? { fsPath: null } : {};
  }

  if (existingPathIsOwnedByAnotherProject) {
    return { fsPath: null };
  }

  return {};
}

/**
 * Resolve the persistence target for one opened project without ever borrowing
 * another tab's remembered path. `loadedProjectState` is global for historical
 * reasons, so it is only a fallback when no other open project owns it.
 */
export function resolveOpenedProjectSavePath(
  current: OpenedProjectsInfo,
  projectId: ProjectId,
  loadedProjectPath: string | null | undefined,
): string | null {
  const projectPath = current.openedProjects[projectId]?.fsPath;
  if (projectPath && !isOpenedProjectPathOwnedByAnotherProject(current, projectId, projectPath)) {
    return projectPath;
  }

  if (loadedProjectPath && !isOpenedProjectPathOwnedByAnotherProject(current, projectId, loadedProjectPath)) {
    return loadedProjectPath;
  }

  return null;
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

export function updateOpenedProjectExecutorMode(
  current: OpenedProjectsInfo,
  projectId: ProjectId,
  executorMode: ProjectExecutorMode,
): OpenedProjectsInfo {
  const existingProject = current.openedProjects[projectId];
  if (!existingProject) {
    return current;
  }

  const nextExecutorMode = sanitizeProjectExecutorMode(executorMode);
  if (!nextExecutorMode) {
    return current;
  }

  if (projectExecutorModesEqual(existingProject.executorMode, nextExecutorMode)) {
    return current;
  }

  return {
    ...current,
    openedProjects: {
      ...current.openedProjects,
      [projectId]: {
        ...existingProject,
        executorMode: nextExecutorMode,
      },
    },
  };
}

export function updateOpenedProjectMetadata(
  current: OpenedProjectsInfo,
  projectId: ProjectId,
  metadataPatch: ProjectMetadataPatch | null | undefined,
  options: { fsPath?: string | null } = {},
): OpenedProjectsInfo {
  const existingProject = current.openedProjects[projectId];
  if (!existingProject) {
    return current;
  }

  const nextTitle = typeof metadataPatch?.title === 'string' ? metadataPatch.title : existingProject.title;
  const nextFsPath = options.fsPath !== undefined ? options.fsPath ?? null : existingProject.fsPath;

  if (existingProject.title === nextTitle && existingProject.fsPath === nextFsPath) {
    return current;
  }

  return {
    ...current,
    openedProjects: {
      ...current.openedProjects,
      [projectId]: {
        ...existingProject,
        title: nextTitle,
        fsPath: nextFsPath,
      },
    },
  };
}

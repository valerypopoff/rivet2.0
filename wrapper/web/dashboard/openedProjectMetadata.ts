import type { Project, ProjectId } from '@valerypopoff/rivet2-core';

const PROJECT_FILE_EXTENSION = /\.rivet-project$/i;
const VIRTUAL_PROJECT_PATH_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

export type HostedProjectPathMove = {
  fromAbsolutePath: string;
  toAbsolutePath: string;
};

type OpenedProjectPathMetadata = {
  fsPath?: string | null;
};

export type HostedProjectMetadataUpdateForPathMove = {
  projectId: ProjectId;
  path: string;
  title: string;
};

function normalizeTitleCandidate(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower === 'undefined' || lower === 'null') {
    return null;
  }

  return trimmed;
}

function getFileName(path: string | null | undefined): string | null {
  const trimmedPath = path?.trim();
  if (!trimmedPath) {
    return null;
  }

  const fileName = trimmedPath.split(/[\\/]/).filter(Boolean).pop()?.trim();
  if (!fileName) {
    return null;
  }

  const withoutExtension = fileName.replace(PROJECT_FILE_EXTENSION, '').trim();
  return withoutExtension || fileName;
}

export function resolveHostedProjectTitleFromPath(fsPath?: string | null): string | null {
  return getFileName(fsPath);
}

function shouldPreferPathTitle(fsPath?: string | null): boolean {
  const trimmedPath = fsPath?.trim();
  return Boolean(trimmedPath && !VIRTUAL_PROJECT_PATH_PATTERN.test(trimmedPath));
}

export function resolveHostedProjectTitle(
  project: Pick<Project, 'metadata'> | null | undefined,
  fsPath?: string | null,
): string {
  const pathTitle = getFileName(fsPath);
  if (pathTitle && shouldPreferPathTitle(fsPath)) {
    return pathTitle;
  }

  const title = normalizeTitleCandidate(project?.metadata?.title);
  if (title) {
    return title;
  }

  return pathTitle ?? 'Untitled Project';
}

export function withHostedProjectTitle<T extends Pick<Project, 'metadata'>>(
  project: T,
  fsPath?: string | null,
): T {
  const title = resolveHostedProjectTitle(project, fsPath);

  if (project.metadata.title === title) {
    return project;
  }

  return {
    ...project,
    metadata: {
      ...project.metadata,
      title,
    },
  };
}

export function resolveHostedProjectMetadataUpdatesForPathMoves<
  T extends { openedProjects: Record<ProjectId, OpenedProjectPathMetadata> },
>(
  current: T,
  moves: HostedProjectPathMove[],
): HostedProjectMetadataUpdateForPathMove[] {
  const updatesByPath = new Map<string, { path: string; title: string }>();

  for (const move of moves) {
    if (!shouldPreferPathTitle(move.toAbsolutePath)) {
      continue;
    }

    const previousTitle = resolveHostedProjectTitleFromPath(move.fromAbsolutePath);
    const nextTitle = resolveHostedProjectTitleFromPath(move.toAbsolutePath);
    if (!nextTitle || previousTitle === nextTitle) {
      continue;
    }

    const update = { path: move.toAbsolutePath, title: nextTitle };
    updatesByPath.set(move.fromAbsolutePath, update);
    updatesByPath.set(move.toAbsolutePath, update);
  }

  return Object.entries(current.openedProjects).flatMap(([projectId, projectInfo]) => {
    const update = projectInfo.fsPath ? updatesByPath.get(projectInfo.fsPath) : undefined;
    return update ? [{ projectId: projectId as ProjectId, ...update }] : [];
  });
}

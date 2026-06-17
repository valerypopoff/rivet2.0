import stableStringify from 'safe-stable-stringify';
import type { NodeGraph, Project, ProjectId } from '@valerypopoff/rivet2-core';
import { mergeCurrentGraphIntoProject } from './workspaceTransitions.js';

export type ProjectContentForDigest = {
  project: Omit<Project, 'data'> | Project;
};

function getProjectForDirtyDigest(project: Omit<Project, 'data'> | Project): Omit<Project, 'data' | 'plugins'> {
  const { data: _data, plugins: _plugins, ...projectForDigest } = project as Project;
  return projectForDigest;
}

export function getProjectContentDigest(content: ProjectContentForDigest): string {
  return (
    stableStringify({
      project: getProjectForDirtyDigest(content.project),
    }) ?? ''
  );
}

export function buildCurrentProjectContentSnapshot(params: {
  project: Omit<Project, 'data'>;
  graph: NodeGraph;
}): ProjectContentForDigest {
  return {
    project: mergeCurrentGraphIntoProject(params.project, params.graph),
  };
}

export function markProjectClean(
  currentDigests: Record<ProjectId, string | undefined>,
  content: ProjectContentForDigest,
): Record<ProjectId, string | undefined> {
  const projectId = content.project.metadata.id;
  if (!projectId) {
    return currentDigests;
  }

  const nextDigest = getProjectContentDigest(content);
  if (currentDigests[projectId] === nextDigest) {
    return currentDigests;
  }

  return {
    ...currentDigests,
    [projectId]: nextDigest,
  };
}

export function markProjectDirtyFlag(
  currentFlags: Record<ProjectId, boolean | undefined>,
  projectId: ProjectId | undefined,
  dirty: boolean,
): Record<ProjectId, boolean | undefined> {
  if (!projectId || currentFlags[projectId] === dirty) {
    return currentFlags;
  }

  return {
    ...currentFlags,
    [projectId]: dirty,
  };
}

export function removeProjectUnsavedState<T>(
  current: Record<ProjectId, T | undefined>,
  projectId: ProjectId,
): Record<ProjectId, T | undefined> {
  if (!(projectId in current)) {
    return current;
  }

  const next = { ...current };
  delete next[projectId];
  return next;
}

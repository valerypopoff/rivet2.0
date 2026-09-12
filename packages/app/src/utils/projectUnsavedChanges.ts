import stableStringify from 'safe-stable-stringify';
import type { NodeGraph, Project, ProjectId } from '@valerypopoff/rivet2-core';
import { mergeCurrentGraphIntoProject } from './workspaceTransitions.js';

export type ProjectContentForDigest = {
  project: Omit<Project, 'data'> | Project;
};

export type ProjectContentDirtyState = {
  hasSavedDigest: boolean;
  isDirty: boolean;
  snapshot: ProjectContentForDigest;
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

export function hasProjectContentChangedFromCleanDigest(
  currentDigests: Record<ProjectId, string | undefined>,
  content: ProjectContentForDigest | undefined,
): boolean {
  const projectId = content?.project.metadata.id;
  if (!projectId || !content) {
    return false;
  }

  const savedDigest = currentDigests[projectId];
  return savedDigest != null && getProjectContentDigest(content) !== savedDigest;
}

export function buildCurrentProjectContentSnapshot(params: {
  project: Omit<Project, 'data'>;
  graph: NodeGraph;
}): ProjectContentForDigest {
  return {
    project: mergeCurrentGraphIntoProject(params.project, params.graph),
  };
}

/**
 * Resolves project-file dirtiness independently from whether the currently
 * displayed canvas is still a saved graph. Graph deletion deliberately leaves
 * an empty placeholder canvas, which must not hide the changed project from
 * the saved-content comparison.
 */
export function resolveProjectContentDirtyState(
  currentDigests: Record<ProjectId, string | undefined>,
  params: {
    graph: NodeGraph;
    project: Omit<Project, 'data'>;
  },
): ProjectContentDirtyState {
  const snapshot = buildCurrentProjectContentSnapshot(params);
  const projectId = snapshot.project.metadata.id;
  const savedDigest = projectId ? currentDigests[projectId] : undefined;

  return {
    snapshot,
    hasSavedDigest: savedDigest != null,
    isDirty: savedDigest != null && getProjectContentDigest(snapshot) !== savedDigest,
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

export function hasProjectUnsavedChanges(
  projectUnsavedChanges: Record<ProjectId, boolean | undefined>,
  projectDataUnsavedChanges: Record<ProjectId, boolean | undefined>,
  projectId: ProjectId,
): boolean {
  return projectUnsavedChanges[projectId] === true || projectDataUnsavedChanges[projectId] === true;
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

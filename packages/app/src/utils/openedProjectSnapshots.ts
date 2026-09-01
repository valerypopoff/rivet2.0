import type { NodeGraph, Project } from '@valerypopoff/rivet2-core';
import type { OpenedProjectInfo, OpenedProjectSnapshot } from '../state/savedGraphs.js';
import { mergeCurrentGraphIntoProject } from './workspaceTransitions.js';

export function buildOpenedProjectSnapshot(params: {
  project: Omit<Project, 'data'>;
  graph: NodeGraph;
  data?: Project['data'];
}): OpenedProjectSnapshot {
  return {
    project: mergeCurrentGraphIntoProject(params.project, params.graph),
    data: params.data,
  };
}

/**
 * Runtime validation for snapshots restored from browser persistence. Types only
 * protect writes from the current build; a stored value can have an older or
 * interrupted shape.
 */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isValidOpenedProjectSnapshot(
  value: unknown,
  expectedProjectId?: string,
): value is OpenedProjectSnapshot {
  if (!isObjectRecord(value) || !isObjectRecord(value.project)) {
    return false;
  }

  const { project } = value;
  if (!isObjectRecord(project.metadata) || !isObjectRecord(project.graphs)) {
    return false;
  }

  const projectId = project.metadata.id;
  return (
    typeof projectId === 'string' &&
    projectId.length > 0 &&
    (expectedProjectId == null || projectId === expectedProjectId)
  );
}

export function isOpenedProjectRecoverable(
  projectInfo: OpenedProjectInfo,
  snapshots: Record<string, unknown>,
): boolean {
  return (
    Boolean(projectInfo.fsPath) || isValidOpenedProjectSnapshot(snapshots[projectInfo.projectId], projectInfo.projectId)
  );
}

import {
  getAggregateWorkflowProjectStatus,
  type WorkflowReferenceOverview,
  type WorkflowReleaseDependencyStatus,
} from '../../studio-server-shared/workflow-types';
import type { WorkflowProjectItem, WorkflowProjectStatus } from './types';

export type WorkflowPublicationReferenceChanges = {
  changedByCaller: ReadonlyMap<string, readonly WorkflowReleaseDependencyStatus[]>;
};

export const getWorkflowReferenceProjectId = (project: WorkflowProjectItem) => project.projectMetadataId ?? project.id;

export function getWorkflowProjectEndpointStatus(
  project: WorkflowProjectItem,
  references?: WorkflowPublicationReferenceChanges | null,
): WorkflowProjectStatus {
  const { status } = project.settings;
  return status === 'published' && references?.changedByCaller.has(getWorkflowReferenceProjectId(project))
    ? 'unpublished_changes'
    : status;
}

export function getWorkflowProjectPublicationStatus(
  project: WorkflowProjectItem,
  references?: WorkflowPublicationReferenceChanges | null,
): WorkflowProjectStatus {
  const endpointStatus = getWorkflowProjectEndpointStatus(project, references);
  if (endpointStatus !== project.settings.status) return endpointStatus;
  return project.settings.publicationStatus ?? getAggregateWorkflowProjectStatus(
    endpointStatus,
    (project.settings.publishedWebApps ?? []).map((app) => app.status ?? 'published'),
  );
}

export function getWorkflowProjectDotStatus(
  project: WorkflowProjectItem,
  references?: WorkflowPublicationReferenceChanges | null,
): WorkflowProjectStatus | null {
  const status = getWorkflowProjectPublicationStatus(project, references);
  return status === 'unpublished' ? null : status;
}

export function buildWorkflowPublicationReferences(
  projects: readonly WorkflowProjectItem[],
  overview: WorkflowReferenceOverview | null | undefined,
  incomplete: boolean,
) {
  const byProject = new Map(projects.map((project) => [getWorkflowReferenceProjectId(project), project]));
  const changedByCaller = new Map<string, WorkflowReleaseDependencyStatus[]>();
  const unverifiedByCaller = new Set<string>();
  const canCaptureRelease = new Set<string>();
  const markerByProject = new Map<string, 'changed' | 'published'>();
  for (const endpoint of overview?.endpoints ?? []) {
    const owner = byProject.get(endpoint.projectId);
    if (!owner || owner.settings.status === 'unpublished') continue;
    const changed: WorkflowReleaseDependencyStatus[] = [];
    for (const dependency of endpoint.dependencies) {
      if (dependency.changed) {
        changed.push(dependency);
        markerByProject.set(dependency.projectId, 'changed');
      } else if (endpoint.coverage === 'complete' && !markerByProject.has(dependency.projectId)) {
        markerByProject.set(dependency.projectId, 'published');
      }
    }
    if (changed.length) changedByCaller.set(endpoint.projectId, changed);
    if (endpoint.coverage === 'project-only') unverifiedByCaller.add(endpoint.projectId);
    if (endpoint.canCaptureRelease) canCaptureRelease.add(endpoint.projectId);
  }
  if (incomplete) {
    const checked = new Set(overview?.endpoints.map((endpoint) => endpoint.projectId));
    for (const [id, project] of byProject) {
      if (project.settings.status !== 'unpublished' && !checked.has(id)) unverifiedByCaller.add(id);
    }
  }
  return {
    byBundle: new Map(overview?.bundles.map((row) => [row.bundleId, row])),
    markerByProject,
    changedByCaller,
    unverifiedByCaller,
    canCaptureRelease,
  };
}

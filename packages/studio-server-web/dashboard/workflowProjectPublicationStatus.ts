import {
  getAggregateWorkflowProjectStatus,
  type WorkflowReferenceOverview,
  type WorkflowReleaseDependencyStatus,
} from '../../studio-server-shared/workflow-types';
import type { WorkflowProjectItem, WorkflowProjectStatus } from './types';
import { getWorkflowProjectStatusLabel } from './projectSettingsForm';

export type WorkflowPublicationReferenceChanges = {
  changedByCaller: ReadonlyMap<string, readonly WorkflowReleaseDependencyStatus[]>;
};

export const getWorkflowReferenceProjectId = (project: WorkflowProjectItem) => project.projectMetadataId ?? project.id;

const CONTRIBUTION_STATUS_LABELS = {
  published: 'Contributes to published',
  changed: 'Contributes to unpublished changes',
} as const;

export function getWorkflowProjectContribution(
  project: WorkflowProjectItem,
  references?: { markerByProject: ReadonlyMap<string, keyof typeof CONTRIBUTION_STATUS_LABELS> } | null,
) {
  const status = references?.markerByProject.get(getWorkflowReferenceProjectId(project));
  return status ? { status, label: CONTRIBUTION_STATUS_LABELS[status] } : null;
}

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
  return (
    project.settings.publicationStatus ??
    getAggregateWorkflowProjectStatus(
      endpointStatus,
      (project.settings.publishedWebApps ?? []).map((app) => app.status ?? 'published'),
    )
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

export type WorkflowProjectSummaryStatus = {
  tone: WorkflowProjectStatus;
  text: string;
  referenceText: string | null;
  contributionOnly: boolean;
  secondaryContribution: ReturnType<typeof getWorkflowProjectContribution>;
  notice: string | null;
};

/** Describe saved changes here separately from changes in the captured dependencies. */
export function getWorkflowProjectSummaryStatus(
  project: WorkflowProjectItem,
  references?: ReturnType<typeof buildWorkflowPublicationReferences> | null,
  ownStatus: WorkflowProjectStatus = getWorkflowProjectPublicationStatus(project),
): WorkflowProjectSummaryStatus {
  const contribution = getWorkflowProjectContribution(project, references);
  const id = getWorkflowReferenceProjectId(project);
  const dependencies = references?.changedByCaller.get(id) ?? [];
  const changedCount = new Set(
    dependencies.filter((item) => item.changed && !item.unavailable).map((item) => item.projectId),
  ).size;
  const unavailableCount = new Set(dependencies.filter((item) => item.unavailable).map((item) => item.projectId)).size;
  const ownChanges = ownStatus === 'unpublished_changes';
  const contributionOnly = ownStatus === 'unpublished' && contribution !== null;
  const notices: string[] = [];
  if (references?.unverifiedByCaller.has(id)) {
    notices.push(
      references.canCaptureRelease.has(id) ? 'Update this endpoint to track dependencies' : 'Dependencies unverified',
    );
  }
  if (unavailableCount > 0 && (ownChanges || changedCount > 0)) {
    notices.push(`${unavailableCount} referenced project${unavailableCount === 1 ? ' is' : 's are'} unavailable`);
  }

  let tone = ownStatus;
  let text = getWorkflowProjectStatusLabel(ownStatus);
  let referenceText: string | null = null;
  if (contributionOnly) {
    tone = contribution.status === 'published' ? 'published' : 'unpublished_changes';
    text = contribution.label;
  } else if (ownStatus !== 'unpublished' && (ownChanges || changedCount > 0 || unavailableCount > 0)) {
    tone = 'unpublished_changes';
    if (changedCount > 0) {
      text = ownChanges ? 'Unpublished changes here and' : 'Unpublished changes';
      referenceText = `${changedCount} referenced project${changedCount === 1 ? '' : 's'}`;
    } else if (!ownChanges) {
      text = `Referenced project${unavailableCount === 1 ? '' : 's'} unavailable`;
    }
  }
  return {
    tone,
    text,
    referenceText,
    contributionOnly,
    secondaryContribution: contributionOnly ? null : contribution,
    notice: notices.join('. ') || null,
  };
}

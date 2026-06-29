import type { WorkflowProjectItem, WorkflowProjectStatus } from './types';

export const ENDPOINT_NAME_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

const WORKFLOW_PROJECT_STATUS_LABELS: Record<WorkflowProjectStatus, string> = {
  unpublished: 'Unpublished',
  published: 'Published',
  unpublished_changes: 'Unpublished changes',
};

export function getWorkflowProjectStatusLabel(status: WorkflowProjectStatus): string {
  return WORKFLOW_PROJECT_STATUS_LABELS[status];
}

export function isWorkflowProjectFullyUnpublished(project: WorkflowProjectItem): boolean {
  return project.settings.status === 'unpublished' && project.settings.publishedWebApps.length === 0;
}

export function validateEndpointName(
  endpointName: string,
  duplicateProjectFileName: string | null,
): string | null {
  const trimmedEndpointName = endpointName.trim();
  if (!trimmedEndpointName) {
    return 'Endpoint name is required to publish.';
  }

  if (!ENDPOINT_NAME_PATTERN.test(trimmedEndpointName)) {
    return 'Endpoint name must contain only letters, numbers, and hyphens.';
  }

  if (duplicateProjectFileName) {
    return `Endpoint name is already used by ${duplicateProjectFileName}.`;
  }

  return null;
}

export function formatLastPublishedAtLabel(
  status: WorkflowProjectStatus,
  lastPublishedAt: string | null | undefined,
): string | null {
  if (status === 'unpublished' || !lastPublishedAt) {
    return null;
  }

  const publishedAtDate = new Date(lastPublishedAt);
  if (Number.isNaN(publishedAtDate.getTime())) {
    return null;
  }

  return `Last published on ${new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(publishedAtDate)}`;
}

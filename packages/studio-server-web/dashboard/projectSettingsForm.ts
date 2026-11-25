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
  return project.settings.status === 'unpublished' && (project.settings.publishedWebApps?.length ?? 0) === 0;
}

export function validateEndpointName(endpointName: string, duplicateProjectFileName: string | null): string | null {
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

export function parseWebAppAllowedEmailDraft(value: string): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const rawEmail of value.split(/[\n,;]/)) {
    const email = rawEmail.trim().toLowerCase();
    if (!email || seen.has(email)) {
      continue;
    }

    seen.add(email);
    emails.push(email);
  }

  return emails;
}

export function carryEditedWebAppDrafts(
  drafts: Record<string, string>,
  previousServerValues: Record<string, string>,
  nextServerValues: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(nextServerValues).map(([id, value]) => [
      id,
      // Own keys in these string records contain a string, even with unchecked indexed access enabled.
      Object.hasOwn(previousServerValues, id) && Object.hasOwn(drafts, id) && drafts[id] !== previousServerValues[id]
        ? drafts[id]!
        : value,
    ]),
  );
}

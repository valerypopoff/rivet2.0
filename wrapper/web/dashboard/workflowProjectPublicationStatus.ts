import { getAggregateWorkflowProjectStatus } from '../../shared/workflow-types';
import type { WorkflowProjectItem, WorkflowProjectStatus } from './types';

export function getWorkflowProjectPublicationStatus(project: WorkflowProjectItem): WorkflowProjectStatus {
  return project.settings.publicationStatus ?? getAggregateWorkflowProjectStatus(
    project.settings.status,
    project.settings.publishedWebApps.length > 0 ? ['published'] : [],
  );
}

export function getWorkflowProjectDotStatus(project: WorkflowProjectItem): WorkflowProjectStatus | null {
  const status = getWorkflowProjectPublicationStatus(project);
  return status === 'unpublished' ? null : status;
}

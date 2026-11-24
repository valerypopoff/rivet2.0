import type { WorkflowProjectItem, WorkflowProjectWebAppsResponse, WorkflowPublicationPreconditions } from './types';
import { isNextPublicationVersion } from './publicationVersion';

export function publicationSnapshotFromProject(project: WorkflowProjectItem): WorkflowPublicationPreconditions {
  return {
    // Missing server tokens must never re-arm the modal after a mutation.
    expectedProjectId: project.projectMetadataId ?? '',
    expectedDraftRevisionId: project.revisionId ?? '',
    expectedPublicationVersion: project.settings.publicationVersion ?? '',
  };
}

/** Field agreement only; callers retain their path, ownership and availability guards. */
export function publicationSnapshotFieldsAgree(
  snapshot: Pick<WorkflowProjectWebAppsResponse, 'project' | 'projectId' | 'draftRevisionId' | 'publicationVersion'>,
): boolean {
  return (
    snapshot.project.projectMetadataId === snapshot.projectId &&
    snapshot.project.revisionId === snapshot.draftRevisionId &&
    snapshot.project.settings.publicationVersion === snapshot.publicationVersion
  );
}

/** A returned settings mutation must keep the project and advance exactly one publication. */
export function isNextProjectPublication(
  next: WorkflowPublicationPreconditions,
  previous: WorkflowPublicationPreconditions,
): boolean {
  return (
    next.expectedProjectId === previous.expectedProjectId &&
    !!next.expectedDraftRevisionId &&
    isNextPublicationVersion(previous.expectedPublicationVersion, next.expectedPublicationVersion)
  );
}

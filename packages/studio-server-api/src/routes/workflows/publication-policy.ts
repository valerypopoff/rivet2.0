import { randomUUID } from 'node:crypto';
import type {
  WorkflowEndpointAccess,
  WorkflowPublicationPreconditions,
  WorkflowProjectSettingsDraft,
} from '../../../../studio-server-shared/workflow-types.js';
import { conflict, badRequest, createHttpError } from '../../utils/httpError.js';
import { normalizeStoredEndpointName } from './endpoint-names.js';
import { publicationCommandPublishesDraft, type WorkflowPublicationCommandKind } from './publication-command.js';

const VERSION_PATTERN = /^(0|[1-9][0-9]*)$/;
export function normalizePublicationVersion(value: unknown): string {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) throw new Error('Invalid publication version');
  return value;
}
export function nextPublicationVersion(current: string | undefined): string {
  return (BigInt(normalizePublicationVersion(current ?? '0')) + 1n).toString();
}
export type WorkflowPublicationState = {
  projectId: string;
  publicationVersion: string;
  draftRevisionId?: string;
  endpointPublished?: boolean;
};

/** Recheck inside the adapter's atomic commit, not just during preparation. */
export function assertPublicationPreconditions(
  expected: WorkflowPublicationPreconditions,
  actual: WorkflowPublicationState,
  kind: WorkflowPublicationCommandKind,
): void {
  const publishesDraft = publicationCommandPublishesDraft(kind);
  if (
    !expected ||
    typeof expected.expectedProjectId !== 'string' ||
    !expected.expectedProjectId.trim() ||
    typeof expected.expectedPublicationVersion !== 'string' ||
    !VERSION_PATTERN.test(expected.expectedPublicationVersion) ||
    (publishesDraft &&
      (typeof expected.expectedDraftRevisionId !== 'string' || !expected.expectedDraftRevisionId.trim()))
  )
    throw createHttpError(400, 'Publication preconditions are required');
  if (expected.expectedProjectId !== actual.projectId)
    throw createHttpError(409, 'The project at this path changed. Refresh before trying again.', {
      code: 'publication_project_changed',
    });
  if (publishesDraft && expected.expectedDraftRevisionId !== actual.draftRevisionId)
    throw createHttpError(
      409,
      'Publishing failed because the project changed. Review the latest saved version before trying again.',
      { code: 'publication_draft_changed' },
    );
  if (expected.expectedPublicationVersion !== actual.publicationVersion)
    throw createHttpError(
      409,
      'Publication settings changed in another browser. Refresh and review before trying again.',
      { code: 'publication_state_changed' },
    );
  if (kind === 'set-endpoint-access' && actual.endpointPublished !== true)
    throw conflict('Publish the workflow before changing endpoint access');
}
export function normalizeEndpointSettings(value: unknown): WorkflowProjectSettingsDraft {
  const name = value && typeof value === 'object' ? (value as Record<string, unknown>).endpointName : undefined;
  return { endpointName: normalizeStoredEndpointName(typeof name === 'string' ? name : '') };
}
export function requireEndpointPublicationName(value: unknown): string {
  const { endpointName } = normalizeEndpointSettings(value);
  if (!endpointName) throw badRequest('Endpoint name is required');
  return endpointName;
}
export function assertEndpointAccess(value: unknown): asserts value is WorkflowEndpointAccess {
  if (value !== 'public' && value !== 'internal') throw badRequest('Invalid endpoint access');
}
/** Shared history identity; adapters retain their own artifact-pointer representation. */
export function createEndpointPublication(value: unknown) {
  return {
    endpointName: requireEndpointPublicationName(value),
    versionId: randomUUID(),
    publishedAt: new Date().toISOString(),
  };
}

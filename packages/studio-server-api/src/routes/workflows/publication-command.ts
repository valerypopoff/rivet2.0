import type {
  WorkflowDraftPublicationPreconditions,
  WorkflowEndpointAccess,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowPublicationPreconditions,
} from '../../../../studio-server-shared/workflow-types.js';

/** Every active-publication mutation carries the state the caller reviewed. */
export type WorkflowPublicationCommand =
  | { kind: 'publish-endpoint'; relativePath: unknown; endpointName: string; preconditions: WorkflowDraftPublicationPreconditions }
  | { kind: 'publish-web-apps'; relativePath: unknown; publications: WorkflowProjectWebAppPublicationDraft[]; preconditions: WorkflowDraftPublicationPreconditions }
  | { kind: 'restore-version'; relativePath: unknown; versionId: unknown; preconditions: WorkflowDraftPublicationPreconditions }
  | { kind: 'unpublish-endpoint'; relativePath: unknown; preconditions: WorkflowPublicationPreconditions }
  | { kind: 'set-endpoint-access'; relativePath: unknown; access: WorkflowEndpointAccess; preconditions: WorkflowPublicationPreconditions }
  | { kind: 'set-web-app-access'; relativePath: unknown; accessUpdates: WorkflowProjectWebAppAccessDraft[]; preconditions: WorkflowPublicationPreconditions }
  | { kind: 'unpublish-web-app'; relativePath: unknown; uiGraphId: unknown; preconditions: WorkflowPublicationPreconditions };

export type WorkflowPublicationCommandKind = WorkflowPublicationCommand['kind'];

export function publicationCommandPublishesDraft(kind: WorkflowPublicationCommandKind): boolean {
  switch (kind) {
    case 'publish-endpoint':
    case 'publish-web-apps':
    case 'restore-version':
      return true;
    case 'unpublish-endpoint':
    case 'set-endpoint-access':
    case 'set-web-app-access':
    case 'unpublish-web-app':
      return false;
    default: {
      const unsupportedKind: never = kind;
      throw new Error(`Unsupported publication command: ${unsupportedKind}`);
    }
  }
}

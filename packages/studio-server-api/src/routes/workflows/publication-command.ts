import type {
  WorkflowDraftPublicationPreconditions,
  WorkflowEndpointAccess,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowPublicationPreconditions,
} from '../../../../studio-server-shared/workflow-types.js';

/** Every active-publication mutation carries the state the caller reviewed. */
export type WorkflowPublicationCommand =
  | {
      kind: 'publish-endpoint';
      relativePath: string;
      endpointName: string;
      preconditions: WorkflowDraftPublicationPreconditions;
    }
  | {
      kind: 'publish-web-apps';
      relativePath: string;
      publications: WorkflowProjectWebAppPublicationDraft[];
      preconditions: WorkflowDraftPublicationPreconditions;
    }
  | {
      kind: 'restore-version';
      relativePath: string;
      versionId: string;
      preconditions: WorkflowDraftPublicationPreconditions;
    }
  | { kind: 'unpublish-endpoint'; relativePath: string; preconditions: WorkflowPublicationPreconditions }
  | {
      kind: 'set-endpoint-access';
      relativePath: string;
      access: WorkflowEndpointAccess;
      preconditions: WorkflowPublicationPreconditions;
    }
  | {
      kind: 'set-web-app-access';
      relativePath: string;
      accessUpdates: WorkflowProjectWebAppAccessDraft[];
      preconditions: WorkflowPublicationPreconditions;
    }
  | {
      kind: 'unpublish-web-app';
      relativePath: string;
      uiGraphId: string;
      preconditions: WorkflowPublicationPreconditions;
    };

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

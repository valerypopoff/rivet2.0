import { normalizeWorkflowEndpointLookupName } from '../endpoint-names.js';
import type { ManagedRevisionContents } from './types.js';

function haveMatchingManagedRevisionContents(left: ManagedRevisionContents, right: ManagedRevisionContents): boolean {
  return left.contents === right.contents && left.datasetsContents === right.datasetsContents;
}

export function resolveManagedHostedProjectSaveTarget(options: {
  nextContents: ManagedRevisionContents;
  currentDraftContents: ManagedRevisionContents;
  publishedContents: ManagedRevisionContents | null;
  draftEndpointName: string;
  publishedEndpointName: string;
}): 'current-draft' | 'published-revision' | 'create-revision' {
  const matchesPublishedRevision = options.publishedContents != null &&
    normalizeWorkflowEndpointLookupName(options.draftEndpointName) === normalizeWorkflowEndpointLookupName(options.publishedEndpointName) &&
    haveMatchingManagedRevisionContents(options.nextContents, options.publishedContents);

  if (matchesPublishedRevision) {
    return 'published-revision';
  }

  if (haveMatchingManagedRevisionContents(options.nextContents, options.currentDraftContents)) {
    return 'current-draft';
  }

  return 'create-revision';
}

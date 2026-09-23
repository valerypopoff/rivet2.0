import type {
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
} from '../../../../studio-server-shared/workflow-types.js';
import { badRequest } from '../../utils/httpError.js';
import { normalizeStoredEndpointName, normalizeWorkflowEndpointLookupName } from './endpoint-names.js';
import { normalizeEmailList } from './publication.js';

function validateAllowedEmailList(allowedEmails: readonly string[]): void {
  for (const email of allowedEmails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest(`Invalid allowed email: ${email}`);
    }
  }
}

/** Normalize the caller's edits only; each backend preserves its own stored access list when omitted. */
export function normalizeWebAppPublicationDrafts(value: unknown): WorkflowProjectWebAppPublicationDraft[] {
  if (!Array.isArray(value)) {
    throw badRequest('Web app publications must be an array');
  }

  const normalized = value.map((item) => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const allowedEmails = Object.prototype.hasOwnProperty.call(raw, 'allowedEmails')
      ? normalizeEmailList(raw.allowedEmails)
      : undefined;
    if (allowedEmails) validateAllowedEmailList(allowedEmails);
    return {
      uiGraphId: typeof raw.uiGraphId === 'string' ? raw.uiGraphId.trim() : '',
      slug: normalizeStoredEndpointName(typeof raw.slug === 'string' ? raw.slug : ''),
      allowedEmails,
    };
  });

  if (normalized.length === 0) {
    throw badRequest('At least one web app must be selected');
  }

  const seenUiGraphIds = new Set<string>();
  const seenSlugs = new Set<string>();
  for (const publication of normalized) {
    if (!publication.uiGraphId) throw badRequest('Web app selection is required');
    if (!publication.slug) throw badRequest('Web app URL slug is required');
    const slugLookup = normalizeWorkflowEndpointLookupName(publication.slug);
    if (slugLookup === 'auth') {
      throw badRequest('Web app URL slug "auth" is reserved');
    }

    if (seenUiGraphIds.has(publication.uiGraphId)) {
      throw badRequest('Each web app can only be published once per request');
    }
    if (seenSlugs.has(slugLookup)) {
      throw badRequest('Each web app URL slug must be unique');
    }
    seenUiGraphIds.add(publication.uiGraphId);
    seenSlugs.add(slugLookup);
  }

  return normalized;
}

export function normalizeWebAppAccessDrafts(value: unknown): WorkflowProjectWebAppAccessDraft[] {
  if (!Array.isArray(value)) {
    throw badRequest('Web app access updates must be an array');
  }

  const normalized = value.map((item) => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const allowedEmails = normalizeEmailList(raw.allowedEmails);
    validateAllowedEmailList(allowedEmails);
    return {
      uiGraphId: typeof raw.uiGraphId === 'string' ? raw.uiGraphId.trim() : '',
      allowedEmails,
    };
  });

  if (normalized.length === 0) {
    throw badRequest('At least one web app access update is required');
  }

  const seenUiGraphIds = new Set<string>();
  for (const access of normalized) {
    if (!access.uiGraphId) throw badRequest('Web app selection is required');
    if (seenUiGraphIds.has(access.uiGraphId)) {
      throw badRequest('Each web app access policy can only be updated once per request');
    }
    seenUiGraphIds.add(access.uiGraphId);
  }

  return normalized;
}

import fs from 'node:fs/promises';

import { loadProjectAndAttachedDataFromString } from '@valerypopoff/rivet2-node';
import type { WorkflowPublicationPreconditions } from '../../../../studio-server-shared/workflow-types.js';

import { createHttpError } from '../../utils/httpError.js';
import { getWorkflowDatasetPath } from './fs-helpers.js';
import { getFilesystemProjectRevisionId } from './project-stats.js';
import { publicationCommandPublishesDraft, type WorkflowPublicationCommandKind } from './publication-command.js';
import type { StoredWorkflowProjectSettings } from './types.js';

const VERSION_PATTERN = /^(0|[1-9][0-9]*)$/;

export function normalizePublicationVersion(value: unknown): string {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new Error('Invalid publication version');
  }
  return value;
}

export function nextPublicationVersion(current: string | undefined): string {
  return (BigInt(normalizePublicationVersion(current ?? '0')) + 1n).toString();
}

export function assertPublicationPreconditions(
  expected: WorkflowPublicationPreconditions,
  actual: { projectId: string; publicationVersion: string; draftRevisionId?: string },
  kind: WorkflowPublicationCommandKind,
): void {
  const publishesDraft = publicationCommandPublishesDraft(kind);
  // Check runtime callers as well as typed HTTP callers: an internal JavaScript
  // caller must never acquire an implicit unchecked publication path.
  if (!expected || typeof expected.expectedProjectId !== 'string' || !expected.expectedProjectId.trim() ||
    typeof expected.expectedPublicationVersion !== 'string' || !VERSION_PATTERN.test(expected.expectedPublicationVersion) ||
    (publishesDraft &&
      (typeof expected.expectedDraftRevisionId !== 'string' || !expected.expectedDraftRevisionId.trim()))) {
    throw createHttpError(400, 'Publication preconditions are required');
  }
  if (expected.expectedProjectId !== actual.projectId) {
    throw createHttpError(409, 'The project at this path changed. Refresh before trying again.', { code: 'publication_project_changed' });
  }
  if (publishesDraft && expected.expectedDraftRevisionId !== actual.draftRevisionId) {
    throw createHttpError(409, 'Publishing failed because the project changed. Review the latest saved version before trying again.', { code: 'publication_draft_changed' });
  }
  if (expected.expectedPublicationVersion !== actual.publicationVersion) {
    throw createHttpError(409, 'Publication settings changed in another browser. Refresh and review before trying again.', { code: 'publication_state_changed' });
  }
}

export async function assertFilesystemPublicationPreconditions(
  projectPath: string,
  settings: StoredWorkflowProjectSettings,
  expected: WorkflowPublicationPreconditions,
  kind: WorkflowPublicationCommandKind,
): Promise<void> {
  const actual = await readFilesystemPublicationState(projectPath, settings);
  assertPublicationPreconditions(expected, actual, kind);
}

export async function readFilesystemPublicationState(
  projectPath: string,
  settings: StoredWorkflowProjectSettings,
): Promise<{ projectId: string; publicationVersion: string; draftRevisionId: string }> {
  const contents = await fs.readFile(projectPath, 'utf8');
  const [project] = loadProjectAndAttachedDataFromString(contents);
  const datasets = await fs.readFile(getWorkflowDatasetPath(projectPath), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return {
    projectId: String(project.metadata.id ?? ''),
    publicationVersion: settings.publicationVersion ?? '0',
    draftRevisionId: getFilesystemProjectRevisionId(contents, datasets),
  };
}

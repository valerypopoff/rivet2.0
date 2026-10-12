import fs from 'node:fs/promises';

import { loadProjectAndAttachedDataFromString } from '@valerypopoff/rivet2-node';
import type { WorkflowPublicationPreconditions } from '../../../../studio-server-shared/workflow-types.js';

import { getWorkflowDatasetPath } from './fs-helpers.js';
import { getFilesystemProjectRevisionId } from './project-stats.js';
import type { WorkflowPublicationCommandKind } from './publication-command.js';
import { assertPublicationPreconditions } from './publication-policy.js';
import type { StoredWorkflowProjectSettings } from './types.js';

export {
  assertPublicationPreconditions,
  normalizePublicationVersion,
  nextPublicationVersion,
} from './publication-policy.js';

export async function assertFilesystemPublicationPreconditions(
  projectPath: string,
  settings: StoredWorkflowProjectSettings,
  expected: WorkflowPublicationPreconditions,
  kind: WorkflowPublicationCommandKind,
): Promise<void> {
  const actual = await readFilesystemPublicationState(projectPath, settings);
  assertPublicationPreconditions(
    expected,
    {
      ...actual,
      endpointPublished: Boolean(
        settings.publishedSnapshotId ||
          settings.publishedStateHash ||
          settings.legacyStatus === 'published' ||
          settings.legacyStatus === 'unpublished_changes',
      ),
    },
    kind,
  );
}

export async function readFilesystemPublicationState(
  projectPath: string,
  settings: StoredWorkflowProjectSettings,
): Promise<{ projectId: string; publicationVersion: string; draftRevisionId: string }> {
  const contents = await fs.readFile(projectPath, 'utf8');
  const [project] = loadProjectAndAttachedDataFromString(contents);
  const datasets = await fs
    .readFile(getWorkflowDatasetPath(projectPath), 'utf8')
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  return {
    projectId: String(project.metadata.id ?? ''),
    publicationVersion: settings.publicationVersion ?? '0',
    draftRevisionId: getFilesystemProjectRevisionId(contents, datasets),
  };
}

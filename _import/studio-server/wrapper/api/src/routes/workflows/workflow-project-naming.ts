import type { WorkflowProjectDownloadVersion, WorkflowProjectStatus } from '../../../../shared/workflow-types.js';

import { PROJECT_EXTENSION } from './fs-helpers.js';

export function getWorkflowProjectVersionTag(
  version: WorkflowProjectDownloadVersion,
  status: WorkflowProjectStatus,
): string {
  if (version === 'published') {
    return 'published';
  }

  switch (status) {
    case 'published':
      return 'published';
    case 'unpublished_changes':
      return 'unpublished changes';
    case 'unpublished':
    default:
      return 'unpublished';
  }
}

export function getWorkflowDuplicateProjectName(
  sourceProjectName: string,
  version: WorkflowProjectDownloadVersion,
  status: WorkflowProjectStatus,
  duplicateIndex: number,
): string {
  const duplicateBaseName = `${sourceProjectName} [${getWorkflowProjectVersionTag(version, status)}] Copy`;

  return duplicateIndex === 0
    ? duplicateBaseName
    : `${duplicateBaseName} ${duplicateIndex}`;
}

export function getWorkflowDownloadFileName(
  projectName: string,
  version: WorkflowProjectDownloadVersion,
  status: WorkflowProjectStatus,
): string {
  return `${projectName} [${getWorkflowProjectVersionTag(version, status)}]${PROJECT_EXTENSION}`;
}

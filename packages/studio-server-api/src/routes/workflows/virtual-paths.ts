import { normalizeWorkflowRelativePath } from './workflow-inputs.js';
import path from 'node:path';

import {
  MANAGED_WORKFLOW_VIRTUAL_ROOT,
  WORKFLOW_DATASET_EXTENSION,
  WORKFLOW_PROJECT_EXTENSION,
  getManagedWorkflowRelativePathFromVirtualPath,
  getManagedWorkflowVirtualDatasetPath,
  getManagedWorkflowVirtualFolderPath,
  getManagedWorkflowVirtualProjectPath,
  isManagedWorkflowVirtualPath,
} from '../../../../studio-server-shared/workflow-types.js';
import { badRequest } from '../../utils/httpError.js';

export const normalizeManagedWorkflowRelativePath = normalizeWorkflowRelativePath;

export function getManagedWorkflowVirtualRoot(): string {
  return MANAGED_WORKFLOW_VIRTUAL_ROOT;
}

export function getManagedWorkflowProjectVirtualPath(relativePath: string): string {
  return getManagedWorkflowVirtualProjectPath(relativePath);
}

export function getManagedWorkflowFolderVirtualPath(relativePath: string): string {
  return getManagedWorkflowVirtualFolderPath(relativePath);
}

export function parseManagedWorkflowProjectVirtualPath(filePath: string): string {
  const relativePath = getManagedWorkflowRelativePathFromVirtualPath(filePath);
  if (!relativePath || !relativePath.endsWith(WORKFLOW_PROJECT_EXTENSION)) {
    throw badRequest('Expected managed workflow project path');
  }

  return normalizeWorkflowRelativePath(relativePath, { allowProjectFile: true });
}

export function parseManagedWorkflowFolderVirtualPath(filePath: string): string {
  const relativePath = getManagedWorkflowRelativePathFromVirtualPath(filePath);
  if (relativePath == null) {
    throw badRequest('Expected managed workflow folder path');
  }

  return normalizeWorkflowRelativePath(relativePath, { allowProjectFile: false, allowEmpty: true });
}

export function isManagedWorkflowProjectVirtualPath(filePath: string): boolean {
  const relativePath = getManagedWorkflowRelativePathFromVirtualPath(filePath);
  return relativePath != null && relativePath.endsWith(WORKFLOW_PROJECT_EXTENSION);
}

export function isManagedWorkflowDatasetVirtualPath(filePath: string): boolean {
  const relativePath = getManagedWorkflowRelativePathFromVirtualPath(filePath);
  return relativePath != null && relativePath.endsWith(WORKFLOW_DATASET_EXTENSION);
}

export function getProjectRelativePathFromDatasetVirtualPath(filePath: string): string {
  const relativePath = getManagedWorkflowRelativePathFromVirtualPath(filePath);
  if (!relativePath || !relativePath.endsWith(WORKFLOW_DATASET_EXTENSION)) {
    throw badRequest('Expected managed workflow dataset path');
  }

  return `${relativePath.slice(0, -WORKFLOW_DATASET_EXTENSION.length)}${WORKFLOW_PROJECT_EXTENSION}`;
}

export function getManagedWorkflowDatasetVirtualPathForProject(projectVirtualPath: string): string {
  const datasetVirtualPath = getManagedWorkflowVirtualDatasetPath(projectVirtualPath);
  if (!datasetVirtualPath) {
    throw badRequest('Expected managed workflow project path');
  }

  return datasetVirtualPath;
}

export function resolveManagedWorkflowRelativeReference(currentProjectPath: string, projectFilePath: string): string {
  const currentRelativePath = parseManagedWorkflowProjectVirtualPath(currentProjectPath);
  const currentDirectory = path.posix.dirname(currentRelativePath);
  const resolvedRelativePath = path.posix.normalize(path.posix.join(currentDirectory, projectFilePath));

  return normalizeWorkflowRelativePath(resolvedRelativePath, { allowProjectFile: true });
}

export function isManagedWorkflowVirtualReference(filePath: string): boolean {
  return isManagedWorkflowVirtualPath(filePath);
}

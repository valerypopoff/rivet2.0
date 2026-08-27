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
} from '../../../../shared/workflow-types.js';
import { badRequest } from '../../utils/httpError.js';

function normalizeRelativeSegments(relativePath: string, options: { allowProjectFile: boolean; allowEmpty?: boolean }): string {
  const normalized = relativePath.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');

  if (!normalized) {
    if (options.allowEmpty) {
      return '';
    }

    throw badRequest('Missing relativePath');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw badRequest('Invalid relativePath');
  }

  if (!options.allowProjectFile && normalized.endsWith(WORKFLOW_PROJECT_EXTENSION)) {
    throw badRequest('Expected folder path, received project path');
  }

  return normalized;
}

export function normalizeManagedWorkflowRelativePath(
  relativePath: unknown,
  options: { allowProjectFile: boolean; allowEmpty?: boolean },
): string {
  if (typeof relativePath !== 'string') {
    if (options.allowEmpty && (relativePath == null || relativePath === '')) {
      return '';
    }

    throw badRequest('Missing relativePath');
  }

  return normalizeRelativeSegments(relativePath, options);
}

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

  return normalizeRelativeSegments(relativePath, { allowProjectFile: true });
}

export function parseManagedWorkflowFolderVirtualPath(filePath: string): string {
  const relativePath = getManagedWorkflowRelativePathFromVirtualPath(filePath);
  if (relativePath == null) {
    throw badRequest('Expected managed workflow folder path');
  }

  return normalizeRelativeSegments(relativePath, { allowProjectFile: false, allowEmpty: true });
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

  return normalizeRelativeSegments(resolvedRelativePath, { allowProjectFile: true });
}

export function isManagedWorkflowVirtualReference(filePath: string): boolean {
  return isManagedWorkflowVirtualPath(filePath);
}

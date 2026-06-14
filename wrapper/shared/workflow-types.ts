export type WorkflowProjectStatus = 'unpublished' | 'published' | 'unpublished_changes';
export type WorkflowProjectDownloadVersion = 'live' | 'published';

export const WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH = 240;

export const MANAGED_WORKFLOW_VIRTUAL_ROOT = '/managed/workflows';
export const WORKFLOW_PROJECT_EXTENSION = '.rivet-project';
export const WORKFLOW_DATASET_EXTENSION = '.rivet-data';
export const WORKFLOW_PUBLISHED_VERSION_PREVIEW_VIRTUAL_PROJECT_PATH_PREFIX = 'published-version-preview://';

function normalizeWorkflowVirtualRelativePath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

export function getManagedWorkflowVirtualFolderPath(relativePath = ''): string {
  const normalizedRelativePath = normalizeWorkflowVirtualRelativePath(relativePath);
  return normalizedRelativePath
    ? `${MANAGED_WORKFLOW_VIRTUAL_ROOT}/${normalizedRelativePath}`
    : MANAGED_WORKFLOW_VIRTUAL_ROOT;
}

export function getManagedWorkflowVirtualProjectPath(relativePath: string): string {
  return getManagedWorkflowVirtualFolderPath(normalizeWorkflowVirtualRelativePath(relativePath));
}

export function isManagedWorkflowVirtualPath(filePath: string): boolean {
  return filePath === MANAGED_WORKFLOW_VIRTUAL_ROOT || filePath.startsWith(`${MANAGED_WORKFLOW_VIRTUAL_ROOT}/`);
}

export function getManagedWorkflowRelativePathFromVirtualPath(filePath: string): string | null {
  if (!isManagedWorkflowVirtualPath(filePath)) {
    return null;
  }

  const relativePath = filePath.slice(MANAGED_WORKFLOW_VIRTUAL_ROOT.length).replace(/^\/+/, '');
  return normalizeWorkflowVirtualRelativePath(relativePath);
}

export function getManagedWorkflowVirtualDatasetPath(projectVirtualPath: string): string | null {
  if (!projectVirtualPath.endsWith(WORKFLOW_PROJECT_EXTENSION)) {
    return null;
  }

  return `${projectVirtualPath.slice(0, -WORKFLOW_PROJECT_EXTENSION.length)}${WORKFLOW_DATASET_EXTENSION}`;
}

export type WorkflowPublishedVersionPreviewReference = {
  relativePath: string;
  versionId: string;
};

export function getWorkflowPublishedVersionPreviewVirtualProjectPath(
  relativePath: string,
  versionId: string,
): string {
  return [
    WORKFLOW_PUBLISHED_VERSION_PREVIEW_VIRTUAL_PROJECT_PATH_PREFIX,
    encodeURIComponent(normalizeWorkflowVirtualRelativePath(relativePath)),
    '/',
    encodeURIComponent(versionId),
    '/preview',
    WORKFLOW_PROJECT_EXTENSION,
  ].join('');
}

export function getWorkflowPublishedVersionPreviewFromVirtualProjectPath(
  filePath: string,
): WorkflowPublishedVersionPreviewReference | null {
  if (!filePath.startsWith(WORKFLOW_PUBLISHED_VERSION_PREVIEW_VIRTUAL_PROJECT_PATH_PREFIX)) {
    return null;
  }

  const remainder = filePath.slice(WORKFLOW_PUBLISHED_VERSION_PREVIEW_VIRTUAL_PROJECT_PATH_PREFIX.length);
  const suffix = `/preview${WORKFLOW_PROJECT_EXTENSION}`;
  if (!remainder.endsWith(suffix)) {
    return null;
  }

  const encodedReference = remainder.slice(0, -suffix.length);
  const slashIndex = encodedReference.lastIndexOf('/');
  if (slashIndex <= 0 || slashIndex === encodedReference.length - 1) {
    return null;
  }

  try {
    const relativePath = normalizeWorkflowVirtualRelativePath(
      decodeURIComponent(encodedReference.slice(0, slashIndex)),
    );
    const versionId = decodeURIComponent(encodedReference.slice(slashIndex + 1)).trim();
    if (!relativePath || !versionId) {
      return null;
    }

    return { relativePath, versionId };
  } catch {
    return null;
  }
}

export type WorkflowProjectSettings = {
  status: WorkflowProjectStatus;
  endpointName: string;
  lastPublishedAt: string | null;
};

export type WorkflowProjectSettingsDraft = {
  endpointName: string;
};

export type WorkflowProjectStats = {
  graphCount: number;
  totalNodeCount: number;
};

export type WorkflowProjectItem = {
  id: string;
  name: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  settings: WorkflowProjectSettings;
  stats?: WorkflowProjectStats;
};

export type WorkflowProjectDeleteResponse = {
  deleted: true;
  projectId: string | null;
};

export type WorkflowFolderItem = {
  id: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  folders: WorkflowFolderItem[];
  projects: WorkflowProjectItem[];
};

export type WorkflowProjectPathMove = {
  fromAbsolutePath: string;
  toAbsolutePath: string;
};

export type WorkflowPublishedVersionSummary = {
  id: string;
  projectId: string;
  projectName: string;
  endpointName: string;
  publishedAt: string;
  isCurrent: boolean;
  isStarred: boolean;
  comment: string;
};

export type WorkflowPublishedVersionsResponse = {
  versions: WorkflowPublishedVersionSummary[];
};

export type WorkflowPublishedVersionStarResponse = {
  version: WorkflowPublishedVersionSummary;
};

export type WorkflowPublishedVersionCommentResponse = {
  version: WorkflowPublishedVersionSummary;
};

export type WorkflowPublishedVersionRestoreResponse = {
  project: WorkflowProjectItem;
  version: WorkflowPublishedVersionSummary;
};

export type WorkflowPublishedVersionPreviewResponse = {
  contents: string;
  datasetsContents: string | null;
};

import type { WorkflowReferenceIncompleteReason } from './workflow-reference-diagnostics.js';

export type WorkflowProjectStatus = 'unpublished' | 'published' | 'unpublished_changes';
export type WorkflowEndpointAccess = 'public' | 'internal';
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
  ownerId?: string;
  artifactId?: string;
  sessionId?: string;
};

export function getWorkflowPublishedVersionPreviewVirtualProjectPath(
  relativePath: string, versionId: string,
  scope?: { ownerId: string; artifactId: string; sessionId: string },
): string {
  return [
    WORKFLOW_PUBLISHED_VERSION_PREVIEW_VIRTUAL_PROJECT_PATH_PREFIX,
    encodeURIComponent(normalizeWorkflowVirtualRelativePath(relativePath)),
    '/',
    encodeURIComponent(versionId),
    ...(scope ? ['/', encodeURIComponent(scope.ownerId), '/', encodeURIComponent(scope.artifactId), '/', encodeURIComponent(scope.sessionId)] : []),
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
  const parts = encodedReference.split('/');
  if ((parts.length !== 2 && parts.length !== 5) || parts.some((part) => !part)) return null;

  try {
    const [path, version, ownerId, artifactId, sessionId] = parts.map(decodeURIComponent);
    const relativePath = normalizeWorkflowVirtualRelativePath(path!);
    const versionId = version!.trim();
    if (!relativePath || !versionId) {
      return null;
    }

    return { relativePath, versionId, ...(sessionId && ownerId && artifactId ? { ownerId, artifactId, sessionId } : {}) };
  } catch {
    return null;
  }
}

export type WorkflowProjectSettings = {
  /** Endpoint-only publication state; web-app publications do not affect it. */
  status: WorkflowProjectStatus;
  /** Combined endpoint/web-app state for the project tree and overall badges. */
  publicationStatus?: WorkflowProjectStatus;
  endpointName: string;
  publishedEndpointName?: string;
  endpointAccess?: WorkflowEndpointAccess;
  lastPublishedAt: string | null;
  publishedWebApps: WorkflowPublishedWebAppSummary[];
  /** Opaque, project-scoped version of active publication settings. */
  publicationVersion?: string;
};

export type WorkflowPublicationPreconditions = {
  expectedProjectId: string;
  expectedPublicationVersion: string;
  /** Required only for commands that publish or replace executable draft content. */
  expectedDraftRevisionId?: string;
};

export type WorkflowDraftPublicationPreconditions = WorkflowPublicationPreconditions & {
  expectedDraftRevisionId: string;
};

export type WorkflowEndpointReleaseReview = {
  token: string;
  projects: Array<WorkflowReleaseProject & { fromDraft: boolean }>;
  missingRollback: boolean;
};

export type WorkflowProjectSettingsDraft = {
  endpointName: string;
  releaseReviewToken?: string;
  acknowledgeMissingRollback?: boolean;
};

export type WorkflowPublishedWebAppSummary = {
  uiGraphId: string;
  uiGraphName: string;
  slug: string;
  publishedAt: string;
  allowedEmails: string[];
  /**
   * Freshness of this specific publication. Optional for compatibility with
   * older Studio Server tree responses.
   */
  status?: WorkflowProjectStatus;
};

export type WorkflowProjectWebAppSummary = {
  uiGraphId: string;
  name: string;
  publishedSlug: string | null;
  publishedAt: string | null;
  status: WorkflowProjectStatus;
  isMissingFromProject: boolean;
  allowedEmails: string[];
};

export type WorkflowProjectWebAppsResponse = {
  /** Endpoint settings and publication tokens from the same read as webApps. */
  project: WorkflowProjectItem;
  projectId: string;
  draftRevisionId: string;
  publicationVersion: string;
  hasMainGraph: boolean;
  /** Project IDs whose saved-latest graphs can change a published caller without republishing it. */
  savedLatestSubgraphProjectIds?: string[];
  webApps: WorkflowProjectWebAppSummary[];
};

export type WorkflowProjectReferenceSource = {
  kind: 'saved-latest' | 'published-endpoint' | 'published-web-app';
  /** Endpoint name or web-app slug, not an absolute storage path. */
  label?: string;
};

export type WorkflowProjectIncomingReference = {
  projectId: string;
  name: string;
  relativePath: string;
  sources: Array<
    WorkflowProjectReferenceSource & {
      targetVersions: Array<'latest' | 'published' | 'project-reference'>;
    }
  >;
};

export type WorkflowProjectReferencesResponse = {
  projectId: string;
  references: WorkflowProjectIncomingReference[];
  checkedProjects: number;
  totalProjects: number;
  complete: boolean;
  changedDuringScan: boolean;
  unreadableProjects: Array<{ name: string; relativePath: string }>;
  /** Present only for graph-filtered requests; project-level callers retain their contract. */
  graphReferences?: Array<{
    sourceGraphId: string;
    sourceGraphName: string;
    nodeId: string;
    nodeTitle: string;
    targetProjectId: string;
    targetGraphId: string;
    targetVersion: 'latest' | 'published' | 'project-reference';
    projectId: string;
    projectName: string;
    relativePath: string;
    source: WorkflowProjectReferenceSource;
  }>;
  graphReferencesTruncated?: boolean;
  /** Optional on older/legacy servers. Coverage is as of one committed database snapshot. */
  incompleteReasons?: WorkflowReferenceIncompleteReason[];
};

export const WORKFLOW_ENDPOINT_MAIN_GRAPH_REQUIRED_MESSAGE = 'Choose a Main Graph before publishing this endpoint.';

export type WorkflowProjectWebAppPublicationDraft = {
  uiGraphId: string;
  slug: string;
  allowedEmails?: string[];
};

export type WorkflowProjectWebAppAccessDraft = {
  uiGraphId: string;
  allowedEmails: string[];
};

export type WorkflowProjectStats = {
  graphCount: number;
  totalNodeCount: number;
  webAppCount: number;
};

export type WorkflowProjectItem = {
  /** Managed authoring mutations must carry the selected immutable identity. */
  namespaceProtocol?: 1;
  id: string;
  /** Explicit Studio Server container membership, never inferred from references. */
  bundleId?: string | null;
  /** Immutable Rivet project metadata id used by runtime-scoped services. */
  projectMetadataId?: string;
  /** Opaque current content revision used for optimistic hosted saves. */
  revisionId?: string | null;
  name: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  settings: WorkflowProjectSettings;
  stats?: WorkflowProjectStats;
};

export function getAggregateWorkflowProjectStatus(
  endpointStatus: WorkflowProjectStatus,
  webAppStatuses: readonly WorkflowProjectStatus[] = [],
): WorkflowProjectStatus {
  const statuses = [endpointStatus, ...webAppStatuses];

  if (statuses.includes('unpublished_changes')) {
    return 'unpublished_changes';
  }

  if (statuses.includes('published')) {
    return 'published';
  }

  return 'unpublished';
}

export type WorkflowProjectDeleteResponse = {
  deleted: true;
  projectId: string | null;
};

export type WorkflowFolderItem = {
  id: string;
  /** Immutable managed-folder identity; UI id remains the path for compatibility. */
  namespaceId?: string;
  /** Stable bundle identity on a bundle root; null for ordinary folders. */
  bundleId?: string | null;
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

/**
 * The authoritative location, title, and content revision for an editable workflow project.
 * Dashboard/editor reconciliation matches this stable project id rather than
 * trusting an old filename or folder path.
 */
export type WorkflowProjectEditorBinding = {
  projectId: string;
  bundleId?: string | null;
  path: string;
  title: string;
  /** Optional only while an older server is rolling out; current servers always provide it. */
  revisionId?: string | null;
};

/**
 * A lightweight, API-instance-scoped token for the hosted workflow tree.
 *
 * The token is deliberately not persisted. It lets dashboard clients detect a
 * tree mutation or an API restart and then reload the normal authoritative
 * tree response instead of receiving project metadata over a live stream.
 */
export type WorkflowTreeSyncState = {
  epoch: string;
  revision: number;
};

export type WorkflowTreeChangeEvent = WorkflowTreeSyncState & {
  sourceClientId: string | null;
};

export const WORKFLOW_TREE_CLIENT_ID_HEADER = 'x-rivet-workflow-tree-client';

export type WorkflowTreeResponse = {
  root: string;
  capabilities?: {
    explicitBundles: boolean;
    namespaceMutations?: boolean;
    bundleMerge?: boolean;
    bundleCompare?: boolean;
  };
  folders: WorkflowFolderItem[];
  projects: WorkflowProjectItem[];
  sync: WorkflowTreeSyncState;
};

export type WorkflowReleaseSelector = 'latest' | 'published' | 'project-reference';

export function getWorkflowReleaseSelectorLabel(selector: WorkflowReleaseSelector): string {
  if (selector === 'latest') return 'Saved latest';
  if (selector === 'published') return 'Published';
  return 'Project reference';
}

export type WorkflowReleaseProject = {
  artifactId: string;
  projectId: string;
  name: string;
  relativePath: string;
  bundleRelativePath?: string;
  savedAt: string;
};

export type WorkflowReleaseReference = {
  sourceArtifactId: string;
  sourceGraphId: string;
  nodeId: string;
  targetArtifactId: string;
  targetGraphId: string;
  selector: WorkflowReleaseSelector;
};

export type WorkflowReleaseDependencyStatus = {
  projectId: string;
  name: string;
  relativePath: string | null;
  changed: boolean;
  unavailable: boolean;
  revisions?: Array<{
    selector: WorkflowReleaseSelector;
    activeRevisionId: string;
    savedRevisionId: string | null;
  }>;
};

export type WorkflowReferenceOverview = {
  endpoints: Array<{
    projectId: string;
    coverage: 'complete' | 'project-only';
    canCaptureRelease?: boolean;
    dependencies: WorkflowReleaseDependencyStatus[];
  }>;
  bundles: Array<{ bundleId: string; count: number; complete: boolean }>;
  complete: boolean;
};

export type WorkflowBundleReferenceDetails = {
  complete: boolean;
  projects: Array<{
    projectId: string;
    name: string;
    relativePath: string | null;
    uses: Array<{
      sourcePath: string;
      sourceName: string;
      sourceGraphName?: string;
      nodeTitle?: string;
      targetGraphId?: string;
      selector: WorkflowReleaseSelector;
      savedAt: string;
    }>;
  }>;
};

export type WorkflowHistoryPreview = {
  rootArtifactId: string;
  endpointName: string;
  publishedAt: string;
  coverage: 'frozen' | 'project-only';
  capturedAt?: string;
  projects: WorkflowReleaseProject[];
  references: WorkflowReleaseReference[];
};

export type WorkflowPublishedVersionSummary = {
  id: string;
  projectId: string;
  projectName: string;
  endpointName: string;
  publishedAt: string;
  isCurrent: boolean;
  coverage?: 'frozen' | 'project-only';
  restoredFrom?: string;
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

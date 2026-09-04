import {
  applyHostedRuntimeConfig,
  normalizeHostedRuntimeConfig,
  RIVET_API_BASE_URL,
} from '../../studio-server-shared/hosted-env';
import {
  WORKFLOW_TREE_CLIENT_ID_HEADER,
  type WorkflowTreeChangeEvent,
  type WorkflowTreeSyncState,
} from '../../studio-server-shared/workflow-types';
import type {
  WorkflowFolderItem,
  WorkflowProjectDeleteResponse,
  WorkflowProjectDownloadVersion,
  WorkflowMoveResponse,
  WorkflowProjectItem,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppsResponse,
  WorkflowProjectSettingsDraft,
  HostedRouteConfig,
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRunStatisticsCatalogResponse,
  WorkflowRunStatisticsPeriod,
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsSurface,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionCommentResponse,
  WorkflowPublishedVersionStarResponse,
  WorkflowPublishedVersionPreviewResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
  WorkflowTreeResponse,
} from './types';
import { createResponseError, parseJsonResponse, parseTextResponse } from './apiRequest';

const API = RIVET_API_BASE_URL;
const WORKFLOW_TREE_CLIENT_ID_SESSION_KEY = 'rivet.workflow-tree-client-id.v1';
let workflowTreeClientId: string | null = null;

function createWorkflowTreeClientId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return randomUuid ?? `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getWorkflowTreeClientId(): string {
  if (workflowTreeClientId) {
    return workflowTreeClientId;
  }

  try {
    const stored = window.sessionStorage.getItem(WORKFLOW_TREE_CLIENT_ID_SESSION_KEY);
    if (stored && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(stored)) {
      workflowTreeClientId = stored;
      return workflowTreeClientId;
    }
  } catch {
    // Session storage is unavailable in some private browser contexts. The
    // in-memory fallback still preserves one ID within this bundle instance.
  }

  workflowTreeClientId = createWorkflowTreeClientId();
  try {
    window.sessionStorage.setItem(WORKFLOW_TREE_CLIENT_ID_SESSION_KEY, workflowTreeClientId);
  } catch {
    // Keep the generated in-memory id when persistence is unavailable.
  }
  return workflowTreeClientId;
}

export function getWorkflowTreeMutationHeaders(): Record<string, string> {
  return {
    [WORKFLOW_TREE_CLIENT_ID_HEADER]: getWorkflowTreeClientId(),
  };
}

const workflowJsonResponse = <T,>(response: Response) => parseJsonResponse<T>(response, {
  nonJsonErrorMessage:
    'Workflow API returned HTML instead of JSON. Make sure you are accessing the app through the proxy and that /api/workflows is routed to the API service.',
});

const hostedProjectJsonResponse = <T,>(response: Response) => parseJsonResponse<T>(response, {
  nonJsonErrorMessage:
    'Project API returned HTML instead of JSON. Make sure you are accessing the app through the proxy and that /api/projects is routed to the API service.',
});

const hostedConfigJsonResponse = <T,>(response: Response) => parseJsonResponse<T>(response, {
  nonJsonErrorMessage:
    'Config API returned HTML instead of JSON. Make sure you are accessing the app through the proxy and that /api/config is routed to the API service.',
});

async function parseBlobResponse(response: Response): Promise<{ blob: Blob; fileName: string | null }> {
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => ({ error: response.statusText }));
      throw createResponseError(response.status, data.error || response.statusText);
    }

    throw createResponseError(response.status, response.statusText);
  }

  if (contentType.includes('text/html')) {
    throw new Error(
      'Workflow download returned HTML instead of a project file. Make sure you are accessing the app through the proxy and that /api/workflows is routed to the API service.',
    );
  }

  return {
    blob: await response.blob(),
    fileName: getContentDispositionFileName(response.headers.get('content-disposition')),
  };
}

function decodeContentDispositionValue(value: string): string {
  if (value.startsWith("UTF-8''")) {
    return decodeURIComponent(value.slice("UTF-8''".length));
  }

  return value;
}

function getContentDispositionFileName(contentDisposition: string | null): string | null {
  if (!contentDisposition) {
    return null;
  }

  const utf8Match = contentDisposition.match(/filename\*=([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeContentDispositionValue(utf8Match[1].trim());
  }

  const asciiMatch = contentDisposition.match(/filename="([^"]+)"/i);
  if (asciiMatch?.[1]) {
    return asciiMatch[1];
  }

  return null;
}

function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function fetchWorkflowTree(): Promise<WorkflowTreeResponse> {
  const response = await fetch(`${API}/workflows/tree`, {
    cache: 'no-store',
  });
  return workflowJsonResponse<WorkflowTreeResponse>(response);
}

function parseWorkflowTreeSyncEvent(event: MessageEvent<string>): WorkflowTreeSyncState | WorkflowTreeChangeEvent | null {
  try {
    const parsed = JSON.parse(event.data) as Partial<WorkflowTreeChangeEvent>;
    if (typeof parsed.epoch !== 'string' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0) {
      return null;
    }
    if ('sourceClientId' in parsed && parsed.sourceClientId !== null && typeof parsed.sourceClientId !== 'string') {
      return null;
    }
    return parsed as WorkflowTreeSyncState | WorkflowTreeChangeEvent;
  } catch {
    return null;
  }
}

export function openWorkflowTreeEventStream(options: {
  onState: (state: WorkflowTreeSyncState) => void;
  onChange: (event: WorkflowTreeChangeEvent) => void;
}): EventSource | null {
  if (typeof EventSource === 'undefined') {
    return null;
  }

  const source = new EventSource(`${API}/workflows/tree/events`);
  source.addEventListener('tree-state', (event) => {
    const state = parseWorkflowTreeSyncEvent(event as MessageEvent<string>);
    if (state && !('sourceClientId' in state)) {
      options.onState(state);
    }
  });
  source.addEventListener('tree-changed', (event) => {
    const change = parseWorkflowTreeSyncEvent(event as MessageEvent<string>);
    if (change && 'sourceClientId' in change) {
      options.onChange(change);
    }
  });
  return source;
}

export async function fetchHostedConfig(): Promise<Partial<HostedRouteConfig>> {
  const response = await fetch(`${API}/config`, {
    cache: 'no-store',
  });
  const config = await hostedConfigJsonResponse<Partial<HostedRouteConfig>>(response);
  const normalizedConfig = normalizeHostedRuntimeConfig(config) as Partial<HostedRouteConfig>;
  applyHostedRuntimeConfig(normalizedConfig);
  return normalizedConfig;
}

export async function fetchWorkflowRecordingWorkflows(options: { signal?: AbortSignal } = {}): Promise<WorkflowRecordingWorkflowListResponse> {
  const response = await fetch(`${API}/workflows/recordings/workflows`, {
    cache: 'no-store',
    signal: options.signal,
  });
  return workflowJsonResponse<WorkflowRecordingWorkflowListResponse>(response);
}

export async function fetchWorkflowRecordingRuns(
  workflowId: string,
  options: {
    page: number;
    pageSize: number;
    status: WorkflowRecordingFilterStatus;
    inputFilter?: WorkflowRecordingInputFilter | null;
    inputCursor?: number;
    signal?: AbortSignal;
  },
): Promise<WorkflowRecordingRunsPageResponse> {
  const query = new URLSearchParams({
    page: String(options.page),
    pageSize: String(options.pageSize),
    status: options.status,
  });
  if (options.inputFilter) {
    query.set('inputPath', options.inputFilter.path);
    query.set('inputOperator', options.inputFilter.operator);
    query.set('inputValue', options.inputFilter.value);
    if (options.inputCursor != null) {
      query.set('inputCursor', String(options.inputCursor));
    }
  }
  const response = await fetch(`${API}/workflows/recordings/workflows/${encodeURIComponent(workflowId)}/runs?${query}`, {
    cache: 'no-store',
    signal: options.signal,
  });
  return workflowJsonResponse<WorkflowRecordingRunsPageResponse>(response);
}

export async function fetchWorkflowRunStatisticsCatalog(
  surface: WorkflowRunStatisticsSurface,
  options: { signal?: AbortSignal } = {},
): Promise<WorkflowRunStatisticsCatalogResponse> {
  const query = new URLSearchParams({ surface });
  const response = await fetch(`${API}/workflows/run-statistics/targets?${query}`, {
    cache: 'no-store',
    signal: options.signal,
  });
  return workflowJsonResponse<WorkflowRunStatisticsCatalogResponse>(response);
}

export async function fetchWorkflowRunStatistics(
  query: WorkflowRunStatisticsQuery,
  options: { signal?: AbortSignal } = {},
): Promise<WorkflowRunStatisticsResponse> {
  const response = await fetch(`${API}/workflows/run-statistics/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(query),
    cache: 'no-store',
    signal: options.signal,
  });
  return workflowJsonResponse<WorkflowRunStatisticsResponse>(response);
}

export async function fetchWorkflowRecordingArtifactText(
  recordingId: string,
  artifact: 'recording' | 'replay-project' | 'replay-dataset',
): Promise<string> {
  const response = await fetch(`${API}/workflows/recordings/${encodeURIComponent(recordingId)}/${artifact}`, {
    cache: 'no-store',
  });
  return parseTextResponse(response);
}

export async function fetchHostedProjectFile(path: string): Promise<{ contents: string }> {
  const response = await fetch(`${API}/projects/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });

  const data = await hostedProjectJsonResponse<{
    contents: string;
    datasetsContents?: string | null;
    revisionId?: string | null;
  }>(response);

  return {
    contents: data.contents,
  };
}

export async function deleteWorkflowRecording(recordingId: string): Promise<void> {
  const response = await fetch(`${API}/workflows/recordings/${encodeURIComponent(recordingId)}`, {
    method: 'DELETE',
  });
  await workflowJsonResponse<{ deleted: true }>(response);
}

export async function createWorkflowFolder(name: string): Promise<WorkflowFolderItem> {
  const response = await fetch(`${API}/workflows/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ name }),
  });

  const data = await workflowJsonResponse<{ folder: WorkflowFolderItem }>(response);
  return data.folder;
}

export async function renameWorkflowFolder(
  relativePath: string,
  newName: string,
): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowMoveResponse['movedProjectPaths'] }> {
  const response = await fetch(`${API}/workflows/folders`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ relativePath, newName }),
  });

  return workflowJsonResponse<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowMoveResponse['movedProjectPaths'] }>(
    response,
  );
}

export async function deleteWorkflowFolder(relativePath: string): Promise<void> {
  const response = await fetch(`${API}/workflows/folders`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ relativePath }),
  });

  await workflowJsonResponse<{ deleted: true }>(response);
}

export async function createWorkflowProject(
  folderRelativePath: string,
  name: string,
): Promise<WorkflowProjectItem> {
  const response = await fetch(`${API}/workflows/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ folderRelativePath, name }),
  });

  const data = await workflowJsonResponse<{ project: WorkflowProjectItem }>(response);
  return data.project;
}

export async function uploadWorkflowProject(
  folderRelativePath: string,
  fileName: string,
  contents: string,
): Promise<WorkflowProjectItem> {
  const response = await fetch(`${API}/workflows/projects/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ folderRelativePath, fileName, contents }),
  });

  const data = await workflowJsonResponse<{ project: WorkflowProjectItem }>(response);
  return data.project;
}

export async function renameWorkflowProject(
  relativePath: string,
  newName: string,
): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowMoveResponse['movedProjectPaths'] }> {
  const response = await fetch(`${API}/workflows/projects`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ relativePath, newName }),
  });

  return workflowJsonResponse<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowMoveResponse['movedProjectPaths'] }>(response);
}

export async function duplicateWorkflowProjectVersion(
  relativePath: string,
  version: WorkflowProjectDownloadVersion,
): Promise<WorkflowProjectItem> {
  const response = await fetch(`${API}/workflows/projects/duplicate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ relativePath, version }),
  });

  const data = await workflowJsonResponse<{ project: WorkflowProjectItem }>(response);
  return data.project;
}

export async function downloadWorkflowProject(
  relativePath: string,
  version: WorkflowProjectDownloadVersion,
): Promise<void> {
  const response = await fetch(`${API}/workflows/projects/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, version }),
  });

  const { blob, fileName } = await parseBlobResponse(response);
  triggerBrowserDownload(blob, fileName ?? 'project.rivet-project');
}

export async function fetchWorkflowPublishedVersions(relativePath: string): Promise<WorkflowPublishedVersionsResponse> {
  const query = new URLSearchParams({ relativePath });
  const response = await fetch(`${API}/workflows/projects/published-versions?${query}`, {
    cache: 'no-store',
  });
  return workflowJsonResponse<WorkflowPublishedVersionsResponse>(response);
}

export async function downloadWorkflowPublishedVersion(
  relativePath: string,
  versionId: string,
): Promise<void> {
  const response = await fetch(`${API}/workflows/projects/published-versions/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, versionId }),
  });

  const { blob, fileName } = await parseBlobResponse(response);
  triggerBrowserDownload(blob, fileName ?? 'published-version.rivet-project');
}

export async function fetchWorkflowPublishedVersionPreview(
  relativePath: string,
  versionId: string,
): Promise<WorkflowPublishedVersionPreviewResponse> {
  const response = await fetch(`${API}/workflows/projects/published-versions/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, versionId }),
  });

  return workflowJsonResponse<WorkflowPublishedVersionPreviewResponse>(response);
}

export async function fetchCurrentWorkflowPublishedVersion(
  relativePath: string,
): Promise<WorkflowPublishedVersionSummary> {
  const { versions } = await fetchWorkflowPublishedVersions(relativePath);
  const currentVersion = versions.find((version) => version.isCurrent);

  if (!currentVersion) {
    throw new Error('No current published version was found for this project.');
  }

  return currentVersion;
}

export async function setWorkflowPublishedVersionStar(
  relativePath: string,
  versionId: string,
  isStarred: boolean,
): Promise<WorkflowPublishedVersionStarResponse> {
  const response = await fetch(`${API}/workflows/projects/published-versions/star`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, versionId, isStarred }),
  });

  return workflowJsonResponse<WorkflowPublishedVersionStarResponse>(response);
}

export async function setWorkflowPublishedVersionComment(
  relativePath: string,
  versionId: string,
  comment: string,
): Promise<WorkflowPublishedVersionCommentResponse> {
  const response = await fetch(`${API}/workflows/projects/published-versions/comment`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, versionId, comment }),
  });

  return workflowJsonResponse<WorkflowPublishedVersionCommentResponse>(response);
}

export async function restoreWorkflowPublishedVersion(
  relativePath: string,
  versionId: string,
): Promise<WorkflowPublishedVersionRestoreResponse> {
  const response = await fetch(`${API}/workflows/projects/published-versions/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ relativePath, versionId }),
  });

  return workflowJsonResponse<WorkflowPublishedVersionRestoreResponse>(response);
}

export async function fetchWorkflowProjectWebApps(relativePath: string): Promise<WorkflowProjectWebAppsResponse> {
  const query = new URLSearchParams({ relativePath });
  const response = await fetch(`${API}/workflows/projects/web-apps?${query}`, {
    cache: 'no-store',
  });
  return workflowJsonResponse<WorkflowProjectWebAppsResponse>(response);
}

export async function publishWorkflowProjectWebApps(
  relativePath: string,
  publications: WorkflowProjectWebAppPublicationDraft[],
): Promise<WorkflowProjectItem> {
  const response = await fetch(`${API}/workflows/projects/web-apps/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ relativePath, publications }),
  });

  const data = await workflowJsonResponse<{ project: WorkflowProjectItem }>(response);
  return data.project;
}

export async function updateWorkflowProjectWebAppAccess(
  relativePath: string,
  accessUpdates: WorkflowProjectWebAppAccessDraft[],
): Promise<WorkflowProjectItem> {
  const response = await fetch(`${API}/workflows/projects/web-apps/access`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ relativePath, accessUpdates }),
  });

  const data = await workflowJsonResponse<{ project: WorkflowProjectItem }>(response);
  return data.project;
}

export async function unpublishWorkflowProjectWebApp(
  relativePath: string,
  uiGraphId: string,
): Promise<WorkflowProjectItem> {
  const response = await fetch(`${API}/workflows/projects/web-apps/unpublish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ relativePath, uiGraphId }),
  });

  const data = await workflowJsonResponse<{ project: WorkflowProjectItem }>(response);
  return data.project;
}

export async function moveWorkflowItem(
  itemType: 'folder' | 'project',
  sourceRelativePath: string,
  destinationFolderRelativePath: string,
): Promise<WorkflowMoveResponse> {
  const response = await fetch(`${API}/workflows/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({
      itemType,
      sourceRelativePath,
      destinationFolderRelativePath,
    }),
  });

  return workflowJsonResponse<WorkflowMoveResponse>(response);
}

export async function publishWorkflowProject(
  relativePath: string,
  settings: WorkflowProjectSettingsDraft,
): Promise<WorkflowProjectItem> {
  const response = await fetch(`${API}/workflows/projects/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ relativePath, settings }),
  });

  const data = await workflowJsonResponse<{ project: WorkflowProjectItem }>(response);
  return data.project;
}

export async function unpublishWorkflowProject(relativePath: string): Promise<WorkflowProjectItem> {
  const response = await fetch(`${API}/workflows/projects/unpublish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ relativePath }),
  });

  const data = await workflowJsonResponse<{ project: WorkflowProjectItem }>(response);
  return data.project;
}

export async function deleteWorkflowProject(relativePath: string): Promise<WorkflowProjectDeleteResponse> {
  const response = await fetch(`${API}/workflows/projects`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify({ relativePath }),
  });

  return workflowJsonResponse<WorkflowProjectDeleteResponse>(response);
}

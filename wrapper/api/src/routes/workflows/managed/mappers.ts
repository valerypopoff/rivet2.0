import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectStatus,
} from '../../../../../shared/workflow-types.js';
import { getAggregateWorkflowProjectStatus } from '../../../../../shared/workflow-types.js';
import { normalizeWorkflowEndpointLookupName } from '../endpoint-names.js';
import {
  getManagedWorkflowFolderVirtualPath,
  getManagedWorkflowProjectVirtualPath,
} from '../virtual-paths.js';
import type { CurrentDraftRevisionRow, FolderRow, RevisionRow, WorkflowRow } from './types.js';
import type { WebAppPublicationRow } from './types.js';

function withTablePrefix(columnNames: readonly string[], tableAlias: string): string {
  return columnNames.map((columnName) => `${tableAlias}.${columnName}`).join(', ');
}

const WORKFLOW_COLUMN_NAMES = [
  'workflow_id',
  'name',
  'file_name',
  'relative_path',
  'folder_relative_path',
  'updated_at',
  'current_draft_revision_id',
  'published_revision_id',
  'published_version_id',
  'endpoint_name',
  'published_endpoint_name',
  'last_published_at',
] as const;

const RECORDING_COLUMN_NAMES = [
  'recording_id',
  'workflow_id',
  'source_project_name',
  'source_project_relative_path',
  'created_at',
  'run_kind',
  'status',
  'duration_ms',
  'endpoint_name_at_execution',
  'error_message',
  'recording_blob_key',
  'replay_project_blob_key',
  'replay_dataset_blob_key',
  'has_replay_dataset',
  'recording_compressed_bytes',
  'recording_uncompressed_bytes',
  'project_compressed_bytes',
  'project_uncompressed_bytes',
  'dataset_compressed_bytes',
  'dataset_uncompressed_bytes',
] as const;

export const WORKFLOW_COLUMNS = WORKFLOW_COLUMN_NAMES.join(', ');
export const WORKFLOW_COLUMNS_QUALIFIED = withTablePrefix(WORKFLOW_COLUMN_NAMES, 'w');
export const RECORDING_COLUMNS = RECORDING_COLUMN_NAMES.join(', ');

export function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function getWorkflowStatus(row: WorkflowRow): WorkflowProjectStatus {
  if (!row.published_revision_id) {
    return 'unpublished';
  }

  return row.published_revision_id === row.current_draft_revision_id &&
    normalizeWorkflowEndpointLookupName(row.published_endpoint_name) === normalizeWorkflowEndpointLookupName(row.endpoint_name)
    ? 'published'
    : 'unpublished_changes';
}

export function getWorkflowWebAppPublicationStatuses(
  row: WorkflowRow,
  webAppRows: readonly WebAppPublicationRow[] = [],
): WorkflowProjectStatus[] {
  return webAppRows.map((webApp) =>
    webApp.revision_id === row.current_draft_revision_id ? 'published' : 'unpublished_changes');
}

export function mapWorkflowRowToProjectItem(
  row: WorkflowRow,
  options: { webAppRows?: readonly WebAppPublicationRow[] } = {},
): WorkflowProjectItem {
  const status = getWorkflowStatus(row);

  return {
    id: row.workflow_id,
    name: row.name,
    fileName: row.file_name,
    relativePath: row.relative_path,
    absolutePath: getManagedWorkflowProjectVirtualPath(row.relative_path),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
    settings: {
      status,
      publicationStatus: getAggregateWorkflowProjectStatus(
        status,
        getWorkflowWebAppPublicationStatuses(row, options.webAppRows),
      ),
      endpointName: row.endpoint_name,
      lastPublishedAt: toIsoString(row.last_published_at),
      publishedWebApps: (options.webAppRows ?? []).map((webApp) => ({
        uiGraphId: webApp.ui_graph_id,
        uiGraphName: webApp.slug || webApp.ui_graph_id,
        slug: webApp.slug,
        publishedAt: toIsoString(webApp.published_at) ?? new Date().toISOString(),
        allowedEmails: webApp.allowed_emails ?? [],
      })),
    },
  };
}

export function mapFolderRowToFolderItem(row: FolderRow): WorkflowFolderItem {
  return {
    id: row.relative_path,
    name: row.name,
    relativePath: row.relative_path,
    absolutePath: getManagedWorkflowFolderVirtualPath(row.relative_path),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
    folders: [],
    projects: [],
  };
}

export function splitCurrentDraftRevisionRow(row: CurrentDraftRevisionRow): { workflow: WorkflowRow; revision: RevisionRow } {
  return {
    workflow: {
      workflow_id: row.workflow_id,
      name: row.name,
      file_name: row.file_name,
      relative_path: row.relative_path,
      folder_relative_path: row.folder_relative_path,
      updated_at: row.updated_at,
      current_draft_revision_id: row.current_draft_revision_id,
      published_revision_id: row.published_revision_id,
      published_version_id: row.published_version_id,
      endpoint_name: row.endpoint_name,
      published_endpoint_name: row.published_endpoint_name,
      last_published_at: row.last_published_at,
    },
    revision: {
      revision_id: row.revision_id,
      workflow_id: row.revision_workflow_id,
      project_blob_key: row.project_blob_key,
      dataset_blob_key: row.dataset_blob_key,
      stats_graph_count: row.stats_graph_count,
      stats_total_node_count: row.stats_total_node_count,
      stats_web_app_count: row.stats_web_app_count,
      created_at: row.revision_created_at,
    },
  };
}

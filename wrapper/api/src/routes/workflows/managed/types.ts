import type { AttachedData, CombinedDataset, Project } from '@valerypopoff/rivet2-node';

import type {
  WorkflowProjectItem,
} from '../../../../../shared/workflow-types.js';

type TimestampValue = Date | string;

export type FolderRow = {
  relative_path: string;
  name: string;
  parent_relative_path: string;
  updated_at: TimestampValue;
};

export type WorkflowRow = {
  workflow_id: string;
  name: string;
  file_name: string;
  relative_path: string;
  folder_relative_path: string;
  updated_at: TimestampValue;
  current_draft_revision_id: string;
  published_revision_id: string | null;
  published_version_id: string | null;
  endpoint_name: string;
  published_endpoint_name: string;
  last_published_at: TimestampValue | null;
};

export type RevisionRow = {
  revision_id: string;
  workflow_id: string;
  project_blob_key: string;
  dataset_blob_key: string | null;
  stats_graph_count: number | null;
  stats_total_node_count: number | null;
  stats_web_app_count: number | null;
  created_at: TimestampValue;
};

export type PublishedVersionRow = {
  version_id: string;
  workflow_id: string;
  revision_id: string;
  endpoint_name: string;
  published_at: TimestampValue;
  is_starred: boolean;
  comment: string;
};

export type WebAppPublicationRow = {
  app_id: string;
  workflow_id: string;
  revision_id: string;
  ui_graph_id: string;
  slug: string;
  slug_lookup_name: string;
  allowed_emails?: string[] | null;
  published_at: TimestampValue;
};

export type CurrentDraftRevisionRow = {
  workflow_id: string;
  name: string;
  file_name: string;
  relative_path: string;
  folder_relative_path: string;
  updated_at: TimestampValue;
  current_draft_revision_id: string;
  published_revision_id: string | null;
  published_version_id: string | null;
  endpoint_name: string;
  published_endpoint_name: string;
  last_published_at: TimestampValue | null;
  revision_id: string;
  revision_workflow_id: string;
  project_blob_key: string;
  dataset_blob_key: string | null;
  stats_graph_count: number | null;
  stats_total_node_count: number | null;
  stats_web_app_count: number | null;
  revision_created_at: TimestampValue;
};

export type ManagedRevisionContents = {
  contents: string;
  datasetsContents: string | null;
};

export type FolderMoveRow = {
  relative_path: string;
  name: string;
  parent_relative_path: string;
  updated_at: TimestampValue;
  moved_relative_paths: string[] | null;
};

export type RecordingRow = {
  recording_id: string;
  workflow_id: string;
  source_project_name: string;
  source_project_relative_path: string;
  created_at: TimestampValue;
  run_kind: 'published' | 'latest';
  status: 'succeeded' | 'failed' | 'suspicious';
  duration_ms: number;
  endpoint_name_at_execution: string;
  error_message: string | null;
  recording_blob_key: string;
  replay_project_blob_key: string;
  replay_dataset_blob_key: string | null;
  has_replay_dataset: boolean;
  recording_compressed_bytes: number;
  recording_uncompressed_bytes: number;
  project_compressed_bytes: number;
  project_uncompressed_bytes: number;
  dataset_compressed_bytes: number;
  dataset_uncompressed_bytes: number;
};

export type EndpointAggregateRow = {
  workflow_id: string;
  total_runs: number;
  failed_runs: number;
  suspicious_runs: number;
  latest_run_at: TimestampValue | null;
};

export type WorkflowRecordingListRow = WorkflowRow & Partial<EndpointAggregateRow>;

export type SaveHostedProjectResult = {
  path: string;
  revisionId: string;
  project: WorkflowProjectItem;
  created: boolean;
};

export type LoadHostedProjectResult = {
  contents: string;
  datasetsContents: string | null;
  revisionId: string;
};

export type TransactionHooks = {
  onCommit(task: () => Promise<void>): void;
  onRollback(task: () => Promise<void>): void;
};

export type PersistWorkflowExecutionRecordingOptions = {
  sourceProject: Project;
  sourceProjectPath: string;
  executedProject: Project;
  executedAttachedData: AttachedData;
  executedDatasets: CombinedDataset[];
  endpointName: string;
  recordingSerialized: string;
  runKind: 'published' | 'latest';
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  errorMessage?: string;
};

export type ImportManagedWorkflowOptions = {
  workflowId: string;
  relativePath: string;
  name: string;
  fileName?: string;
  contents: string;
  datasetsContents: string | null;
  endpointName: string;
  publishedEndpointName: string;
  publishedContents?: string | null;
  publishedDatasetsContents?: string | null;
  lastPublishedAt?: string | null;
  updatedAt?: string | null;
  publishedWebApps?: ImportManagedWorkflowPublishedWebAppOptions[];
};

export type ImportManagedWorkflowPublishedWebAppOptions = {
  uiGraphId: string;
  slug: string;
  allowedEmails?: string[];
  publishedAt: string;
  contents: string;
  datasetsContents: string | null;
};

export type ImportManagedWorkflowRecordingOptions = {
  recordingId: string;
  workflowId: string;
  sourceProjectRelativePath: string;
  sourceProjectName: string;
  createdAt: string;
  runKind: 'published' | 'latest';
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  endpointName: string;
  errorMessage?: string;
  recordingContents: string;
  replayProjectContents: string;
  replayDatasetContents?: string | null;
};

export type RecordingBlobArtifacts = {
  recording: string;
  replayProject: string;
  replayDataset?: string | null;
};

export type RecordingBlobKeys = {
  recordingBlobKey: string;
  replayProjectBlobKey: string;
  replayDatasetBlobKey: string | null;
};

export type RecordingInsertRowData = {
  recordingId: string;
  workflowId: string;
  sourceProjectName: string;
  sourceProjectRelativePath: string;
  runKind: 'published' | 'latest';
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  endpointNameAtExecution: string;
  errorMessage: string | null;
  recordingBlobKey: string;
  replayProjectBlobKey: string;
  replayDatasetBlobKey: string | null;
  hasReplayDataset: boolean;
  recordingCompressedBytes: number;
  recordingUncompressedBytes: number;
  projectCompressedBytes: number;
  projectUncompressedBytes: number;
  datasetCompressedBytes: number;
  datasetUncompressedBytes: number;
};

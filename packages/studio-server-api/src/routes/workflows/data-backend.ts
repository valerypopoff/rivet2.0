import type {
  AttachedData,
  CombinedDataset,
  Project,
  NodeDatasetProvider,
  ProjectReferenceLoader,
  ResolvedSubgraphProject,
  SubgraphProjectTarget,
} from '@valerypopoff/rivet2-node';
import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectDownloadVersion,
  WorkflowPublicationPreconditions,
  WorkflowDraftPublicationPreconditions,
  WorkflowEndpointAccess,
  WorkflowProjectPathMove,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../studio-server-shared/workflow-types.js';
import type {
  WorkflowRecordingExecutionIdentity,
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRunStatisticsCatalogResponse,
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsSurface,
} from '../../../../studio-server-shared/workflow-recording-types.js';
import type {
  WorkflowProjectReferenceSnapshot,
  WorkflowProjectReferenceCatalogEntry,
} from './project-reference-snapshots.js';

export type HostedProjectSaveOptions = {
  projectPath: string;
  contents: string;
  datasetsContents: string | null;
  expectedRevisionId?: string | null;
  projectId?: string;
  saveIntent?: 'in-place' | 'save-as';
};
export type LoadHostedProjectResult = { contents: string; datasetsContents: string | null; revisionId: string };
export type SaveHostedProjectResult = {
  path: string;
  revisionId: string;
  project: WorkflowProjectItem;
  created: boolean;
};
export type WorkflowExecutionDefinition = {
  project: Project;
  attachedData: AttachedData;
  datasetProvider: NodeDatasetProvider;
  projectVirtualPath: string;
  revisionKey: string;
  endpointAccess?: WorkflowEndpointAccess;
  webAppUiGraphId?: string;
  webAppAllowedEmails?: string[];
  /** Immutable published binding identity, independent of the executable revision. */
  webAppBindingId?: string;
  /** Process-local invalidation key for the binding's owning workflow. */
  webAppPolicyInvalidationKey?: string;
  debug?: { cacheStatus: 'hit' | 'miss' | 'bypass'; resolveMs: number; materializeMs: number };
};
export type WorkflowWebAppPolicy = { appId: string; relativePath: string; uiGraphId: string; allowedEmails: string[] };
export type PersistWorkflowExecutionRecordingOptions = {
  sourceProject: Project;
  sourceProjectPath: string;
  executedProject: Project;
  executedAttachedData: AttachedData;
  executedDatasets: CombinedDataset[];
  endpointName: string;
  recordingSerialized: string;
  runKind: 'published' | 'latest' | 'editor';
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  errorMessage?: string;
  executionIdentity?: WorkflowRecordingExecutionIdentity;
  /** Runs only after durable recording metadata commits. */
  onPersisted?: (recordingId: string) => Promise<void>;
};
type ProjectMoveResult = { project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] };
type FolderMoveResult = { folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] };

/** Domain-owned contracts. Transactions, migration and scheduler lifecycle stay in adapters. */
export interface WorkflowProjectRepository {
  getTree(): Promise<{ root: string; folders: WorkflowFolderItem[]; projects: WorkflowProjectItem[] }>;
  listProjectPathsForHostedIo(): Promise<string[]>;
  loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult>;
  saveHostedProject(options: HostedProjectSaveOptions): Promise<SaveHostedProjectResult>;
  readHostedText(filePath: string): Promise<string>;
  hostedPathExists(filePath: string): Promise<boolean>;
  resolveManagedRelativeProjectText(relativeFrom: string, projectFilePath: string): Promise<string>;
  createWorkflowFolderItem(name: unknown, parentRelativePath: unknown): Promise<WorkflowFolderItem>;
  renameWorkflowFolderItem(relativePath: unknown, newName: unknown): Promise<FolderMoveResult>;
  moveWorkflowFolder(sourceRelativePath: unknown, destinationFolderRelativePath: unknown): Promise<FolderMoveResult>;
  deleteWorkflowFolderItem(relativePath: unknown): Promise<void>;
  createWorkflowProjectItem(folderRelativePath: unknown, name: unknown): Promise<WorkflowProjectItem>;
  renameWorkflowProjectItem(relativePath: unknown, newName: unknown): Promise<ProjectMoveResult>;
  moveWorkflowProject(sourceRelativePath: unknown, destinationFolderRelativePath: unknown): Promise<ProjectMoveResult>;
  duplicateWorkflowProjectItem(
    relativePath: unknown,
    version?: WorkflowProjectDownloadVersion,
  ): Promise<WorkflowProjectItem>;
  uploadWorkflowProjectItem(
    folderRelativePath: unknown,
    fileName: unknown,
    contents: unknown,
  ): Promise<WorkflowProjectItem>;
  readWorkflowProjectDownload(
    relativePath: unknown,
    version: WorkflowProjectDownloadVersion,
  ): Promise<{ contents: string; fileName: string }>;
  readWorkflowProjectReferenceSnapshots(relativePath: unknown): Promise<WorkflowProjectReferenceSnapshot[]>;
  listWorkflowProjectReferenceCatalog(): Promise<WorkflowProjectReferenceCatalogEntry[]>;
  deleteWorkflowProjectItem(relativePath: unknown): Promise<string | null>;
}
export interface WorkflowPublicationRepository {
  listWorkflowPublishedVersions(relativePath: unknown): Promise<WorkflowPublishedVersionsResponse>;
  readWorkflowPublishedVersionDownload(
    relativePath: unknown,
    versionId: unknown,
  ): Promise<{ contents: string; fileName: string }>;
  readWorkflowPublishedVersionPreview(
    relativePath: unknown,
    versionId: unknown,
  ): Promise<{ contents: string; datasetsContents: string | null }>;
  setWorkflowPublishedVersionStar(
    relativePath: unknown,
    versionId: unknown,
    isStarred: unknown,
  ): Promise<WorkflowPublishedVersionSummary>;
  setWorkflowPublishedVersionComment(
    relativePath: unknown,
    versionId: unknown,
    comment: unknown,
  ): Promise<WorkflowPublishedVersionSummary>;
  restoreWorkflowPublishedVersion(
    relativePath: unknown,
    versionId: unknown,
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<WorkflowPublishedVersionRestoreResponse>;
  publishWorkflowProjectItem(
    relativePath: unknown,
    settings: unknown,
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
  updateWorkflowEndpointAccess(
    relativePath: unknown,
    access: WorkflowEndpointAccess,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
  listWorkflowProjectWebApps(relativePath: unknown): Promise<WorkflowProjectWebAppsResponse>;
  publishWorkflowProjectWebApps(
    relativePath: unknown,
    publications: unknown,
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
  updateWorkflowProjectWebAppAccess(
    relativePath: unknown,
    accessUpdates: unknown,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
  unpublishWorkflowProjectWebApp(
    relativePath: unknown,
    uiGraphId: unknown,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
  unpublishWorkflowProjectItem(
    relativePath: unknown,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
}
export interface WorkflowExecutionSources {
  loadPublishedExecutionProject(
    endpointName: string,
    requireFreshPointer?: boolean,
  ): Promise<WorkflowExecutionDefinition | null>;
  loadLatestExecutionProject(
    endpointName: string,
    requireFreshPointer?: boolean,
  ): Promise<WorkflowExecutionDefinition | null>;
  loadPublishedWebAppExecutionProject(slug: string): Promise<WorkflowExecutionDefinition | null>;
  loadLatestWebAppExecutionProject(slug: string): Promise<WorkflowExecutionDefinition | null>;
  resolveWebAppAccessPolicy(slug: string): Promise<WorkflowWebAppPolicy | null>;
  createProjectReferenceLoader(): ProjectReferenceLoader;
  loadSubgraphTarget(target: SubgraphProjectTarget): Promise<ResolvedSubgraphProject>;
}
export interface WorkflowRecordingRepository {
  listWorkflowRecordingWorkflows(): Promise<WorkflowRecordingWorkflowListResponse>;
  listWorkflowRecordingRunsPage(
    workflowId: string,
    page: number,
    pageSize: number,
    statusFilter: WorkflowRecordingFilterStatus,
    inputFilter?: WorkflowRecordingInputFilter | null,
    inputCursor?: number,
    signal?: AbortSignal,
    inputAfter?: string,
    includeSubgraphRuns?: boolean,
    runScope?: 'all' | 'roots' | 'children',
  ): Promise<WorkflowRecordingRunsPageResponse>;
  listWorkflowRunStatisticsCatalog(
    surface: WorkflowRunStatisticsSurface,
  ): Promise<WorkflowRunStatisticsCatalogResponse>;
  getWorkflowRunStatistics(query: WorkflowRunStatisticsQuery): Promise<WorkflowRunStatisticsResponse>;
  readWorkflowRecordingArtifact(
    recordingId: string,
    artifact: 'recording' | 'replay-project' | 'replay-dataset',
  ): Promise<string>;
  deleteWorkflowRecording(recordingId: string): Promise<void>;
  persistWorkflowExecutionRecording(options: PersistWorkflowExecutionRecordingOptions): Promise<string | undefined>;
}
export interface WorkflowDataBackend
  extends WorkflowProjectRepository,
    WorkflowPublicationRepository,
    WorkflowExecutionSources,
    WorkflowRecordingRepository {}

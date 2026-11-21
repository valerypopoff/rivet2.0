import type { RecordingRunScope } from './recording-workflow-scope.js';
import type { ProjectReferenceQuery } from './managed/reference-index.js';
import type {
  AttachedData,
  CombinedDataset,
  Project,
  ProjectId,
  NodeDatasetProvider,
  ProjectReferenceLoader,
  ResolvedSubgraphProject,
  SubgraphProjectTarget,
} from '@valerypopoff/rivet2-node';
import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectReferencesResponse,
  WorkflowProjectDownloadVersion,
  WorkflowPublicationPreconditions,
  WorkflowDraftPublicationPreconditions,
  WorkflowEndpointAccess,
  WorkflowProjectPathMove,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
  WorkflowProjectSettingsDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppAccessDraft,
} from '../../../../studio-server-shared/workflow-types.js';
import type {
  WorkflowRecordingExecutionIdentity,
  WorkflowRunCost,
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunSummary,
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

/** Hosted IO compatibility retains filesystem responses without widening SQL contracts. */
export type HostedProjectSaveIntent = 'in-place' | 'save-as';
export type HostedProjectStorageSaveOptions = {
  projectPath: string;
  contents: string;
  datasetsContents: string | null;
  expectedRevisionId?: string | null;
  projectId?: ProjectId;
  saveIntent?: HostedProjectSaveIntent;
  structuralMutation?: import('@valerypopoff/rivet-studio-server-shared/workflow-mutation-contract.js').StructuralMutation;
};
export type HostedProjectStorageLoadResult = {
  contents: string;
  datasetsContents: string | null;
  revisionId: string | null;
};
export type HostedProjectStorageSaveResult = {
  path: string;
  revisionId: string | null;
  project: WorkflowProjectItem | null;
  created: boolean;
};
export type WorkflowWebAppAccessPolicy = {
  projectVirtualPath: string;
  uiGraphId: string;
  allowedEmails: string[];
  bindingId: string;
};

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
  frozenReferences?: {
    projectReferenceLoader: ProjectReferenceLoader;
    subgraphProjectLoader: import('@valerypopoff/rivet2-node').SubgraphProjectLoader;
  };
  webAppUiGraphId?: string;
  webAppAllowedEmails?: string[];
  /** Immutable published binding identity, independent of the executable revision. */
  webAppBindingId?: string;
  /** Process-local invalidation key for the binding's owning workflow. */
  webAppPolicyInvalidationKey?: string;
  debug?: { cacheStatus: 'hit' | 'miss' | 'bypass'; resolveMs: number; materializeMs: number };
};
/** Metadata-only lookup. Loading artifacts and constructing mutable run state is deferred until admission. */
export type WorkflowPublishedExecutionTarget = {
  endpointAccess?: WorkflowEndpointAccess;
  load(): Promise<WorkflowExecutionDefinition | null>;
};
export type WorkflowWebAppPolicy = { appId: string; relativePath: string; uiGraphId: string; allowedEmails: string[] };
export type PersistWorkflowExecutionRecordingOptions = {
  evidenceHandle?: import('@valerypopoff/rivet-studio-server-shared/workflow-run-evidence.js').RunEvidenceHandle;
  /** Logical run creation/start time; omitted by older producers. Never a storage key. */
  createdAt?: string;
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
  cost?: WorkflowRunCost;
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
  createWorkflowFolderItem(name: string, parentRelativePath: string): Promise<WorkflowFolderItem>;
  renameWorkflowFolderItem(relativePath: string, newName: string): Promise<FolderMoveResult>;
  moveWorkflowFolder(sourceRelativePath: string, destinationFolderRelativePath: string): Promise<FolderMoveResult>;
  deleteWorkflowFolderItem(relativePath: string): Promise<void>;
  createWorkflowProjectItem(folderRelativePath: string, name: string): Promise<WorkflowProjectItem>;
  renameWorkflowProjectItem(relativePath: string, newName: string): Promise<ProjectMoveResult>;
  moveWorkflowProject(sourceRelativePath: string, destinationFolderRelativePath: string): Promise<ProjectMoveResult>;
  duplicateWorkflowProjectItem(
    relativePath: string,
    version?: WorkflowProjectDownloadVersion,
  ): Promise<WorkflowProjectItem>;
  uploadWorkflowProjectItem(
    folderRelativePath: string,
    fileName: string,
    contents: string,
  ): Promise<WorkflowProjectItem>;
  readWorkflowProjectDownload(
    relativePath: string,
    version: WorkflowProjectDownloadVersion,
  ): Promise<{ contents: string; fileName: string }>;
  readWorkflowProjectReferenceSnapshots(relativePath: string): Promise<WorkflowProjectReferenceSnapshot[]>;
  listWorkflowProjectReferenceCatalog(): Promise<WorkflowProjectReferenceCatalogEntry[]>;
  /** Managed immutable revisions support a bounded, blob-free lookup. */
  readIndexedProjectReferences?(query: ProjectReferenceQuery): Promise<WorkflowProjectReferencesResponse>;
  deleteWorkflowProjectItem(relativePath: string): Promise<string | null>;
}
export interface WorkflowPublicationRepository {
  readWorkflowReferenceOverview?(): Promise<import('../../../../studio-server-shared/workflow-types.js').WorkflowReferenceOverview>;
  readWorkflowBundleReferenceDetails?(bundleId: string): Promise<import('../../../../studio-server-shared/workflow-types.js').WorkflowBundleReferenceDetails>;
  listWorkflowPublishedVersions(relativePath: string): Promise<WorkflowPublishedVersionsResponse>;
  reviewEndpointRelease?(
    relativePath: string,
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<import('../../../../studio-server-shared/workflow-types.js').WorkflowEndpointReleaseReview | null>;
  readWorkflowHistoryPreview?(
    relativePath: string, versionId: string, ownerId?: string,
  ): Promise<import('../../../../studio-server-shared/workflow-types.js').WorkflowHistoryPreview>;
  readWorkflowPublishedVersionDownload(
    relativePath: string,
    versionId: string,
  ): Promise<{ contents: string | Buffer; fileName: string }>;
  readWorkflowPublishedVersionPreview(
    relativePath: string,
    versionId: string,
    artifactId?: string,
    ownerId?: string,
  ): Promise<{ contents: string; datasetsContents: string | null }>;
  setWorkflowPublishedVersionStar(
    relativePath: string,
    versionId: string,
    isStarred: boolean,
  ): Promise<WorkflowPublishedVersionSummary>;
  setWorkflowPublishedVersionComment(
    relativePath: string,
    versionId: string,
    comment: string,
  ): Promise<WorkflowPublishedVersionSummary>;
  restoreWorkflowPublishedVersion(
    relativePath: string,
    versionId: string,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowPublishedVersionRestoreResponse>;
  publishWorkflowProjectItem(
    relativePath: string,
    settings: WorkflowProjectSettingsDraft,
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
  updateWorkflowEndpointAccess(
    relativePath: string,
    access: WorkflowEndpointAccess,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
  listWorkflowProjectWebApps(relativePath: string): Promise<WorkflowProjectWebAppsResponse>;
  publishWorkflowProjectWebApps(
    relativePath: string,
    publications: WorkflowProjectWebAppPublicationDraft[],
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
  updateWorkflowProjectWebAppAccess(
    relativePath: string,
    accessUpdates: WorkflowProjectWebAppAccessDraft[],
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
  unpublishWorkflowProjectWebApp(
    relativePath: string,
    uiGraphId: string,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
  unpublishWorkflowProjectItem(
    relativePath: string,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem>;
}
export interface WorkflowExecutionSources {
  resolvePublishedExecutionTarget(
    endpointName: string,
    requireFreshPointer?: boolean,
  ): Promise<WorkflowPublishedExecutionTarget | null>;
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
  validateSubgraphTarget?(target: SubgraphProjectTarget): Promise<void>;
}
export type WorkflowRecordingPageQuery = {
  includeEvidence?: boolean;
  workflowId: string;
  page: number;
  pageSize: number;
  statusFilter?: WorkflowRecordingFilterStatus;
  inputFilter?: WorkflowRecordingInputFilter | null;
  inputCursor?: number;
  signal?: AbortSignal;
  inputAfter?: string;
  includeSubgraphRuns?: boolean;
  runScope?: RecordingRunScope;
};

export interface WorkflowRecordingRepository {
  readonly evidence?: import('@valerypopoff/rivet-studio-server-shared/workflow-run-evidence.js').RunEvidenceRepository;
  getWorkflowRecordingSummary(recordingId: string): Promise<WorkflowRecordingRunSummary>;
  listWorkflowRecordingWorkflows(includeEvidence?: boolean): Promise<WorkflowRecordingWorkflowListResponse>;
  listWorkflowRecordingRunsPage(query: WorkflowRecordingPageQuery): Promise<WorkflowRecordingRunsPageResponse>;
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

/** Feature dependencies; the combined adapter is reserved for resource composition/migration. */
export type WorkflowRepositories = {
  projects: WorkflowProjectRepository;
  publications: WorkflowPublicationRepository;
  execution: WorkflowExecutionSources;
  recordings: WorkflowRecordingRepository;
};

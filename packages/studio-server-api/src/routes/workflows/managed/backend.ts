import type {
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../../studio-server-shared/workflow-types.js';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRunStatisticsCatalogResponse,
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsSurface,
} from '../../../../../studio-server-shared/workflow-recording-types.js';
import type { RuntimeHealthCheckContext } from '../../../runtime-health.js';
import type { ManagedWorkflowStorageConfig } from '../storage-config.js';
import { PostgresRivetLLMProfileHealthStore } from '../../../llm-profile-health/managed-store.js';
import { PostgresRivetEvaluationStore } from '../../../evaluation-runs/managed-store.js';
import { HostedEvaluationCoordinator } from '../../../evaluation-runs/hosted-coordinator.js';
import { createHostedEvaluationGraphRunner } from '../../../evaluation-runs/hosted-execution.js';
import { getHostedEvaluationsCoordinatorConfig } from '../../../hosted-evaluations-config.js';
import type { ManagedWorkflowBlobStore } from './blob-store.js';
import { createManagedWorkflowCatalogService } from './catalog.js';
import {
  listManagedReconciliationFindingDetails,
  type ManagedReconciliationFindingDetailQuery,
} from './reconciliation.js';
import { createManagedWorkflowContext } from './context.js';
import type { ManagedExecutionProjectResult } from './execution-types.js';
import { ManagedWorkflowExecutionService } from './execution-service.js';
import { createManagedWorkflowPublicationService } from './publication.js';
import { createManagedWorkflowRecordingService } from './recordings.js';
import { createManagedWorkflowRevisionService } from './revisions.js';
import type {
  ImportManagedWorkflowOptions,
  ImportManagedWorkflowRecordingOptions,
  LoadHostedProjectResult,
  PersistWorkflowExecutionRecordingOptions,
  SaveHostedProjectResult,
} from './types.js';

export { resolveManagedHostedProjectSaveTarget } from './revision-factory.js';

export class ManagedWorkflowBackend {
  readonly #context;
  readonly #executionService: ManagedWorkflowExecutionService;
  readonly #catalog: ReturnType<typeof createManagedWorkflowCatalogService>;
  readonly #revisions: ReturnType<typeof createManagedWorkflowRevisionService>;
  readonly #publication: ReturnType<typeof createManagedWorkflowPublicationService>;
  readonly #recordings: ReturnType<typeof createManagedWorkflowRecordingService>;
  readonly #llmProfileHealthStore: PostgresRivetLLMProfileHealthStore;
  readonly #evaluationStore: PostgresRivetEvaluationStore;
  readonly #hostedEvaluationCoordinator: HostedEvaluationCoordinator;

  constructor(config: ManagedWorkflowStorageConfig, blobStore?: ManagedWorkflowBlobStore) {
    this.#context = createManagedWorkflowContext(config, blobStore);
    this.#executionService = new ManagedWorkflowExecutionService({
      context: this.#context,
    });
    this.#revisions = createManagedWorkflowRevisionService({
      context: this.#context,
    });
    this.#catalog = createManagedWorkflowCatalogService({
      context: this.#context,
      saveHostedProject: (options) => this.#revisions.saveHostedProject(options),
    });
    this.#publication = createManagedWorkflowPublicationService({
      context: this.#context,
    });
    this.#recordings = createManagedWorkflowRecordingService({
      context: this.#context,
    });
    this.#llmProfileHealthStore = new PostgresRivetLLMProfileHealthStore(this.#context.pool);
    this.#evaluationStore = new PostgresRivetEvaluationStore(this.#context.pool);
    this.#hostedEvaluationCoordinator = new HostedEvaluationCoordinator({
      pool: this.#context.pool,
      runStore: this.#evaluationStore,
      config: getHostedEvaluationsCoordinatorConfig(),
      runGraph: createHostedEvaluationGraphRunner({
        evaluationStore: this.#evaluationStore,
        llmProfileHealthStore: this.#llmProfileHealthStore,
        createProjectReferenceLoader: () => Promise.resolve(this.#executionService.createProjectReferenceLoader()),
      }),
    });
  }

  async initialize(): Promise<void> {
    await this.#recordings.initialize();
    this.#hostedEvaluationCoordinator.start();
  }

  async dispose(): Promise<void> {
    await this.#hostedEvaluationCoordinator.stop();
    await this.#context.dispose();
  }

  async checkHealth(context?: RuntimeHealthCheckContext): Promise<void> {
    await this.#context.checkHealth(context);
  }

  async getTree(): Promise<{ root: string; folders: WorkflowFolderItem[]; projects: WorkflowProjectItem[] }> {
    return this.#catalog.getTree();
  }

  async listProjectPathsForHostedIo(): Promise<string[]> {
    return this.#catalog.listProjectPathsForHostedIo();
  }

  async loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult> {
    return this.#revisions.loadHostedProject(projectPath);
  }

  async saveHostedProject(options: {
    projectPath: string;
    contents: string;
    datasetsContents: string | null;
    expectedRevisionId?: string | null;
  }): Promise<SaveHostedProjectResult> {
    return this.#revisions.saveHostedProject(options);
  }

  async importWorkflow(options: ImportManagedWorkflowOptions): Promise<WorkflowProjectItem> {
    return this.#revisions.importWorkflow(options);
  }

  async readHostedText(filePath: string): Promise<string> {
    return this.#catalog.readHostedText(filePath);
  }

  async hostedPathExists(filePath: string): Promise<boolean> {
    return this.#catalog.hostedPathExists(filePath);
  }

  async resolveManagedRelativeProjectText(relativeFrom: string, projectFilePath: string): Promise<string> {
    return this.#catalog.resolveManagedRelativeProjectText(relativeFrom, projectFilePath);
  }

  async createWorkflowFolderItem(name: unknown, parentRelativePath: unknown) {
    return this.#catalog.createWorkflowFolderItem(name, parentRelativePath);
  }

  async renameWorkflowFolderItem(
    relativePath: unknown,
    newName: unknown,
  ): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.renameWorkflowFolderItem(relativePath, newName);
  }

  async moveWorkflowFolder(
    sourceRelativePath: unknown,
    destinationFolderRelativePath: unknown,
  ): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.moveWorkflowFolder(sourceRelativePath, destinationFolderRelativePath);
  }

  async deleteWorkflowFolderItem(relativePath: unknown): Promise<void> {
    return this.#catalog.deleteWorkflowFolderItem(relativePath);
  }

  async createWorkflowProjectItem(folderRelativePath: unknown, name: unknown): Promise<WorkflowProjectItem> {
    return this.#catalog.createWorkflowProjectItem(folderRelativePath, name);
  }

  async renameWorkflowProjectItem(
    relativePath: unknown,
    newName: unknown,
  ): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.renameWorkflowProjectItem(relativePath, newName);
  }

  async moveWorkflowProject(
    sourceRelativePath: unknown,
    destinationFolderRelativePath: unknown,
  ): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.moveWorkflowProject(sourceRelativePath, destinationFolderRelativePath);
  }

  async duplicateWorkflowProjectItem(
    relativePath: unknown,
    version: WorkflowProjectDownloadVersion = 'live',
  ): Promise<WorkflowProjectItem> {
    return this.#catalog.duplicateWorkflowProjectItem(relativePath, version);
  }

  async uploadWorkflowProjectItem(
    folderRelativePath: unknown,
    fileName: unknown,
    contents: unknown,
  ): Promise<WorkflowProjectItem> {
    return this.#catalog.uploadWorkflowProjectItem(folderRelativePath, fileName, contents);
  }

  async readWorkflowProjectDownload(
    relativePath: unknown,
    version: WorkflowProjectDownloadVersion,
  ): Promise<{ contents: string; fileName: string }> {
    return this.#catalog.readWorkflowProjectDownload(relativePath, version);
  }

  async getLLMProfileHealthStore(): Promise<PostgresRivetLLMProfileHealthStore> {
    await this.initialize();
    return this.#llmProfileHealthStore;
  }

  async getManagedReconciliationStatus() {
    await this.initialize();
    return this.#context.getReconciliationStatus();
  }

  async listManagedReconciliationFindingDetails(query: ManagedReconciliationFindingDetailQuery) {
    await this.initialize();
    return listManagedReconciliationFindingDetails(this.#context.pool, query);
  }

  async getEvaluationStore(): Promise<PostgresRivetEvaluationStore> {
    await this.initialize();
    return this.#evaluationStore;
  }

  async getHostedEvaluationCoordinator(): Promise<HostedEvaluationCoordinator> {
    await this.initialize();
    return this.#hostedEvaluationCoordinator;
  }

  async listWorkflowPublishedVersions(relativePath: unknown): Promise<WorkflowPublishedVersionsResponse> {
    return this.#publication.listWorkflowPublishedVersions(relativePath);
  }

  async readWorkflowPublishedVersionDownload(
    relativePath: unknown,
    versionId: unknown,
  ): Promise<{ contents: string; fileName: string }> {
    return this.#publication.readWorkflowPublishedVersionDownload(relativePath, versionId);
  }

  async readWorkflowPublishedVersionPreview(
    relativePath: unknown,
    versionId: unknown,
  ): Promise<{ contents: string; datasetsContents: string | null }> {
    return this.#publication.readWorkflowPublishedVersionPreview(relativePath, versionId);
  }

  async setWorkflowPublishedVersionStar(
    relativePath: unknown,
    versionId: unknown,
    isStarred: unknown,
  ): Promise<WorkflowPublishedVersionSummary> {
    return this.#publication.setWorkflowPublishedVersionStar(relativePath, versionId, isStarred);
  }

  async setWorkflowPublishedVersionComment(
    relativePath: unknown,
    versionId: unknown,
    comment: unknown,
  ): Promise<WorkflowPublishedVersionSummary> {
    return this.#publication.setWorkflowPublishedVersionComment(relativePath, versionId, comment);
  }

  async restoreWorkflowPublishedVersion(
    relativePath: unknown,
    versionId: unknown,
  ): Promise<WorkflowPublishedVersionRestoreResponse> {
    return this.#publication.restoreWorkflowPublishedVersion(relativePath, versionId);
  }

  async publishWorkflowProjectItem(relativePath: unknown, settings: unknown): Promise<WorkflowProjectItem> {
    return this.#publication.publishWorkflowProjectItem(relativePath, settings);
  }

  async listWorkflowProjectWebApps(relativePath: unknown): Promise<WorkflowProjectWebAppsResponse> {
    return this.#publication.listWorkflowProjectWebApps(relativePath);
  }

  async publishWorkflowProjectWebApps(
    relativePath: unknown,
    publications: WorkflowProjectWebAppPublicationDraft[] | unknown,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.publishWorkflowProjectWebApps(relativePath, publications);
  }

  async updateWorkflowProjectWebAppAccess(
    relativePath: unknown,
    accessUpdates: WorkflowProjectWebAppAccessDraft[] | unknown,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.updateWorkflowProjectWebAppAccess(relativePath, accessUpdates);
  }

  async unpublishWorkflowProjectWebApp(relativePath: unknown, uiGraphId: unknown): Promise<WorkflowProjectItem> {
    return this.#publication.unpublishWorkflowProjectWebApp(relativePath, uiGraphId);
  }

  async unpublishWorkflowProjectItem(relativePath: unknown): Promise<WorkflowProjectItem> {
    return this.#publication.unpublishWorkflowProjectItem(relativePath);
  }

  async deleteWorkflowProjectItem(relativePath: unknown): Promise<string | null> {
    return this.#catalog.deleteWorkflowProjectItem(relativePath);
  }

  async loadPublishedExecutionProject(endpointName: string): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadPublishedExecutionProject(endpointName);
  }

  async loadLatestExecutionProject(endpointName: string): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadLatestExecutionProject(endpointName);
  }

  async loadPublishedWebAppExecutionProject(slug: string): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadPublishedWebAppExecutionProject(slug);
  }

  async loadLatestWebAppExecutionProject(slug: string): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadLatestWebAppExecutionProject(slug);
  }

  createProjectReferenceLoader() {
    return this.#executionService.createProjectReferenceLoader();
  }

  async importWorkflowRecording(options: ImportManagedWorkflowRecordingOptions): Promise<void> {
    return this.#recordings.importWorkflowRecording(options);
  }

  async cleanupWorkflowRecordings(): Promise<void> {
    return this.#recordings.cleanupWorkflowRecordingStorage();
  }

  async listWorkflowRecordingWorkflows(): Promise<WorkflowRecordingWorkflowListResponse> {
    return this.#recordings.listWorkflowRecordingWorkflows();
  }

  async listWorkflowRecordingRunsPage(
    workflowId: string,
    page: number,
    pageSize: number,
    statusFilter: WorkflowRecordingFilterStatus,
    inputFilter: WorkflowRecordingInputFilter | null = null,
    inputCursor = 0,
    signal?: AbortSignal,
  ): Promise<WorkflowRecordingRunsPageResponse> {
    return this.#recordings.listWorkflowRecordingRunsPage(
      workflowId,
      page,
      pageSize,
      statusFilter,
      inputFilter,
      inputCursor,
      signal,
    );
  }

  async listWorkflowRunStatisticsCatalog(
    surface: WorkflowRunStatisticsSurface,
  ): Promise<WorkflowRunStatisticsCatalogResponse> {
    return this.#recordings.listWorkflowRunStatisticsCatalog(surface);
  }

  async getWorkflowRunStatistics(query: WorkflowRunStatisticsQuery): Promise<WorkflowRunStatisticsResponse> {
    return this.#recordings.getWorkflowRunStatistics(query);
  }

  async readWorkflowRecordingArtifact(
    recordingId: string,
    artifact: 'recording' | 'replay-project' | 'replay-dataset',
  ): Promise<string> {
    return this.#recordings.readWorkflowRecordingArtifact(recordingId, artifact);
  }

  async deleteWorkflowRecording(recordingId: string): Promise<void> {
    return this.#recordings.deleteWorkflowRecording(recordingId);
  }

  async persistWorkflowExecutionRecording(options: PersistWorkflowExecutionRecordingOptions): Promise<string | undefined> {
    return this.#recordings.persistWorkflowExecutionRecording(options);
  }
}

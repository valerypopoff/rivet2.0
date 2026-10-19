import type { WorkflowRecordingPageQuery } from '../data-backend.js';
import type { PreparedProjectBundleImport } from '../project-bundle-import.js';
import { importManagedProjectBundle } from './bundle-import.js';
import { createManagedBundleService } from './bundles.js';
import { validateManagedSubgraphTarget } from './subgraph-access.js';
import { isLegacyRestorePaused } from '../../../legacy-restore/service.js';
import type {
  WorkflowFolderItem,
  WorkflowEndpointAccess,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectSettingsDraft,
  WorkflowPublicationPreconditions,
  WorkflowDraftPublicationPreconditions,
  WorkflowProjectPathMove,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../../studio-server-shared/workflow-types.js';
import type {
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
import type { ManagedExecutionProjectResult, ManagedWebAppAccessPolicy } from './execution-types.js';
import type { ResolvedSubgraphProject, SubgraphProjectTarget } from '@valerypopoff/rivet2-node';
import { ManagedWorkflowExecutionService } from './execution-service.js';
import { createManagedWorkflowPublicationService } from './publication.js';
import { createManagedWorkflowRecordingService } from './recordings.js';
import { createManagedWorkflowRevisionService } from './revisions.js';
import { readManagedWorkflowMigrationSnapshot } from './migration-snapshot.js';
import type { WorkflowDataBackend } from '../data-backend.js';
import type {
  ImportManagedWorkflowOptions,
  ImportManagedWorkflowRecordingOptions,
  ManagedWorkflowMigrationSnapshot,
  LoadHostedProjectResult,
  PersistWorkflowExecutionRecordingOptions,
  SaveHostedProjectResult,
} from './types.js';

export { resolveManagedHostedProjectSaveTarget } from './revision-factory.js';

export class ManagedWorkflowBackend implements WorkflowDataBackend {
  readonly bundles;
  readonly #context;
  readonly #executionService: ManagedWorkflowExecutionService;
  readonly #catalog: ReturnType<typeof createManagedWorkflowCatalogService>;
  readonly #revisions: ReturnType<typeof createManagedWorkflowRevisionService>;
  readonly #publication: ReturnType<typeof createManagedWorkflowPublicationService>;
  readonly #recordings: ReturnType<typeof createManagedWorkflowRecordingService>;
  readonly #llmProfileHealthStore: PostgresRivetLLMProfileHealthStore;
  readonly #evaluationStore: PostgresRivetEvaluationStore;
  readonly #hostedEvaluationCoordinator?: HostedEvaluationCoordinator;
  readonly #runBackgroundTasks: boolean;
  #phase: 'open' | 'draining' | 'closed' = 'open';
  #initializing?: Promise<void>;
  #draining?: Promise<void>;
  #disposing?: Promise<void>;

  constructor(
    config: ManagedWorkflowStorageConfig,
    blobStore?: ManagedWorkflowBlobStore,
    options?: { migrationMode?: 'copy' | 'verify' | 'restore' },
  ) {
    this.#runBackgroundTasks = options?.migrationMode === undefined && !isLegacyRestorePaused();
    this.#context = createManagedWorkflowContext(config, blobStore, options);
    this.bundles = createManagedBundleService(this.#context);
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
    if (this.#runBackgroundTasks) {
      this.#hostedEvaluationCoordinator = new HostedEvaluationCoordinator({
        pool: this.#context.pool,
        runStore: this.#evaluationStore,
        config: getHostedEvaluationsCoordinatorConfig(),
        runGraph: createHostedEvaluationGraphRunner({
          evaluationStore: this.#evaluationStore,
          llmProfileHealthStore: this.#llmProfileHealthStore,
          createProjectReferenceLoader: () => Promise.resolve(this.#executionService.createProjectReferenceLoader()),
          createSubgraphProjectLoader: () => ({
            loadTarget: (target) => this.#executionService.loadSubgraphTarget(target),
            validateTarget: (target) => this.validateSubgraphTarget(target),
          }),
        }),
      });
    }
  }

  async initialize(): Promise<void> {
    if (this.#phase === 'closed' || (this.#phase === 'draining' && !this.#initializing)) {
      throw new Error('Managed workflow storage is shutting down.');
    }
    // Migration verification must not run startup retention or start a
    // scheduler against an offline destination being compared byte-for-byte.
    return (this.#initializing ??= (async () => {
      if (this.#runBackgroundTasks) await this.#recordings.initialize();
      else await this.#context.initialize();
      // The server starts workers after runtime libraries are ready. Opening
      // storage for startup, health or an HTTP request must not execute graphs.
    })());
  }

  async dispose(): Promise<void> {
    return (this.#disposing ??= (async () => {
      await this.drain();
      this.#phase = 'closed';
      await this.#context.dispose();
    })());
  }

  async drain(): Promise<void> {
    this.#phase = this.#phase === 'closed' ? 'closed' : 'draining';
    return (this.#draining ??= (async () => {
      await this.#initializing?.catch(() => undefined);
      await this.#hostedEvaluationCoordinator?.stop();
    })());
  }
  beginRetirement(): void {
    this.#hostedEvaluationCoordinator?.beginRetirement();
  }
  async drainAcceptedWork(): Promise<void> {
    await this.#hostedEvaluationCoordinator?.drainAcceptedWork();
  }

  async checkHealth(context?: RuntimeHealthCheckContext): Promise<void> {
    await this.#context.checkHealth(context);
  }

  async getTree(): Promise<{ root: string; folders: WorkflowFolderItem[]; projects: WorkflowProjectItem[] }> {
    return this.#catalog.getTree();
  }

  async importProjectBundle(parent: string, bundle: PreparedProjectBundleImport) {
    await this.initialize();
    return importManagedProjectBundle(this.#context, parent, bundle);
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
    projectId?: string;
    saveIntent?: 'in-place' | 'save-as';
  }): Promise<SaveHostedProjectResult> {
    return this.#revisions.saveHostedProject(options);
  }

  async importWorkflow(options: ImportManagedWorkflowOptions): Promise<WorkflowProjectItem> {
    return this.#revisions.importWorkflow(options);
  }

  async readWorkflowMigrationSnapshot(relativePath: string): Promise<ManagedWorkflowMigrationSnapshot | null> {
    return readManagedWorkflowMigrationSnapshot(this.#context, relativePath);
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

  async createWorkflowFolderItem(name: string, parentRelativePath: string) {
    return this.#catalog.createWorkflowFolderItem(name, parentRelativePath);
  }

  async renameWorkflowFolderItem(
    relativePath: string,
    newName: string,
  ): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.renameWorkflowFolderItem(relativePath, newName);
  }

  async moveWorkflowFolder(
    sourceRelativePath: string,
    destinationFolderRelativePath: string,
  ): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.moveWorkflowFolder(sourceRelativePath, destinationFolderRelativePath);
  }

  async deleteWorkflowFolderItem(relativePath: string): Promise<void> {
    return this.#catalog.deleteWorkflowFolderItem(relativePath);
  }

  async createWorkflowProjectItem(folderRelativePath: string, name: string): Promise<WorkflowProjectItem> {
    return this.#catalog.createWorkflowProjectItem(folderRelativePath, name);
  }

  async renameWorkflowProjectItem(
    relativePath: string,
    newName: string,
  ): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.renameWorkflowProjectItem(relativePath, newName);
  }

  async moveWorkflowProject(
    sourceRelativePath: string,
    destinationFolderRelativePath: string,
  ): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.moveWorkflowProject(sourceRelativePath, destinationFolderRelativePath);
  }

  async duplicateWorkflowProjectItem(
    relativePath: string,
    version: WorkflowProjectDownloadVersion = 'live',
  ): Promise<WorkflowProjectItem> {
    return this.#catalog.duplicateWorkflowProjectItem(relativePath, version);
  }

  async uploadWorkflowProjectItem(
    folderRelativePath: string,
    fileName: string,
    contents: string,
  ): Promise<WorkflowProjectItem> {
    return this.#catalog.uploadWorkflowProjectItem(folderRelativePath, fileName, contents);
  }

  async readWorkflowProjectDownload(
    relativePath: string,
    version: WorkflowProjectDownloadVersion,
  ): Promise<{ contents: string; fileName: string }> {
    return this.#catalog.readWorkflowProjectDownload(relativePath, version);
  }

  async readWorkflowProjectReferenceSnapshots(relativePath: string) {
    return this.#catalog.readWorkflowProjectReferenceSnapshots(relativePath);
  }
  async listWorkflowProjectReferenceCatalog() {
    return this.#catalog.listWorkflowProjectReferenceCatalog();
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
    if (!this.#hostedEvaluationCoordinator) {
      throw new Error('Hosted Evaluation coordination is unavailable in migration mode.');
    }
    return this.#hostedEvaluationCoordinator;
  }

  async listWorkflowPublishedVersions(relativePath: string): Promise<WorkflowPublishedVersionsResponse> {
    return this.#publication.listWorkflowPublishedVersions(relativePath);
  }

  async readWorkflowPublishedVersionDownload(
    relativePath: string,
    versionId: string,
  ): Promise<{ contents: string; fileName: string }> {
    return this.#publication.readWorkflowPublishedVersionDownload(relativePath, versionId);
  }

  async readWorkflowPublishedVersionPreview(
    relativePath: string,
    versionId: string,
  ): Promise<{ contents: string; datasetsContents: string | null }> {
    return this.#publication.readWorkflowPublishedVersionPreview(relativePath, versionId);
  }

  async setWorkflowPublishedVersionStar(
    relativePath: string,
    versionId: string,
    isStarred: boolean,
  ): Promise<WorkflowPublishedVersionSummary> {
    return this.#publication.setWorkflowPublishedVersionStar(relativePath, versionId, isStarred);
  }

  async setWorkflowPublishedVersionComment(
    relativePath: string,
    versionId: string,
    comment: string,
  ): Promise<WorkflowPublishedVersionSummary> {
    return this.#publication.setWorkflowPublishedVersionComment(relativePath, versionId, comment);
  }

  async restoreWorkflowPublishedVersion(
    relativePath: string,
    versionId: string,
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<WorkflowPublishedVersionRestoreResponse> {
    return this.#publication.restoreWorkflowPublishedVersion(relativePath, versionId, preconditions);
  }

  async publishWorkflowProjectItem(
    relativePath: string,
    settings: WorkflowProjectSettingsDraft,
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.publishWorkflowProjectItem(relativePath, settings, preconditions);
  }

  async updateWorkflowEndpointAccess(
    relativePath: string,
    access: WorkflowEndpointAccess,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.updateWorkflowEndpointAccess(relativePath, access, preconditions);
  }

  async listWorkflowProjectWebApps(relativePath: string): Promise<WorkflowProjectWebAppsResponse> {
    return this.#publication.listWorkflowProjectWebApps(relativePath);
  }

  async publishWorkflowProjectWebApps(
    relativePath: string,
    publications: WorkflowProjectWebAppPublicationDraft[],
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.publishWorkflowProjectWebApps(relativePath, publications, preconditions);
  }

  async updateWorkflowProjectWebAppAccess(
    relativePath: string,
    accessUpdates: WorkflowProjectWebAppAccessDraft[],
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.updateWorkflowProjectWebAppAccess(relativePath, accessUpdates, preconditions);
  }

  async unpublishWorkflowProjectWebApp(
    relativePath: string,
    uiGraphId: string,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.unpublishWorkflowProjectWebApp(relativePath, uiGraphId, preconditions);
  }

  async unpublishWorkflowProjectItem(
    relativePath: string,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.unpublishWorkflowProjectItem(relativePath, preconditions);
  }

  async deleteWorkflowProjectItem(relativePath: string): Promise<string | null> {
    return this.#catalog.deleteWorkflowProjectItem(relativePath);
  }

  async loadPublishedExecutionProject(
    endpointName: string,
    requireFreshPointer = false,
  ): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadPublishedExecutionProject(endpointName, requireFreshPointer);
  }

  async loadLatestExecutionProject(
    endpointName: string,
    requireFreshPointer = false,
  ): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadLatestExecutionProject(endpointName, requireFreshPointer);
  }

  async loadPublishedWebAppExecutionProject(slug: string): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadPublishedWebAppExecutionProject(slug);
  }

  async loadLatestWebAppExecutionProject(slug: string): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadLatestWebAppExecutionProject(slug);
  }

  async resolveWebAppAccessPolicy(slug: string): Promise<ManagedWebAppAccessPolicy | null> {
    await this.initialize();
    return this.#executionService.resolveWebAppAccessPolicy(slug);
  }

  createProjectReferenceLoader() {
    return this.#executionService.createProjectReferenceLoader();
  }

  async loadSubgraphTarget(target: SubgraphProjectTarget): Promise<ResolvedSubgraphProject> {
    await this.initialize();
    return this.#executionService.loadSubgraphTarget(target);
  }

  async validateSubgraphTarget(target: SubgraphProjectTarget): Promise<void> {
    await this.initialize();
    await validateManagedSubgraphTarget(this.#context.pool, target);
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

  async listWorkflowRecordingRunsPage(query: WorkflowRecordingPageQuery): Promise<WorkflowRecordingRunsPageResponse> {
    const {
      workflowId,
      page,
      pageSize,
      statusFilter = 'all',
      inputFilter = null,
      inputCursor = 0,
      signal,
      inputAfter,
      includeSubgraphRuns = false,
      runScope = inputFilter ? 'roots' : 'all',
    } = query;
    return this.#recordings.listWorkflowRecordingRunsPage(
      workflowId,
      page,
      pageSize,
      statusFilter,
      inputFilter,
      inputCursor,
      signal,
      inputAfter,
      includeSubgraphRuns,
      runScope,
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

  async persistWorkflowExecutionRecording(
    options: PersistWorkflowExecutionRecordingOptions,
  ): Promise<string | undefined> {
    return this.#recordings.persistWorkflowExecutionRecording(options);
  }
}
